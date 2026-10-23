import * as fs from 'fs';
import * as path from 'path';

/** 定位 apps/server 包根（兼容 tsx 跑 src 与 node 跑 dist 两种形态） */
export function findServerRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@swarm/server') return dir;
      } catch {
        /* 继续向上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
}

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  logsDir: string;
  staticDir: string;
}

export function loadConfig(): AppConfig {
  const serverRoot = findServerRoot();
  const repoRoot = path.resolve(serverRoot, '..', '..');
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(repoRoot, 'data');
  return {
    port: parseInt(process.env.PORT || '8730', 10),
    dataDir,
    dbPath: path.join(dataDir, 'swarm.db'),
    logsDir: path.join(dataDir, 'logs'),
    staticDir: path.join(serverRoot, 'public'),
  };
}
