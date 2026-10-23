import * as fs from 'fs';
import * as path from 'path';

/**
 * 结构化 JSON 行日志（设计 §12）：ts/level/module/taskId/apiId/msg，
 * 控制台 + data/logs/app-YYYY-MM-DD.log 按天滚动。日志中禁止出现 Key 明文。
 */
export interface LogContext {
  taskId?: string;
  apiId?: string;
  [k: string]: unknown;
}

export class Logger {
  constructor(private readonly logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  private write(level: string, module: string, msg: string, ctx?: LogContext): void {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, module, ...(ctx ?? {}), msg });
    process.stdout.write(line + '\n');
    const file = path.join(this.logsDir, `app-${ts.slice(0, 10)}.log`);
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      /* 日志落盘失败不阻塞业务 */
    }
  }

  info(module: string, msg: string, ctx?: LogContext): void {
    this.write('info', module, msg, ctx);
  }
  warn(module: string, msg: string, ctx?: LogContext): void {
    this.write('warn', module, msg, ctx);
  }
  error(module: string, msg: string, ctx?: LogContext): void {
    this.write('error', module, msg, ctx);
  }
}
