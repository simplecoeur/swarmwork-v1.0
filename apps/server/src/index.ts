import { loadConfig } from './config';
import { Engine } from './engine/engine';
import { LlmGateway } from './llm/gateway';
import { Logger } from './logger';
import { openDb } from './store/db';
import { Repos } from './store/repositories';
import { ensurePlatform } from './store/bootstrap';
import { seedIfEmpty } from './store/seed';
import { buildApp } from './api/app';
import { processDueWebhookDeliveries } from './domain/webhookService';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logsDir);
  const db = openDb(config.dbPath);
  const repos = new Repos(db);
  await ensurePlatform(repos, config.dataDir, logger);
  seedIfEmpty(repos);
  const gateway = new LlmGateway(repos, logger);
  const engine = new Engine(repos, gateway, logger);
  const app = await buildApp({ repos, gateway, logger, dbPath: config.dbPath }, config.staticDir, logger);

  // 只监听本机回环（设计 §11）
  await app.listen({ port: config.port, host: '127.0.0.1' });
  engine.start();
  // G-07 Webhook 投递循环：独立 interval（与引擎 1s tick 分开，避免高频查表；
  // 节奏可用 SWARM_WEBHOOK_TICK_MS 覆盖，默认 5000ms），进程未运行时不投递（与常驻部署口径一致）
  const webhookTickMs = Number(process.env.SWARM_WEBHOOK_TICK_MS || 5000) || 5000;
  const webhookTimer = setInterval(() => {
    void processDueWebhookDeliveries(repos, logger).catch((e) => {
      logger.error('webhook', `投递循环异常：${e instanceof Error ? e.message : String(e)}`);
    });
  }, webhookTickMs);
  logger.info('server', `干活蜂群已启动：http://127.0.0.1:${config.port}（数据目录 ${config.dataDir}）`);

  const shutdown = () => {
    clearInterval(webhookTimer);
    engine.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`启动失败：${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exit(1);
});
