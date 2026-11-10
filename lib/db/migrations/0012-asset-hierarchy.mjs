/**
 * 0012 —— 资产层级树（MemWalker 分层记忆 + PentestGPT 任务树）。
 *
 * 为 assets 表增加 parent_asset_id 字段，建立父子关系，
 * 并将去重键从项目级 (project_id, asset_type, canonicalization_version, canonical_key)
 * 改为同父级唯一
 * (project_id, parent_asset_id, asset_type, canonicalization_version, canonical_key)。
 * 规范化版本必须保留在身份中：不同版本可能表达不同等价规则，历史库也允许
 * 同 key 跨版本共存；去掉该维度会在迁移建索引时冲突并错误合并历史资产。
 *
 * 历史数据不迁移：已有资产 parent_asset_id = NULL（根节点）。
 */
export const version = 12;
export const description = "资产层级：parent_asset_id + 同父去重";
export const rebuildsReferencedTable = true;

export function up(db) {
  db.exec(`
    CREATE TABLE assets_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_asset_id TEXT,
      asset_type TEXT NOT NULL,
      canonicalization_version TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      original_input TEXT NOT NULL,
      scope_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (scope_status IN ('allowed','denied','pending')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );

    INSERT INTO assets_new
      (id, project_id, parent_asset_id, asset_type, canonicalization_version,
       canonical_key, original_input, scope_status, created_at, created_by, created_seq)
    SELECT
      id, project_id, NULL, asset_type, canonicalization_version,
      canonical_key, original_input, scope_status, created_at, created_by, created_seq
    FROM assets;

    DROP TABLE assets;
    ALTER TABLE assets_new RENAME TO assets;
    CREATE INDEX idx_assets_project_type ON assets (project_id, asset_type);

    CREATE UNIQUE INDEX idx_assets_parent_dedup
      ON assets (project_id, COALESCE(parent_asset_id, ''), asset_type,
                 canonicalization_version, canonical_key);
  `);

}
