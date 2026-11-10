/**
 * 0013 —— 模型提供方健康记录（执行态对账：模型崩溃可见 + 可恢复）。
 *
 * 持久化每个 provider 的最近成败、连续失败次数、下次允许重试时间，
 * 让控制器据此退避、让界面显示真实连通性（而非仅「配了没」）。
 * 原 configured 只读本地 llm.json，从不反映 API 是否连得上（§一 诚实呈现）。
 */
export const version = 13;
export const description = "provider_health：模型健康持久记录";

export function up(db) {
  db.exec(`
    CREATE TABLE provider_health (
      id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL UNIQUE,
      last_success_at TEXT,
      last_error_at TEXT,
      last_error_kind TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}
