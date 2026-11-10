/**
 * 0002 —— submissions 主键改为身份域复合键（规范 §6.3/§11.1；蓝图 §2.3 迁移路径）。
 *
 * 背景：0001 中 submissions 以 `id TEXT PRIMARY KEY` 作全局主键，并把
 * §6.3 要求的 UNIQUE (project_id, submitter_id, id) 一并建上。全局主键使
 * 「同一 submission_id 字符串」事实上跨项目、跨提交者全局互斥，超出规范
 * 「同一身份域内（project_id + submitter_id）幂等」的语义（§11.1：不同
 * submitter 各有独立身份域）。本迁移以复合主键 (project_id, submitter_id, id)
 * 重建表，去掉多余的全局唯一性；原 UNIQUE 约束由主键等价承担。
 *
 * §6.3 迁移要求：先处理历史数据冲突再启用新约束——新主键严格弱于旧全局
 * 主键，历史数据不可能违反，无需清洗；行数据按列原样保留。
 */
export const version = 2;
export const description =
  "submissions 主键重建为 (project_id, submitter_id, id) 身份域复合键（§6.3/§11.1）";

export function up(db) {
  db.exec(`
    CREATE TABLE submissions_new (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      submitter_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      receipt TEXT NOT NULL DEFAULT '',
      commit_seq INTEGER,
      status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','rejected')),
      accepted_operations TEXT NOT NULL DEFAULT '[]',
      warnings TEXT NOT NULL DEFAULT '[]',
      result_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, submitter_id, id)
    );
    INSERT INTO submissions_new (id, project_id, submitter_id, request_digest, receipt,
      commit_seq, status, accepted_operations, warnings, result_hash, created_at)
      SELECT id, project_id, submitter_id, request_digest, receipt,
        commit_seq, status, accepted_operations, warnings, result_hash, created_at
      FROM submissions;
    DROP TABLE submissions;
    ALTER TABLE submissions_new RENAME TO submissions;
  `);
}
