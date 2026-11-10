/**
 * 0014 —— 意图执行重试预算。
 *
 * retry_count 是已记录的可重试失败次数；retry_limit 是允许的自动重派次数。
 * 默认允许 3 次重新派发，第 4 次 retryable 失败时确定性
 * block + branch_shelving，避免不可达目标无限消耗模型与工具资源。
 */
export const version = 14;
export const description = "意图执行有界重试：retry_count / retry_limit";

export function up(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_assets_parent_dedup;
    CREATE UNIQUE INDEX idx_assets_parent_dedup
      ON assets (project_id, COALESCE(parent_asset_id, ''), asset_type,
                 canonicalization_version, canonical_key);
    CREATE INDEX IF NOT EXISTS idx_assets_project_type ON assets (project_id, asset_type);

    ALTER TABLE intents ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0
      CHECK (retry_count >= 0);
    ALTER TABLE intents ADD COLUMN retry_limit INTEGER NOT NULL DEFAULT 3
      CHECK (retry_limit >= 0);
  `);
}
