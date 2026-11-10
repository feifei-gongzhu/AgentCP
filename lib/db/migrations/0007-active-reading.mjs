/**
 * 0007 —— 主动阅读与可达性（01 号设计基线 §二至§五、§十、§十三；实施计划阶段 2）。
 *
 * 新增持久表：
 *   1. reading_node_aliases：目录/分支调整或重命名时的稳定入口映射（旧入口 → 新入口），
 *      确保目录重组或技术栈视角调整后旧引用仍然可达（§二「目录可以调整，技术栈判断可以
 *      修正，已有引用仍然能够解析」）。
 *   2. reading_branch_overrides：分支节点元数据与父级挂载覆盖（支持浅层/深层目录调整与
 *      分支概览说明）。
 *   3. reading_bookmarks：按 (project_id, role, actor_id, attempt_id, bookmark_key) 隔离的
 *      持久阅读书签，保存当前阅读节点、查询/分页游标、过滤条件与导航路径，且与正在执行的
 *      意图（executing_intent_id）解耦（§四「阅读位置与执行位置分别维护」）。
 *   4. material_read_logs：工具调用实际返回给 Agent 的材料与证据范围日志（含字节偏移、
 *      字节长度、总字节数、行范围、内容哈希、所属意图与 Attempt），供阶段 4 区分「工具
 *      实际读取范围」与「Worker 声明的检查范围」（§十）。
 */
export const version = 7;
export const description =
  "主动阅读协议：节点别名映射、分支覆盖、隔离书签与材料读取范围日志（阶段 2）";

export function up(db) {
  db.exec(`
    CREATE TABLE reading_node_aliases (
      project_id TEXT NOT NULL REFERENCES projects(id),
      old_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, old_node_id)
    );
    CREATE INDEX idx_reading_node_aliases_target
      ON reading_node_aliases (project_id, target_node_id);

    CREATE TABLE reading_branch_overrides (
      project_id TEXT NOT NULL REFERENCES projects(id),
      node_id TEXT NOT NULL,
      parent_node_id TEXT,
      title TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reorganized', 'retracted')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, node_id)
    );
    CREATE INDEX idx_reading_branch_overrides_parent
      ON reading_branch_overrides (project_id, parent_node_id);

    CREATE TABLE reading_bookmarks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      role TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL DEFAULT '',
      executing_intent_id TEXT NOT NULL DEFAULT '',
      bookmark_key TEXT NOT NULL DEFAULT 'default',
      node_id TEXT NOT NULL,
      query_cursor TEXT NOT NULL DEFAULT '',
      filter_json TEXT NOT NULL DEFAULT '{}',
      breadcrumb_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_seq INTEGER NOT NULL,
      UNIQUE (project_id, role, actor_id, attempt_id, bookmark_key)
    );
    CREATE INDEX idx_reading_bookmarks_lookup
      ON reading_bookmarks (project_id, role, actor_id, attempt_id);

    CREATE TABLE material_read_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      role TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      intent_id TEXT,
      attempt_id TEXT,
      tool_name TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL DEFAULT '',
      blob_sha256 TEXT,
      byte_offset INTEGER,
      byte_length INTEGER,
      total_bytes INTEGER,
      locator_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_material_read_logs_project
      ON material_read_logs (project_id, created_seq, id);
    CREATE INDEX idx_material_read_logs_intent
      ON material_read_logs (project_id, intent_id, attempt_id);
    CREATE INDEX idx_material_read_logs_target
      ON material_read_logs (project_id, target_id);
  `);
}
