import { loadConfig } from './config';
import { Engine } from './engine/engine';
import { LlmGateway } from './llm/gateway';
import { Logger } from './logger';
import { openDb } from './store/db';
import { Repos } from './store/repositories';
import { seedIfEmpty } from './store/seed';
import { buildApp } from './api/app';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logsDir);
  const db = openDb(config.dbPath);
  const repos = new Repos(db);
  seedIfEmpty(repos);
  const gateway = new LlmGateway(repos, logger);
  const engine = new Engine(repos, gateway, logger);
  const app = await buildApp({ repos, gateway, logger, dbPath: config.dbPath }, config.staticDir, logger);

  // 只监听本机回环（设计 §11）
  await app.listen({ port: config.port, host: '127.0.0.1' });
  engine.start();
  logger.info('server', `干活蜂群已启动：http://127.0.0.1:${config.port}（数据目录 ${config.dataDir}）`);

  const shutdown = () => {
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
