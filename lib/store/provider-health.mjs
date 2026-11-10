/**
 * 模型提供方健康记录（执行态对账：模型崩溃可见 + 可恢复）。
 *
 * 全局单库（state/sorne.sqlite）内 provider_health 表按 provider_key 记录最近成败、
 * 连续失败与下次可重试时间。控制器据此退避、界面据此显示真实连通性。
 * 认证/配置错误不退避重试（重试无用），标记需用户处理。
 */
import { getStore } from "./record-service.mjs";

const BACKOFF_BASE_MS = 20_000; // 与 model.mjs httpProvider 同款基数
const BACKOFF_MAX_MS = 5 * 60_000;
const NO_RETRY_KINDS = new Set(["auth_error", "config_error"]);

export async function recordProviderSuccess(pctx, providerKey) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_health (id, provider_key, last_success_at, consecutive_failures, next_retry_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, ?)
       ON CONFLICT(provider_key) DO UPDATE SET
         last_success_at = excluded.last_success_at,
         last_error_kind = NULL,
         consecutive_failures = 0,
         next_retry_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(`PH-${providerKey}`, providerKey, now, now);
  });
}

/**
 * 配置被显式刷新后，允许同一个 provider key 再做一次真实探测。
 *
 * API key 变化不会改变 provider.describe()（通常只有 baseUrl/model），若保留
 * auth_error 的永久阻断，用户修好凭据后控制器仍永远不会再调用模型。这里不把
 * “刚改配置”冒充成成功：同时清掉 last_success_at，使诊断回到“尚未验证”。
 */
export async function resetProviderForRetry(pctx, providerKey) {
  if (!providerKey) return;
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    db.prepare(
      `UPDATE provider_health
       SET last_success_at = NULL, last_error_kind = NULL, consecutive_failures = 0,
           next_retry_at = NULL, updated_at = ?
       WHERE provider_key = ?`,
    ).run(new Date().toISOString(), providerKey);
  });
}

export async function recordProviderFailure(pctx, providerKey, errorKind) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const prev = db.prepare("SELECT consecutive_failures FROM provider_health WHERE provider_key = ?").get(providerKey);
    const failures = (prev ? prev.consecutive_failures : 0) + 1;
    // 认证/配置错误：重试无用，不设退避窗（等用户改配置），但记录故障供界面显示。
    const nextRetryAt = NO_RETRY_KINDS.has(errorKind)
      ? null
      : new Date(now + Math.min(BACKOFF_BASE_MS * failures, BACKOFF_MAX_MS)).toISOString();
    db.prepare(
      `INSERT INTO provider_health (id, provider_key, last_error_at, last_error_kind, consecutive_failures, next_retry_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_key) DO UPDATE SET
         last_error_at = excluded.last_error_at,
         last_error_kind = excluded.last_error_kind,
         consecutive_failures = excluded.consecutive_failures,
         next_retry_at = excluded.next_retry_at,
         updated_at = excluded.updated_at`,
    ).run(`PH-${providerKey}`, providerKey, nowIso, errorKind || "unknown", failures, nextRetryAt, nowIso);
    return { consecutive_failures: failures, next_retry_at: nextRetryAt, needs_user: NO_RETRY_KINDS.has(errorKind) };
  });
}

/** 该 provider 当前是否在退避窗内（控制器调模型前检查；全角色共享冷却）。 */
export async function providerInBackoff(pctx, providerKey) {
  const store = await getStore(pctx);
  const row = store.db.prepare("SELECT next_retry_at, last_error_kind FROM provider_health WHERE provider_key = ?").get(providerKey);
  if (!row) return { in_backoff: false };
  if (NO_RETRY_KINDS.has(row.last_error_kind)) return { in_backoff: true, needs_user: true, until: null };
  if (!row.next_retry_at) return { in_backoff: false };
  const until = Date.parse(row.next_retry_at);
  return { in_backoff: Number.isFinite(until) && until > Date.now(), until: row.next_retry_at };
}

/** 读某 provider 的健康快照（诊断/界面用；无记录或配置刚刷新均为未知）。 */
export async function readProviderHealth(pctx, providerKey) {
  const store = await getStore(pctx);
  const row = store.db.prepare("SELECT * FROM provider_health WHERE provider_key = ?").get(providerKey);
  if (!row) return { reachable: null, last_error_kind: null, next_retry_at: null, consecutive_failures: 0, known: false };
  const needsUser = NO_RETRY_KINDS.has(row.last_error_kind);
  const hasCurrentFailure = Boolean(row.last_error_kind);
  return {
    // 退避时间到期只表示“可以再试”，不等于已经恢复；必须由一次真实成功改成 true。
    reachable: hasCurrentFailure ? false : row.last_success_at ? true : null,
    last_success_at: row.last_success_at,
    last_error_at: row.last_error_at,
    last_error_kind: row.last_error_kind,
    consecutive_failures: row.consecutive_failures,
    next_retry_at: row.next_retry_at,
    needs_user: needsUser,
    known: hasCurrentFailure || Boolean(row.last_success_at),
  };
}
