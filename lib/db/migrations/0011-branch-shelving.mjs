/**
 * 0011 —— 分支搁置与唤醒条件（01 号基线 §十一、§十二、§十四、§十六；阶段 6）。
 *
 * 新增持久表：
 *   branch_shelving：记录分支搁置的原因、范围和重新考虑的条件。
 *   §十四「"暂时不继续某分支"必须关联原因和范围，区分证据不足、条件不具备、
 *   与当前问题无关、成本过高或具体假设被否定」。
 *   §十六「一个分支停止时，保存原因和重新考虑的条件。新证据、环境变化、目标调整
 *   或相关任务结果，都可能让它重新进入探索」。
 */
export const version = 11;
export const description =
  "分支搁置与唤醒条件：branch_shelving（阶段 6）";

export function up(db) {
  db.exec(`
    CREATE TABLE branch_shelving (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      branch_id TEXT NOT NULL,
      branch_kind TEXT NOT NULL DEFAULT 'intent',
      shelve_reason TEXT NOT NULL DEFAULT 'unknown'
        CHECK (shelve_reason IN ('insufficient_evidence', 'conditions_unmet',
          'unrelated', 'cost_too_high', 'hypothesis_falsified', 'blocked', 'unknown')),
      reason_detail TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      reconsider_conditions_json TEXT NOT NULL DEFAULT '[]',
      wake_on_event_types_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'shelved'
        CHECK (status IN ('shelved', 'reconsidering', 'resumed', 'closed')),
      shelved_at TEXT NOT NULL,
      resumed_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_branch_shelving_project
      ON branch_shelving (project_id, status);
    CREATE INDEX idx_branch_shelving_branch
      ON branch_shelving (project_id, branch_id);
  `);
}
