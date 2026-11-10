/**
 * F2 —— 上下文压缩、检查点与重启恢复（规范 §18.1 §18.2 §1 §16.4）。
 *
 * ## Checkpoint（§18.1 接手快照）
 * 快照是派生资料：每次生成均从当前结构化记录实时重建（意图/尝试/判断/验证/
 * 工具调用/事件边界逐项核对），绝不从上一份摘要继续压缩；关键结论一律带编号
 * 引用（refs），多轮摘要不构成新的原始事实（§2 约束 12/§18.1）。
 * 内容按 §18.1 至少保存：意图与 Attempt、目标和范围版本、当前问题、关键依据
 * ID、确认与未确认内容、已尝试条件、失败或受阻原因、待验证问题、下一步建议、
 * 已处理事件边界、未完成工具调用。
 * 快照不产生业务提交、不消耗项目 commit_seq（B1 快照先例），不发 Outbox 事件
 * （蓝图 §6 目录无 checkpoint 类型）。
 *
 * ## 恢复顺序（§18.2 七步）
 *  1. 恢复数据库，检查已引用证据的可访问性和待固定上传；
 *  2. 恢复未处理 Outbox 和各消费者游标；
 *  3. 处理过期租约，标记中断 Attempt（经 C2 sweepExecutionState 真实事务）；
 *  4. 检查未完成工具调用，无法确定结果的标记 unknown（sweep 内 running→unknown；
 *     本步另枚举残余清单）；
 *  5. 重新检查范围、必要前提和资源（报告清单；逐次校验在派发与动作前执行，§9.2）；
 *  6. 读取最近 Checkpoint，再补充边界之后的变化（演练时无 Checkpoint 则先生成）；
 *  7. 创建新 Attempt 或恢复允许恢复的工作，保留旧执行历史——程序侧产出「可恢复
 *     工作清单」，不自动派发（§3.2：执行分配由 AI 决定，程序执行与保障）。
 * 不依赖模型记忆判断「刚才做没做过」：一切以持久记录为准；已保存的漏洞和线索
 * 即使尚未被 planner 消费，也经事件（Outbox）恢复继续处理（步骤 2/6）。
 *
 * ## 运行/等待分离（§1/§16.4）
 * 没有可执行工作时进入等待条件变化的状态（waiting_for_change），等待不空转：
 * 程序按可核对口径评估（活跃执行/可派发意图/待验证任务/未处理汇报/规划在途），
 * 条件未变化时不重复派发、不产生新任务；条件变化（唤醒信号：等待边界后出现的
 * 新意图/汇报/验证/范围/资产事件）时恢复 active。状态转换一律经 A1
 * updateProjectLifecycle（事件与版本随 A1 语义），本模块只做判定。
 * 「没有新方向」的探索判断属 Planner/Orchestrator，程序不代答（§3.2）。
 *
 * ## 演练（drill，蓝图 F2 要点：场景 12/24 重启故障注入）
 * 测试经真实「关库关服→同目录重启→重签会话」注入进程退出（不 mock）；本模块
 * 的 runRecovery 承担重启后的七步核对；演练报告留痕于 work/recovery/drills/。
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getStore, updateProjectLifecycle } from "./record-service.mjs";
import { findStorageAnomalies } from "./evidence.mjs";
import { evidenceDirs } from "./layout.mjs";
import { sweepExecutionState } from "./attempts.mjs";
import { drillReportPath } from "./metrics.mjs";

const QUIET_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };
const pctxOf = (pctx) => ({ logger: pctx?.logger || QUIET_LOGGER, dataDir: pctx.dataDir, pluginDir: pctx.pluginDir, version: pctx.version });

const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback;
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

/* ── 编号与边界（id_sequences 事务内分配；§6.1） ──────────────────── */

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT (project_id, kind) DO UPDATE SET next_val = next_val + 1",
  ).run(projectId, kind);
  return db.prepare("SELECT next_val - 1 AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind).n;
}

function eventHighWatermark(db, projectId) {
  return db.prepare("SELECT IFNULL(MAX(commit_seq), 0) AS h FROM outbox WHERE project_id = ?").get(projectId).h;
}

/* ── Checkpoint（§18.1）：从当前结构化记录实时重建 ────────────────── */

/**
 * 生成接手快照（§18.1 十一项内容 + refs 编号引用）。
 * 快照覆盖整个项目的接手要点；intentId/attemptId 给定时聚焦该执行线。
 */
export async function createCheckpoint(pctx, { projectId, intentId, attemptId, actor, note }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw Object.assign(new Error(`项目不存在：${projectId}`), { code: "NOT_FOUND" });
    }
    const now = new Date().toISOString();
    const boundary = eventHighWatermark(db, projectId);

    let intent = null;
    if (intentId) {
      const row = db.prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?").get(projectId, intentId);
      if (!row) {
        throw Object.assign(new Error(`意图不存在：${intentId}`), { code: "INVALID_REFERENCE" });
      }
      intent = row;
    }
    const focusIntentId = intent ? intent.id : null;

    let attempt = null;
    if (attemptId) {
      attempt = db.prepare("SELECT * FROM attempts WHERE project_id = ? AND id = ?").get(projectId, attemptId);
      if (!attempt) {
        throw Object.assign(new Error(`Attempt 不存在：${attemptId}`), { code: "INVALID_REFERENCE" });
      }
      if (!intent) {
        intent = db.prepare("SELECT * FROM intents WHERE id = ?").get(attempt.intent_id);
      }
    }

    // 关键依据 ID：意图 basis_refs + 关联观察（supports/derived_from 端点，§18.1「关键依据 ID」）
    const basisRefs = intent ? parseJson(intent.basis_refs, []) : [];
    const supportingObservations = focusIntentId
      ? db
          .prepare(
            `SELECT DISTINCT from_id FROM relations
              WHERE project_id = ? AND to_id = ? AND relation_type IN ('supports','contradicts')
                AND retracted_at IS NULL`,
          )
          .all(projectId, focusIntentId)
          .map((r) => r.from_id)
      : db
          .prepare(
            `SELECT id FROM observations WHERE project_id = ? ORDER BY created_seq DESC LIMIT 10`,
          )
          .all(projectId)
          .map((r) => r.id);

    // 确认与未确认内容（状态从库读取，快照不改写；§18.4 事实状态以库为准）
    const confirmed = db
      .prepare(`SELECT id, status, review, confirmed_version FROM vulnerabilities WHERE project_id = ? AND status = 'confirmed' ORDER BY created_seq`)
      .all(projectId)
      .map((r) => ({ record_id: r.id, status: r.status, review: r.review, confirmed_version: parseJson(r.confirmed_version, null), note: "confirmed 只说明在指定条件下得到确认，不代表持续存在（§8.2）" }));
    const unconfirmed = [
      ...db
        .prepare(`SELECT id, status, review FROM vulnerabilities WHERE project_id = ? AND status IN ('suspected','inconclusive') ORDER BY created_seq`)
        .all(projectId)
        .map((r) => ({ record_id: r.id, kind: "vulnerability", status: r.status, review: r.review })),
      ...db
        .prepare(`SELECT id, status FROM hypotheses WHERE project_id = ? AND status IN ('open','testing','inconclusive') ORDER BY created_seq`)
        .all(projectId)
        .map((r) => ({ record_id: r.id, kind: "hypothesis", status: r.status })),
    ];

    // 已尝试条件：该意图全部 Attempt（含失败/中断，历史保留）与其工具名集合
    const attemptsOfIntent = focusIntentId
      ? db.prepare(`SELECT * FROM attempts WHERE project_id = ? AND intent_id = ? ORDER BY created_seq`).all(projectId, focusIntentId)
      : db.prepare(`SELECT * FROM attempts WHERE project_id = ? ORDER BY created_seq DESC LIMIT 10`).all(projectId);
    const attemptedConditions = attemptsOfIntent.map((a) => {
      const tools = db
        .prepare(`SELECT DISTINCT tool_name FROM tool_calls WHERE project_id = ? AND attempt_id = ?`)
        .all(projectId, a.id)
        .map((t) => t.tool_name);
      return { attempt_id: a.id, status: a.status, worker_id: a.worker_id, tools, recovery_note: parseJson(a.recovery_note, null) };
    });

    // 失败或受阻原因（多来源，带编号）
    const failureReasons = {
      interrupted_attempts: attemptsOfIntent
        .filter((a) => a.status === "interrupted" || a.status === "failed")
        .map((a) => ({ attempt_id: a.id, status: a.status, recovery_note: parseJson(a.recovery_note, null) })),
      blocked_intents: db
        .prepare(`SELECT id, resume_conditions FROM intents WHERE project_id = ? AND status IN ('blocked','deferred')`)
        .all(projectId)
        .map((r) => ({ intent_id: r.id, resume_conditions: parseJson(r.resume_conditions, []) })),
      failed_tool_calls: db
        .prepare(`SELECT id, tool_name, error FROM tool_calls WHERE project_id = ? AND status = 'failed' ORDER BY updated_seq DESC LIMIT 20`)
        .all(projectId)
        .map((t) => ({ tool_call_id: t.id, tool_name: t.tool_name, error: t.error })),
    };

    // 待验证问题（带编号引用）
    const pendingVerification = db
      .prepare(`SELECT id, subject_id, status FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress') ORDER BY created_seq`)
      .all(projectId)
      .map((j) => ({ job_id: j.id, subject_id: j.subject_id, status: j.status }));

    // 下一步建议：程序只汇集持久来源（意图恢复条件 + 最新汇报的建议），不生成探索建议（§3.2）
    const latestReport = db
      .prepare(`SELECT * FROM worker_reports WHERE project_id = ? ORDER BY created_seq DESC LIMIT 1`)
      .get(projectId);
    const reportProposals = latestReport
      ? parseJson(latestReport.content, {}).proposed_next_actions ?? []
      : [];

    // 未完成工具调用（planned/running/unknown；unknown 必须先检查现状再决定重试 §10.2）
    const unfinishedToolCalls = db
      .prepare(
        `SELECT id, attempt_id, tool_name, status FROM tool_calls
          WHERE project_id = ? AND status IN ('planned','running','unknown') ORDER BY created_seq`,
      )
      .all(projectId)
      .map((t) => ({
        tool_call_id: t.id,
        attempt_id: t.attempt_id,
        tool_name: t.tool_name,
        status: t.status,
        note: t.status === "unknown" ? "结果未知：先检查现状再决定重试，不视作恰好一次（§10.2）" : null,
      }));

    const refs = [
      ...new Set(
        [
          focusIntentId,
          attempt ? attempt.id : null,
          ...basisRefs,
          ...supportingObservations,
          ...confirmed.map((c) => c.record_id),
          ...unconfirmed.map((u) => u.record_id),
          ...attemptsOfIntent.map((a) => a.id),
          ...pendingVerification.map((j) => j.job_id),
          ...unfinishedToolCalls.map((t) => t.tool_call_id),
        ].filter(Boolean),
      ),
    ];

    const content = {
      derived: true,
      derivation_note: "接手快照为派生资料：按生成时刻的结构化记录实时重建，关键结论以编号引用持久记录；本快照不构成新的原始事实（§18.1/§2 约束 12）",
      generator_note: note || "",
      intent: intent
        ? {
            id: intent.id,
            question: intent.question,
            kind: intent.kind,
            status: intent.status,
            plan_revision: intent.plan_revision,
            priority: intent.priority,
            resume_conditions: parseJson(intent.resume_conditions, []),
          }
        : null,
      attempt: attempt
        ? { id: attempt.id, status: attempt.status, worker_id: attempt.worker_id, lease_expires_at: attempt.lease_expires_at }
        : null,
      goal_and_scope: {
        project_id: projectId,
        project_status: project.status,
        current_scope_revision: project.current_scope_revision,
        target_asset_ids: intent ? parseJson(intent.target_asset_ids, []) : [],
      },
      current_question: intent ? intent.question : null,
      key_evidence_ids: { basis_refs: basisRefs, related_observations: supportingObservations },
      confirmed_content: confirmed,
      unconfirmed_content: unconfirmed,
      attempted_conditions: attemptedConditions,
      failure_or_block_reasons: failureReasons,
      pending_verification: pendingVerification,
      next_step_suggestions: {
        resume_conditions: intent ? parseJson(intent.resume_conditions, []) : [],
        latest_report_proposed_actions: reportProposals,
        note: "建议均引用持久来源（意图恢复条件与 worker 汇报）；探索方向的决定归 Planner/Orchestrator（§3.2）",
      },
      processed_boundary: boundary,
      processed_boundary_note: "已处理事件边界=生成时刻的事件高水位（commit_seq）；边界之后的变化经变化页（#16）补读，不依赖模型记忆（§18.2 步骤 6）",
      unfinished_tool_calls: unfinishedToolCalls,
      refs,
    };

    const id = `CP-${projectId}-${String(allocateSeq(db, projectId, "checkpoint")).padStart(4, "0")}`;
    db.prepare(
      `INSERT INTO checkpoints (id, project_id, intent_id, attempt_id, content, processed_boundary, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, focusIntentId, attempt ? attempt.id : null, JSON.stringify(content), String(boundary), now, actor, boundary);

    return { checkpoint_id: id, project_id: projectId, processed_boundary: boundary, created_at: now, content };
  });
}

/** 最近一份接手快照（§18.2 步骤 6 读取项）；无则 null。 */
export async function latestCheckpoint(pctx, { projectId }) {
  const store = await getStore(pctx);
  const row = store.db
    .prepare("SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(projectId);
  if (!row) return null;
  return {
    checkpoint_id: row.id,
    project_id: row.project_id,
    intent_id: row.intent_id,
    attempt_id: row.attempt_id,
    processed_boundary: row.processed_boundary,
    created_at: row.created_at,
    created_by: row.created_by,
    content: parseJson(row.content, {}),
  };
}

/* ── 运行/等待分离（§1/§16.4）：程序可核对的等待判定 ───────────────── */

/**
 * 评估项目等待状态（只读；不代答「接下来探索什么」）。
 * has_pending_work 的可核对口径（任一为真即有可执行工作）：
 *   活跃执行 / 可派发意图 / 待验证任务 / 未处理 worker 汇报（不含 C2 进展行）
 *   / 规划在途。
 * wake_signals：项目处于 waiting_for_change 时，等待边界（最后一次进入等待的
 * lifecycle 事件 commit_seq）之后出现的事件类型——程序检测明确条件并发送通知
 * （§16.1），条件的语义与后续动作由 AI 决定。
 */
export async function assessWaiting(pctx, { projectId }) {
  const store = await getStore(pctx);
  const db = store.db;
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    throw Object.assign(new Error(`项目不存在：${projectId}`), { code: "NOT_FOUND" });
  }

  const activeAttempts = db
    .prepare(`SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')`)
    .get(projectId).c;
  const dispatchableIntents = db
    .prepare(`SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status IN ('proposed','queued')`)
    .get(projectId).c;
  const pendingJobs = db
    .prepare(`SELECT COUNT(*) AS c FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress')`)
    .get(projectId).c;
  // 未处理汇报：E2 分层汇报（handling_status=pending）；C2 进展行（content.source=attempt_progress）
  // 的协调语义由其所属汇报/面板链路承载，不计入等待判定（E2 竣工偏差 7 同源口径）。
  const unhandledReports = db
    .prepare(
      `SELECT COUNT(*) AS c FROM worker_reports
        WHERE project_id = ? AND handling_status = 'pending'
          AND COALESCE(json_extract(content, '$.source'), '') != 'attempt_progress'`,
    )
    .get(projectId).c;
  const inFlightPlans = db
    .prepare(`SELECT COUNT(*) AS c FROM plan_runs WHERE project_id = ? AND status IN ('pending','in_flight')`)
    .get(projectId).c;

  const counts = {
    active_attempts: activeAttempts,
    dispatchable_intents: dispatchableIntents,
    pending_verification_jobs: pendingJobs,
    unhandled_reports: unhandledReports,
    in_flight_plan_runs: inFlightPlans,
  };
  const hasPendingWork = Object.values(counts).some((c) => c > 0);

  let wake_signals = null;
  let waiting_boundary = null;
  if (project.status === "waiting_for_change") {
    const enterRow = db
      .prepare(
        `SELECT MAX(commit_seq) AS s FROM outbox
          WHERE project_id = ? AND event_type = 'resource_state.changed'
            AND payload LIKE '%"kind":"project_lifecycle"%'
            AND payload LIKE '%"to":"waiting_for_change"%'`,
      )
      .get(projectId);
    waiting_boundary = enterRow && enterRow.s !== null ? enterRow.s : 0;
    const rows = db
      .prepare(`SELECT DISTINCT event_type FROM outbox WHERE project_id = ? AND commit_seq > ?`)
      .all(projectId, waiting_boundary);
    wake_signals = rows.map((r) => r.event_type);
  }

  return {
    project_id: projectId,
    project_status: project.status,
    has_pending_work: hasPendingWork,
    pending_work_counts: counts,
    waiting_boundary,
    wake_signals,
    note: "程序只核对可判定的等待条件（§1/§16.4）；「接下来探索什么、是否开新方向」由 Planner/Orchestrator 决定，程序检测明确条件并发送通知（§16.1），不无限重复相同任务",
  };
}

/**
 * 按评估结果维护等待状态（经 A1 updateProjectLifecycle 完成转换，事件与版本随
 * A1 语义；本函数只判定）：有可执行工作且处于等待 → resume；无可执行工作且
 * active → wait；其余不变。幂等：条件未变化时不重复转换、不派发、不建任务。
 */
export async function ensureWaitingState(pctx, { projectId, actor }) {
  const assessment = await assessWaiting(pctx, { projectId });
  const status = assessment.project_status;
  let transition = null;
  if (assessment.has_pending_work && status === "waiting_for_change") {
    transition = await updateProjectLifecycle(pctxOf(pctx), { projectId, actor, action: "resume" });
  } else if (!assessment.has_pending_work && status === "active") {
    transition = await updateProjectLifecycle(pctxOf(pctx), { projectId, actor, action: "wait" });
  }
  return {
    ...assessment,
    changed: Boolean(transition),
    action: transition ? (assessment.has_pending_work ? "resume" : "wait") : null,
    project: transition ? transition.project : { id: projectId, status },
  };
}

/* ── 恢复顺序七步（§18.2） ────────────────────────────────────────── */

function stepResult(step, key, title, status, detail) {
  return { step, key, title, status, detail };
}

/** 步骤 1：恢复数据库与证据可访问性（staging 待固定上传 + 已引用 Blob 读盘核对）。 */
async function stepDatabaseAndEvidence(pctx, db, projectIds) {
  const perProject = [];
  let degraded = false;
  for (const id of projectIds) {
    // 待固定上传：staging 目录残留（A2 的 staged 为目录暂存语义，§13）
    let staged = [];
    try {
      staged = readdirSync(evidenceDirs(pctx.dataDir, id).staging);
    } catch {
      staged = [];
    }
    let anomalies = { orphan_files: [], missing_files: [], mismatched_files: [] };
    try {
      anomalies = await findStorageAnomalies(pctx, { projectId: id });
    } catch (error) {
      degraded = true;
      anomalies = { error: error instanceof Error ? error.message : String(error), orphan_files: [], missing_files: [], mismatched_files: [] };
    }
    const bad =
      (anomalies.missing_files?.length ?? 0) + (anomalies.mismatched_files?.length ?? 0) + (anomalies.error ? 1 : 0);
    if (bad > 0) degraded = true;
    perProject.push({
      project_id: id,
      staged_uploads_pending_fix: staged, // staging 目录文件名（待重新上传固定；不制造「已有证据」事实，§13）
      missing_files: anomalies.missing_files ?? [],
      mismatched_files: anomalies.mismatched_files ?? [],
      orphan_blobs: anomalies.orphan_files ?? [],
      anomaly_error: anomalies.error || null,
      note: "缺失/损坏证据不删除不引用：报告后由证据存储写入方标记 lost 并拒绝引用（A2 域语义）；孤立 Blob 可识别、不丢弃已引用证据（§13）",
    });
  }
  return stepResult(1, "db_and_evidence", "恢复数据库，检查已引用证据的可访问性和待固定上传", degraded ? "degraded" : "ok", {
    db_ok: true,
    schema_version: db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v,
    projects: perProject,
  });
}

/** 步骤 2：恢复未处理 Outbox 与各消费者游标（拉取式补投递面）。 */
function stepOutboxAndCursors(db, projectIds) {
  const perProject = [];
  let backlog = 0;
  for (const id of projectIds) {
    const rows = db
      .prepare(`SELECT delivery_status AS s, COUNT(*) AS c FROM outbox WHERE project_id = ? GROUP BY delivery_status`)
      .all(id);
    const byStatus = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) byStatus[r.s] = r.c;
    backlog += byStatus.pending;
    const subs = db
      .prepare(`SELECT id, consumer_id, subscription_revision, last_cursor, status FROM subscriptions WHERE project_id = ?`)
      .all(id)
      .map((s) => ({
        subscription_id: s.id,
        consumer_id: s.consumer_id,
        subscription_revision: s.subscription_revision,
        last_cursor_present: Boolean(s.last_cursor),
        status: s.status,
      }));
    perProject.push({
      project_id: id,
      outbox_by_status: byStatus,
      failed_event_ids: db
        .prepare(`SELECT event_id FROM outbox WHERE project_id = ? AND delivery_status = 'failed' LIMIT 50`)
        .all(id)
        .map((r) => r.event_id),
      subscriptions: subs,
    });
  }
  return stepResult(2, "outbox_and_cursors", "恢复未处理 Outbox 和各消费者游标", "ok", {
    pending_total: backlog,
    projects: perProject,
    note: "Outbox 与游标持久于库，重启即恢复；pending 事件经变化页（#16）至少一次补投递（§14.2）；游标为 B2 不透明 token，语义归 B2；failed 事件列出供人工核查",
  });
}

/** 步骤 3+4：过期租约→中断 Attempt；未完成工具调用→unknown（C2 sweep 真实事务）。 */
async function stepLeasesAndToolCalls(pctx, projectIds) {
  const swept = [];
  for (const id of projectIds) {
    swept.push({ project_id: id, ...(await sweepExecutionState(pctxOf(pctx), id)) });
  }
  return swept;
}

/** 步骤 5：重检范围、必要前提和资源（清单面；逐次校验在派发与动作前，§9.2/§17）。 */
function stepScopePrereqsResources(db, projectIds) {
  const perProject = [];
  for (const id of projectIds) {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    const blockedIntents = db
      .prepare(`SELECT id, resume_conditions FROM intents WHERE project_id = ? AND status IN ('blocked','deferred')`)
      .all(id)
      .map((r) => ({ intent_id: r.id, resume_conditions: parseJson(r.resume_conditions, []) }));
    const prereqIntents = db
      .prepare(
        `SELECT id, prerequisite_refs FROM intents
          WHERE project_id = ? AND status IN ('proposed','queued') AND prerequisite_refs != '[]'`,
      )
      .all(id)
      .map((r) => ({ intent_id: r.id, prerequisite_refs: parseJson(r.prerequisite_refs, []) }));
    const activeAttempts = db
      .prepare(`SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND status IN ('leased','running')`)
      .get(id).c;
    perProject.push({
      project_id: id,
      project_status: project.status,
      new_dispatch_allowed: ["active", "waiting_for_change"].includes(project.status),
      blocked_or_deferred_intents: blockedIntents,
      prereq_intents_awaiting_recheck: prereqIntents,
      active_attempts: activeAttempts,
      max_active_attempts: parseJson(project.resource_policy, {}).max_active_attempts ?? null,
      note: "范围/前提/资源的逐次校验发生在派发与每次工具动作前（§17/§9.2）；本步列出的清单供 Orchestrator/Planner 重评估（下游意图标记需要重评估，不一律改失败，§9.2）",
    });
  }
  return stepResult(5, "scope_prereqs_resources", "重新检查范围、必要前提和资源", "ok", { projects: perProject });
}

/** 步骤 6：读最近 Checkpoint，补充边界之后的变化。 */
async function stepCheckpointAndChanges(pctx, db, projectId, { ensureCheckpoint, actor }) {
  let cp = await latestCheckpoint(pctx, { projectId });
  let created = false;
  if (!cp && ensureCheckpoint) {
    cp = await createCheckpoint(pctx, { projectId, actor, note: "恢复演练：项目尚无接手快照，按 §18.2 步骤 6 生成" });
    created = true;
  }
  const boundary = cp ? Number(cp.processed_boundary) || 0 : null;
  const eventsAfter = boundary === null ? null : db
    .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND commit_seq > ?`)
    .get(projectId, boundary).c;
  return {
    checkpoint: cp ? { checkpoint_id: cp.checkpoint_id, processed_boundary: cp.processed_boundary, created_at: cp.created_at, refs: cp.content?.refs ?? [] } : null,
    checkpoint_generated_now: created,
    events_after_boundary: eventsAfter,
    note: "先读最近接手快照，再经变化页补读边界之后的增量（§18.2 步骤 6）；不依赖模型记忆判断「刚才做没做过」",
  };
}

/** 步骤 7：可恢复工作清单（不自动派发，保留旧执行历史）。 */
async function stepResumableWork(pctx, db, projectId, { actor, maintainWaiting }) {
  const resumeCandidates = db
    .prepare(
      `SELECT id, question, status, resume_conditions FROM intents
        WHERE project_id = ? AND status IN ('blocked','deferred')`,
    )
    .all(projectId)
    .map((r) => ({
      intent_id: r.id,
      question: r.question,
      status: r.status,
      resume_conditions: parseJson(r.resume_conditions, []),
      note: "恢复条件为持久来源的原文（自然语言条件程序不解析语义，是否满足由 planner/orchestrator 判断）",
    }));
  const interruptedForRedispatch = db
    .prepare(
      `SELECT DISTINCT a.intent_id, a.id AS attempt_id FROM attempts a
        WHERE a.project_id = ? AND a.status IN ('interrupted','failed')`,
    )
    .all(projectId)
    .map((r) => ({ ...r, note: "旧 Attempt 保留为历史（§18.2 步骤 7）；重派将创建新 Attempt 与更高 fencing token" }));
  const waiting = maintainWaiting ? await ensureWaitingState(pctx, { projectId, actor }) : await assessWaiting(pctx, { projectId });
  return {
    resume_candidates: resumeCandidates,
    interrupted_attempts_for_redispatch: interruptedForRedispatch,
    waiting,
    note: "程序产出可恢复清单与等待评估，不自动派发（§3.2：执行分配由 AI 提交、程序执行与保障）；分配经 POST /attempts 由 runtime 会话执行",
  };
}

/**
 * 执行 §18.2 恢复顺序七步（全部基于持久记录与真实事务；重启注入由调用方
 * 以真实「关库关服→同目录重启」承载，本函数承担重启后的核对与修复）。
 * @param {{dataDir: string}} pctx
 * @param {{projectId?: string, actor: string, drill?: boolean, persistReport?: boolean}} opts
 */
export async function runRecovery(pctx, opts = {}) {
  const actor = opts.actor || "runtime/recovery";
  const drill = Boolean(opts.drill);
  const store = await getStore(pctx);
  const db = store.db;
  const projectRows = opts.projectId
    ? db.prepare("SELECT id FROM projects WHERE id = ?").all(opts.projectId)
    : db.prepare("SELECT id FROM projects").all();
  const projectIds = projectRows.map((r) => r.id);

  // 步骤 1：数据库（开库即恢复）与证据可访问性
  const step1 = await stepDatabaseAndEvidence(pctxOf(pctx), db, projectIds);
  // 步骤 2：Outbox 与消费者游标
  const step2 = stepOutboxAndCursors(db, projectIds);
  // 步骤 3+4：sweep（过期租约→interrupted；running→unknown、planned→cancelled，真实事务）
  const swept = await stepLeasesAndToolCalls(pctxOf(pctx), projectIds);
  const step3 = stepResult(
    3,
    "expired_leases",
    "处理过期租约，标记中断 Attempt",
    "ok",
    {
      per_project: swept.map((s) => ({
        project_id: s.project_id,
        interrupted_attempts: s.interrupted,
        revoked_attempts: s.revoked,
      })),
      note: "经 C2 sweepExecutionState 真实事务执行（§10.2/§18.2 步骤 3）；过期租约的执行权失效并通知 Orchestrator（resource_state.changed kind=lease_expired）",
    },
  );
  const unfinished = [];
  for (const id of projectIds) {
    for (const t of db
      .prepare(`SELECT id, attempt_id, tool_name, status FROM tool_calls WHERE project_id = ? AND status IN ('planned','running','unknown')`)
      .all(id)) {
      unfinished.push({ project_id: id, tool_call_id: t.id, attempt_id: t.attempt_id, tool_name: t.tool_name, status: t.status });
    }
  }
  const step4 = stepResult(
    4,
    "unfinished_tool_calls",
    "检查未完成工具调用，无法确定结果的标记 unknown",
    "ok",
    {
      remaining: unfinished,
      unknown_count: unfinished.filter((t) => t.status === "unknown").length,
      note: "sweep 已将过期/停止 Attempt 的 running 调用标 unknown（无法确定外部结果）；残余 planned/running 属仍在租约内的在途调用。unknown 必须先检查现状再决定重试，不视作恰好一次（§10.2/§20.3 场景 18）",
    },
  );
  // 步骤 5：范围/前提/资源清单
  const step5 = stepScopePrereqsResources(db, projectIds);
  // 步骤 6：Checkpoint 与边界后变化（演练时无快照则先生成）
  const checkpoints = [];
  for (const id of projectIds) {
    checkpoints.push({ project_id: id, ...(await stepCheckpointAndChanges(pctxOf(pctx), db, id, { ensureCheckpoint: drill, actor })) });
  }
  const step6 = stepResult(6, "checkpoint_and_changes", "读取最近 Checkpoint，再补充边界之后的变化", "ok", { projects: checkpoints });
  // 步骤 7：可恢复清单 + 等待评估（演练时维护等待状态，§1/§16.4）
  const resumable = [];
  for (const id of projectIds) {
    resumable.push({ project_id: id, ...(await stepResumableWork(pctxOf(pctx), db, id, { actor, maintainWaiting: drill })) });
  }
  const step7 = stepResult(7, "resumable_work", "创建新 Attempt 或恢复允许恢复的工作（清单面，不自动派发）", "ok", { projects: resumable });

  const report = {
    kind: "sorne.recovery.report",
    ran_at: new Date().toISOString(),
    actor,
    drill,
    scope: { project_ids: projectIds },
    steps: [step1, step2, step3, step4, step5, step6, step7],
    summary: {
      degraded: step1.status !== "ok",
      pending_outbox: step2.detail.pending_total,
      interrupted_attempts: step3.detail.per_project.reduce((a, p) => a + p.interrupted_attempts.length, 0),
      unknown_tool_calls: step4.detail.unknown_count,
      note: "七步全部基于持久记录执行；已保存的漏洞与线索即使尚未被 planner 消费，也经事件恢复继续处理（§18.2）",
    },
  };

  if (opts.persistReport && drill) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = drillReportPath(pctx.dataDir, stamp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
    report.report_file = path;
  }
  return report;
}
