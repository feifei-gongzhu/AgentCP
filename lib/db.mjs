/**
 * 存储底座（冻结契约，见 docs/BLUEPRINT.md §2.3）。
 *
 * - 数据库：node:sqlite DatabaseSync（Node >= 22.5；规范 §5.1 建议 SQLite 首版基线）。
 * - 所有变更必须经过受控写入服务（runSerial）串行执行短事务；事务体必须同步，
 *   不得在 BEGIN 与 COMMIT 之间 await（规范 §5.1：不能让 agent 直连数据库）。
 * - 迁移：lib/db/migrations/NNNN-*.mjs 导出 {version, description, up(db)}；
 *   以 schema_version 表记录已应用版本（规范 §6.3：迁移必须有 schema_version）。
 * - WAL + foreign_keys=ON + busy_timeout，写锁不得当作业务权限使用（§5.1）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("./db/migrations", import.meta.url));

export async function listMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}-.*\.mjs$/.test(f))
    .sort();
  const migrations = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
    if (typeof mod.version !== "number" || typeof mod.up !== "function") {
      throw new Error(`非法迁移文件（缺 version/up）：${file}`);
    }
    migrations.push({ file, version: mod.version, description: mod.description || "", up: mod.up, rebuildsReferencedTable: mod.rebuildsReferencedTable === true });
  }
  return migrations;
}

function currentVersion(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  return row && typeof row.v === "number" ? row.v : 0;
}

/* 同文件并发打开的进程内单飞：两个 openDatabase 同时打开同一个新库文件时，
   迁移只在首个句柄内执行一次（跨进程由 BEGIN IMMEDIATE + 事务内版本复查兜底）。 */
const openingHandles = new Map();

/** 打开（或创建）项目数据库并应用到最新 schema。返回受控句柄。 */
export async function openDatabase({ file }) {
  const key = resolve(file);
  const inFlight = openingHandles.get(key);
  if (inFlight) return inFlight;
  const handle = openDatabaseUncached(file).finally(() => openingHandles.delete(key));
  openingHandles.set(key, handle);
  return handle;
}

async function openDatabaseUncached(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");

  let queue = Promise.resolve();
  const runSerial = (fn, { rebuildsReferencedTable = false } = {}) => {
    const job = queue.then(() => {
      if (rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.exec("BEGIN IMMEDIATE");
        const out = fn(db);
        db.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* 连接异常时回滚失败由关闭流程兜底 */
        }
        throw error;
      } finally {
        if (rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = ON");
      }
    });
    queue = job.catch(() => {});
    return job;
  };

  const migrate = async () => {
    currentVersion(db); // 确保 schema_version 表存在（幂等）
    const migrations = await listMigrations();
    for (const m of migrations) {
      await runSerial((tx) => {
        // 事务内复查已应用版本：并发/跨进程打开同一新库时不重复建表。
        const row = tx.prepare("SELECT MAX(version) AS v FROM schema_version").get();
        const have = row && typeof row.v === "number" ? row.v : 0;
        if (m.version <= have) return;
        m.up(tx);
        if (m.rebuildsReferencedTable && tx.prepare("PRAGMA foreign_key_check").get()) {
          throw new Error(`迁移 ${m.file} 后外键核对失败`);
        }
        tx
          .prepare("INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.description, new Date().toISOString());
      }, { rebuildsReferencedTable: m.rebuildsReferencedTable });
    }
    return currentVersion(db);
  };

  const version = await migrate();
  return {
    db,
    path: file,
    schemaVersion: version,
    /** 受控写入服务：串行短事务。事务体 fn(db) 必须同步。 */
    runSerial,
    migrate,
    close() {
      db.close();
    },
  };
}
