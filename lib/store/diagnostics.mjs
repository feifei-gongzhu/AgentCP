/**
 * M2 —— 系统诊断聚合（蓝图 §2.6-4 端点 #49；要求 §6「系统诊断」数据面）。
 *
 * 形状（冻结，供 M4 诊断页消费）：
 *   GET /sorne/diagnostics                     → 全局聚合
 *   GET /sorne/diagnostics?project_id=PRJ-xxxx → 单项目聚合
 *     { generated_at,
 *       llm: { configured, runtime: agents.describe() 原文 },
 *       health: <#3 同构响应体>,
 *       projects?: { active, waiting_for_change, paused, stopped },   // 全局面
 *       project?: {                                                   // 单项目面
 *         status, current_scope_revision,
 *         plan:       { plan_runs_pending, plan_runs_in_flight },
 *         intents:    { by_status, blocked_ids },
 *         attempts:   { active_leases, expired, unknown_tool_calls }, // unknown 置顶（纪律）
 *         verification:{ pending_jobs, oldest_wait_seconds },
 *         reports:    { unhandled_worker_reports },
 *         messages:   { pending_user, last_ai_reply_at },
 *         outbox:     { pending, oldest_pending_age_s, failed },
 *         projection: { <kind>: lag_commit_seq | null },   // null=未投影，不冒充 0
 *         evidence:   { staged_blobs, lost_blobs, integrity_anomalies } } }
 *
 * 纪律（沿 metrics.mjs 口径）：只读聚合、不写库不发事件；所有计数「库内可核对、
 * 带中文 note 口径说明」；数据时刻 generated_at 标注；null 表示未观测而非 0
 * （未提供 ≠ 不存在）；unknown 工具调用置顶并附「须先检查外部现状再决定重试，
 * 不得当作已完成或已失败」（规范 §10.2）。证据容量核对真实读盘
 * （findStorageAnomalies，A2 既有口径）。
 */
import { getStore } from "./record-service.mjs";
import { findStorageAnomalies } from "./evidence.mjs";
import { activeSessionCount } from "./sessions.mjs";
import { envConfig, readLlmSettings } from "./llm-settings.mjs";
import { countPendingUserMessages } from "./messages.mjs";
import { getLlmUsage } from "../agents/model.mjs";
import { readProviderHealth } from "./provider-health.mjs";

const SNAPSHOT_KINDS = Object.freeze(["asset_map", "exploration_map", "planner_view", "context", "report"]);

function ageSeconds(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
}

/** #3 同构健康块（health.routes.mjs 同口径；诊断面只读复算）。 */
function healthBlock(store) {
  const db = store.db;
  const rows = db
    .prepare("SELECT delivery_status AS s, COUNT(*) AS c FROM outbox GROUP BY delivery_status")
    .all();
  const outbox = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    if (r.s in outbox) outbox[r.s] = r.c;
    outbox.total += r.c;
  }
  return {
    ok: true,
    service: "sorne",
    checked_at: new Date().toISOString(),
    db: { ok: true, schema_version: store.schemaVersion },
    outbox,
    projects: db.prepare("SELECT COUNT(*) AS c FROM projects").get().c,
    sessions: { active: activeSessionCount() },
  };
}

async function projectDiagnostics(db, pctx, projectId, now) {
  const project = db.prepare("SELECT id, status, current_scope_revision FROM projects WHERE id = ?").get(projectId);
  if (!project) return null;
  const highWater = db.prepare("SELECT MAX(commit_seq) AS c FROM outbox WHERE project_id = ?").get(projectId).c || 0;

  const plan = {
    plan_runs_pending: db.prepare("SELECT COUNT(*) AS c FROM plan_runs WHERE project_id = ? AND status = 'pending'").get(projectId).c,
    plan_runs_in_flight: db.prepare("SELECT COUNT(*) AS c FROM plan_runs WHERE project_id = ? AND status = 'in_flight'").get(projectId).c,
  };

  const byStatus = {};
  for (const row of db.prepare("SELECT status AS s, COUNT(*) AS c FROM intents WHERE project_id = ? GROUP BY status").all(projectId)) {
    byStatus[row.s] = row.c;
  }
  const blockedIds = db
    .prepare("SELECT id FROM intents WHERE project_id = ? AND status IN ('blocked','awaiting_review','deferred') ORDER BY created_seq, id")
    .all(projectId)
    .map((r) => r.id);
  const intents = {
    by_status: byStatus,
    blocked_ids: blockedIds,
    note: "受阻族（blocked/awaiting_review/deferred）全列；恢复与重派由协调 AI 决定，程序不写死固定重试（规范 §3.1/§3.2）",
  };

  // 租约异常（§10.2：过期租约阻止旧执行继续，通知 Orchestrator 决定恢复/重派）
  const activeLeases = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')")
    .get(projectId).c;
  const expired = db
    .prepare(
      `SELECT id, intent_id, lease_expires_at FROM attempts
        WHERE project_id = ? AND status IN ('leased','running')
          AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .all(projectId, new Date(now).toISOString())
    .map((r) => ({ id: r.id, intent_id: r.intent_id, lease_expires_at: r.lease_expires_at }));
  // unknown 工具调用置顶（纪律：须先检查外部现状再决定重试，不得当作已完成或已失败）
  const unknownCalls = db
    .prepare(
      `SELECT id, attempt_id, tool_name, started_at, ended_at FROM tool_calls
        WHERE project_id = ? AND status = 'unknown' ORDER BY created_seq, id LIMIT 50`,
    )
    .all(projectId);
  const attempts = {
    active_leases: activeLeases,
    expired,
    unknown_tool_calls: unknownCalls,
    unknown_note: unknownCalls.length
      ? "存在 unknown 工具调用：须先检查外部现状再决定重试，不得当作已完成或已失败（规范 §10.2）"
      : null,
  };

  const pendingJobRow = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM verification_jobs
        WHERE project_id = ? AND status IN ('pending','in_progress')`,
    )
    .get(projectId);
  const verification = {
    pending_jobs: pendingJobRow.c,
    oldest_wait_seconds: pendingJobRow.oldest ? ageSeconds(pendingJobRow.oldest, now) : null,
    note: "验证队列等待时间是 §20.2 指标（数据时刻值）",
  };

  const reports = {
    unhandled_worker_reports: db
      .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'pending'")
      .get(projectId).c,
    note: "delivered ≠ handled：仅送入上下文不算已处理（§18.5.6）",
  };

  const messages = {
    pending_user: countPendingUserMessages(db, projectId),
    last_ai_reply_at:
      db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE project_id = ? AND direction = 'ai'").get(projectId).t || null,
    note: "pending_user 为 received/processing 的用户消息数；等待中的项目收到用户消息即唤醒（§2.6-2）",
  };

  const outboxRows = db
    .prepare(
      `SELECT delivery_status AS s, COUNT(*) AS c, MIN(created_at) AS oldest FROM outbox
        WHERE project_id = ? GROUP BY delivery_status`,
    )
    .all(projectId);
  const pendingRow = outboxRows.find((r) => r.s === "pending");
  const failedRow = outboxRows.find((r) => r.s === "failed");
  const outbox = {
    pending: pendingRow?.c ?? 0,
    oldest_pending_age_s: pendingRow?.oldest ? ageSeconds(pendingRow.oldest, now) : null,
    failed: failedRow?.c ?? 0,
    note: "Outbox 摘要（§20.2 积压与重试的库内口径；各消费者真实进度在 consumer_receipts）",
  };

  const projection = {};
  for (const kind of SNAPSHOT_KINDS) {
    const row = db
      .prepare("SELECT MAX(snapshot_commit_seq) AS s FROM snapshots WHERE project_id = ? AND kind = ?")
      .get(projectId, kind);
    projection[kind] = row && typeof row.s === "number" ? Math.max(0, highWater - row.s) : null; // null=未投影
  }

  const staged = db
    .prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ? AND storage_status = 'staged'")
    .get(projectId).c;
  const lost = db
    .prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ? AND storage_status = 'lost'")
    .get(projectId).c;
  let anomalies = null;
  try {
    const found = await findStorageAnomalies(pctx, { projectId });
    anomalies = found
      ? (found.orphan_files?.length ?? 0) + (found.missing_files?.length ?? 0) + (found.mismatched_files?.length ?? 0)
      : null;
  } catch {
    anomalies = null; // 磁盘核对不可用时不冒充 0（未提供 ≠ 不存在）
  }
  const evidence = {
    staged_blobs: staged,
    lost_blobs: lost,
    integrity_anomalies: anomalies,
    note: "integrity_anomalies 为真实读盘核对计数；null 表示本次未核对（不冒充 0）",
  };

  return {
    status: project.status,
    current_scope_revision: project.current_scope_revision ?? null,
    high_watermark: highWater,
    plan,
    intents,
    attempts,
    verification,
    reports,
    messages,
    outbox,
    projection,
    evidence,
  };
}

/** 诊断聚合主体（#49）。projectId 缺省 → 全局面；存在 → 单项目面（404 不泄露）。 */
export async function buildDiagnostics(pctx, { projectId } = {}) {
  const store = await getStore(pctx);
  const now = Date.now();
  const db = store.db;

  const llmStore = readLlmSettings(pctx.dataDir);
  // readLlmSettings 返回 { config, source }：配置在 config 内（历史写法误读 llmStore.model，
  // 导致 store 已配置但诊断恒报 configured=false，J1 门控误判「尚未连接模型」）。
  const storedCfg = llmStore && llmStore.config ? llmStore.config : null;
  const configured = Boolean(storedCfg && storedCfg.baseUrl && storedCfg.model) || Boolean(envConfig());
  const runtime = pctx.agents && typeof pctx.agents.describe === "function" ? pctx.agents.describe() : "agents:not-configured";
  const providerKey = pctx.agents && typeof pctx.agents.providerKey === "function"
    ? pctx.agents.providerKey()
    : runtime.replace(/^agents:/, "");
  // provider_health：真实连通性（最近一次 API 调用成败），区别于 configured（仅配了没）。
  const health = configured ? await readProviderHealth(pctx, providerKey) : { reachable: false, known: false, last_error_kind: null, next_retry_at: null, needs_user: false };

  const base = {
    generated_at: new Date(now).toISOString(),
    llm: {
      configured,
      runtime,
      reachable: configured ? health.reachable : false,
      health_known: Boolean(health.known),
      last_error_kind: health.last_error_kind || null,
      next_retry_at: health.next_retry_at || null,
      needs_user: Boolean(health.needs_user),
      last_success_at: health.last_success_at || null,
      last_error_at: health.last_error_at || null,
      usage: getLlmUsage(), // 进程内累计：calls / prompt_tokens / completion_tokens（成本巡检）
      note: "configured=配了没（本地 llm.json）；reachable=true/false/null 分别表示最近真实调用成功/失败/尚未验证（provider_health 持久记录）；configured=false 时绝不以「服务正常」暗示 AI 可工作（要求 §1）；usage 为进程内累计 token（重启清零）",
    },
    health: healthBlock(store),
  };

  if (projectId) {
    const project = await projectDiagnostics(db, pctx, projectId, now);
    if (!project) {
      const apiErrorMod = await import("../errors.mjs");
      throw apiErrorMod.apiError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    return { ...base, project };
  }

  const groups = { active: 0, waiting_for_change: 0, paused: 0, stopped: 0 };
  for (const row of db.prepare("SELECT status AS s, COUNT(*) AS c FROM projects GROUP BY status").all()) {
    if (row.s in groups) groups[row.s] = row.c;
  }
  return { ...base, projects: groups };
}
