/**
 * 0008 —— 工具产物批量持久化（01 号基线 §八、§九、§十五；实施计划阶段 3）。
 *
 * 新增持久表：
 *   1. extraction_batches：批次信封——绑定不可变输入（Blob+Capture）、提取器版本、
 *      原始输入哈希、运行 ID、意图和 Attempt。批次编号按项目稳定分配。
 *      同一幂等键（project_id, idempotency_key）不重复创建；同键不同内容报冲突。
 *   2. extraction_items：批次内条目——每项独立编号、可单独引用；记录出处
 *      （source_locator：行/偏移/选择器等）、分类（category）、候选数据。
 *      条目、来源关系和变更事件在同一事务提交（§十五）。
 *
 * 批次状态：committed（正常完成）/ partial（中断后已提交部分保留）/ failed（事务前失败）。
 * §八「中途失败时，已提交部分保留，整次工作标明未完成」。
 */
export const version = 8;
export const description =
  "工具产物批量持久化：extraction_batches + extraction_items（阶段 3）";

export function up(db) {
  db.exec(`
    CREATE TABLE extraction_batches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      idempotency_key TEXT NOT NULL,
      capture_id TEXT REFERENCES captures(id),
      blob_id TEXT REFERENCES blobs(id),
      input_sha256 TEXT NOT NULL,
      extractor_name TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      intent_id TEXT,
      attempt_id TEXT,
      run_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'committed'
        CHECK (status IN ('committed', 'partial', 'failed')),
      item_count INTEGER NOT NULL DEFAULT 0,
      category_counts_json TEXT NOT NULL DEFAULT '{}',
      error_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      UNIQUE (project_id, idempotency_key)
    );
    CREATE INDEX idx_extraction_batches_project
      ON extraction_batches (project_id, created_seq);
    CREATE INDEX idx_extraction_batches_attempt
      ON extraction_batches (project_id, attempt_id);
    CREATE INDEX idx_extraction_batches_input
      ON extraction_batches (project_id, input_sha256);

    CREATE TABLE extraction_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      batch_id TEXT NOT NULL REFERENCES extraction_batches(id),
      item_index INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      source_locator_json TEXT NOT NULL DEFAULT '{}',
      confidence TEXT NOT NULL DEFAULT 'candidate',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      UNIQUE (batch_id, item_index)
    );
    CREATE INDEX idx_extraction_items_batch
      ON extraction_items (batch_id, item_index);
    CREATE INDEX idx_extraction_items_project_cat
      ON extraction_items (project_id, category, created_seq);
  `);
}
