/**
 * 0010 —— 分支摘要生命周期（01 号基线 §三、§十三；实施计划阶段 5）。
 *
 * 新增持久表：
 *   branch_summaries：按探索分支（goal / intent 分组 / 资产类型）记录语义摘要、
 *   引用及覆盖的提交边界。刷新开始时固定输入水位，发布时仅推进该水位。
 *   晚于水位的新增材料继续显示为待纳入摘要（§十三「刷新期间到来的新记录继续
 *   作为待汇总内容」）。
 *
 *   refresh_status 三值：current（已覆盖到 covered_commit_seq）、refreshing
 *   （正在刷新，refresh_input_seq 已固定）、stale（有新内容未纳入）。
 */
export const version = 10;
export const description =
  "分支摘要生命周期：branch_summaries（阶段 5）";

export function up(db) {
  db.exec(`
    CREATE TABLE branch_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      branch_id TEXT NOT NULL,
      branch_kind TEXT NOT NULL DEFAULT 'goal',
      semantic_summary TEXT NOT NULL DEFAULT '',
      summary_refs_json TEXT NOT NULL DEFAULT '[]',
      covered_commit_seq INTEGER NOT NULL DEFAULT 0,
      refresh_status TEXT NOT NULL DEFAULT 'stale'
        CHECK (refresh_status IN ('current', 'refreshing', 'stale')),
      refresh_input_seq INTEGER,
      judgement_snapshot_json TEXT NOT NULL DEFAULT '{}',
      sub_entries_json TEXT NOT NULL DEFAULT '[]',
      incremental_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_seq INTEGER NOT NULL,
      UNIQUE (project_id, branch_id)
    );
    CREATE INDEX idx_branch_summaries_project
      ON branch_summaries (project_id, refresh_status);
    CREATE INDEX idx_branch_summaries_branch
      ON branch_summaries (project_id, branch_id);
  `);
}
