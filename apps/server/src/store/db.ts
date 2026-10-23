import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 打开 SQLite 并按编号顺序执行未应用的迁移脚本（设计 §5）。
 * 迁移文件位于 src/store/migrations（dev/tsx）或 dist/store/migrations（构建产物，build 时拷贝）。
 */
export function openDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

function migrationsDir(): string {
  const candidates = [
    path.join(__dirname, 'migrations'),
    path.join(__dirname, '..', 'src', 'store', 'migrations'),
    path.join(process.cwd(), 'apps', 'server', 'src', 'store', 'migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到 migrations 目录');
}

export function runMigrations(db: DatabaseSync): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const done: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      done.push(version);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return done;
}
