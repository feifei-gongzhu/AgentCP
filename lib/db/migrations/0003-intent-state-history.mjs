/**
 * 0003 —— 意图状态历史表（规范 §10.1「状态变化留历史」；蓝图 §3 C1 施工要点「状态机+历史」）。
 *
 * 背景：0001 冻结 DDL 的 intents 表只有当前状态（status/state_version），没有任何
 * 表能承载 §10.1 要求的「状态变化留历史」（历史=可枚举的过往状态序列，非版本号）。
 * 蓝图 §2.3 迁移路径允许编号顺延新增迁移；本迁移只新增表，不改动任何既有表、
 * 不引入对历史数据的新约束（无历史行，不可能冲突，无需清洗）。
 *
 * 历史行由 C1 的状态机唯一写入（lib/store/intents.mjs）：每次状态变化一行，
 * 记录 from/to、动作、原因、来源（计划接收/完成建议/显式转换）与提交序号。
 */
export const version = 3;
export const description = "intent_state_history：意图状态变化历史（§10.1 状态变化留历史）";

export function up(db) {
  db.exec(`
    CREATE TABLE intent_state_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      intent_id TEXT NOT NULL REFERENCES intents(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      via TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL,
      commit_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_intent_state_history_intent
      ON intent_state_history (project_id, intent_id, commit_seq);
  `);
}
