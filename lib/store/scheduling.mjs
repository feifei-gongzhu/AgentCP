/**
 * 检查点接续、分支搁置与唤醒调度（01 号基线 §十一、§十二、§十四至§十六；阶段 6）。
 *
 * 核心流程：
 *   1. shelveBranch：搁置一个分支并记录原因、范围、重新考虑的条件和唤醒事件类型。
 *      §十四「暂时不继续某分支必须关联原因和范围」。
 *   2. resumeBranch：恢复搁置的分支。
 *   3. evaluateWakeConditions：检查搁置分支的唤醒条件是否满足（新事件匹配）。
 *      §十六「新证据、环境变化、目标调整或相关任务结果，都可能让它重新进入探索」。
 *   4. handoffWithDedup：包装交接提交，确保幂等（复用 A1 提交去重）。
 *   5. recoverWithCheckpoint：连接 recovery.mjs 的恢复流程，在正常执行边界使用。
 *
 * 设计约束：
 *   - 检查点只是恢复入口，关键依据从持久记录读取（§十四）。
 *   - 报告生成与运行状态独立（§十六）。
 *   - 程序不代答探索方向（§3.2），只做可核对的条件判定。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { createCheckpoint, latestCheckpoint, assessWaiting } from "./recovery.mjs";

function pad4(n) { return String(n).padStart(4, "0"); }

function allocateSeq(db, projectId, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(projectId, kind);
  const row = db.prepare(
    "SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?",
  ).get(projectId, kind);
  db.prepare(
    "UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?",
  ).run(row.n + 1, projectId, kind);
  return row.n;
}

function allocateCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  if (!row) throw apiError("INVALID_REFERENCE", `项目不存在：${projectId}`);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.n + 1, projectId);
  return row.n;
}

const VALID_REASONS = new Set([
  "insufficient_evidence", "conditions_unmet", "unrelated",
  "cost_too_high", "hypothesis_falsified", "blocked", "unknown",
]);

/**
 * 搁置一个分支（§十四/§十六）。
 *
 * @param {object} pctx
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.branchId - 分支标识（意图 ID、目标 ID 等）
 * @param {string} [opts.branchKind] - intent/goal/asset
 * @param {string} opts.shelveReason - 搁置原因类别
 * @param {string} [opts.reasonDetail] - 详细原因说明
 * @param {string} [opts.scope] - 搁置范围说明
 * @param {string[]} [opts.reconsiderConditions] - 重新考虑的条件
 * @param {string[]} [opts.wakeOnEventTypes] - 唤醒事件类型
 * @param {string} opts.actor
 */
export async function shelveBranch(pctx, opts) {
  const {
    projectId, branchId, branchKind, shelveReason, reasonDetail,
    scope, reconsiderConditions, wakeOnEventTypes, actor,
  } = opts;

  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!branchId) throw apiError("BAD_REQUEST", "缺少 branch_id");
  const reason = shelveReason || "unknown";
  if (!VALID_REASONS.has(reason)) {
    throw apiError("BAD_REQUEST", `无效的搁置原因：${reason}`);
  }

  const store = await getStore(pctx);
  return store.runSerial((db) => {
    // 检查是否已搁置
    const existing = db.prepare(
      "SELECT * FROM branch_shelving WHERE project_id = ? AND branch_id = ? AND status = 'shelved'",
    ).get(projectId, branchId);
    if (existing) {
      return {
        shelving_id: existing.id,
        status: "shelved",
        already_shelved: true,
        note: "分支已处于搁置状态",
      };
    }

    const commitSeq = allocateCommitSeq(db, projectId);
    const now = new Date().toISOString();
    const n = allocateSeq(db, projectId, "branch_shelving");
    const id = `SH-${projectId}-${pad4(n)}`;

    db.prepare(
      `INSERT INTO branch_shelving
         (id, project_id, branch_id, branch_kind,
          shelve_reason, reason_detail, scope,
          reconsider_conditions_json, wake_on_event_types_json,
          status, shelved_at, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shelved', ?, ?, ?, ?)`,
    ).run(
      id, projectId, branchId, branchKind || "intent",
      reason, reasonDetail || "", scope || "",
      JSON.stringify(reconsiderConditions || []),
      JSON.stringify(wakeOnEventTypes || []),
      now, now, actor || "system", commitSeq,
    );

    return {
      shelving_id: id,
      branch_id: branchId,
      shelve_reason: reason,
      status: "shelved",
      reconsider_conditions: reconsiderConditions || [],
      wake_on_event_types: wakeOnEventTypes || [],
    };
  });
}

/**
 * 恢复搁置的分支。
 */
export async function resumeBranch(pctx, { projectId, branchId, actor, resumeNote }) {
  if (!projectId || !branchId) throw apiError("BAD_REQUEST", "缺少 project_id 或 branch_id");

  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = db.prepare(
      "SELECT * FROM branch_shelving WHERE project_id = ? AND branch_id = ? AND status = 'shelved' ORDER BY created_seq DESC LIMIT 1",
    ).get(projectId, branchId);
    if (!row) return { resumed: false, note: "未找到搁置记录" };

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE branch_shelving SET status = 'resumed', resumed_at = ? WHERE id = ?",
    ).run(now, row.id);

    return {
      shelving_id: row.id,
      branch_id: branchId,
      status: "resumed",
      resumed: true,
      previous_reason: row.shelve_reason,
      resume_note: resumeNote || "",
    };
  });
}

/**
 * 列出搁置的分支。
 */
export async function listShelvedBranches(pctx, { projectId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;

  const rows = db.prepare(
    "SELECT * FROM branch_shelving WHERE project_id = ? AND status = 'shelved' ORDER BY shelved_at",
  ).all(projectId);

  return {
    branches: rows.map((r) => ({
      shelving_id: r.id,
      branch_id: r.branch_id,
      branch_kind: r.branch_kind,
      shelve_reason: r.shelve_reason,
      reason_detail: r.reason_detail,
      scope: r.scope,
      reconsider_conditions: JSON.parse(r.reconsider_conditions_json),
      wake_on_event_types: JSON.parse(r.wake_on_event_types_json),
      shelved_at: r.shelved_at,
    })),
    total: rows.length,
  };
}

/**
 * 检查搁置分支的唤醒条件（§十六：根据相关变化唤醒）。
 *
 * 扫描 Outbox 中自搁置后出现的事件，与搁置记录的 wake_on_event_types 匹配。
 */
export async function evaluateWakeConditions(pctx, { projectId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;

  const shelved = db.prepare(
    "SELECT * FROM branch_shelving WHERE project_id = ? AND status = 'shelved'",
  ).all(projectId);

  const wakeable = [];
  for (const row of shelved) {
    const wakeTypes = JSON.parse(row.wake_on_event_types_json || "[]");
    if (wakeTypes.length === 0) continue;

    const typeList = wakeTypes.map((t) => `'${t}'`).join(",");
    const events = db.prepare(
      `SELECT event_type, COUNT(*) AS c FROM outbox
       WHERE project_id = ? AND commit_seq > ? AND event_type IN (${typeList})
       GROUP BY event_type`,
    ).all(projectId, row.created_seq);

    if (events.length > 0) {
      wakeable.push({
        shelving_id: row.id,
        branch_id: row.branch_id,
        shelve_reason: row.shelve_reason,
        matched_events: events.map((e) => ({ event_type: e.event_type, count: e.c })),
        reconsider_conditions: JSON.parse(row.reconsider_conditions_json),
        note: "搁置后有匹配的事件到达——建议重新评估该分支（§十六）",
      });
    }
  }

  return { wakeable, total_shelved: shelved.length };
}

/**
 * 阶段边界检查点：在正常执行的阶段边界创建检查点（§十四/§十八）。
 * 包装 recovery.mjs 的 createCheckpoint，添加阶段标注。
 */
export async function phaseBoundaryCheckpoint(pctx, { projectId, intentId, attemptId, actor, phaseNote }) {
  return createCheckpoint(pctx, {
    projectId, intentId, attemptId, actor,
    note: phaseNote || "阶段边界检查点",
  });
}

/**
 * 恢复入口：读取最近检查点 + 评估等待状态 + 检查搁置分支唤醒条件。
 * 连接 recovery.mjs 已有能力，在正常启动和恢复时使用。
 */
export async function recoverContext(pctx, { projectId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");

  const checkpoint = await latestCheckpoint(pctx, { projectId });
  const waitingState = await assessWaiting(pctx, { projectId });
  const wakeConditions = await evaluateWakeConditions(pctx, { projectId });
  const shelved = await listShelvedBranches(pctx, { projectId });

  return {
    checkpoint: checkpoint ? {
      checkpoint_id: checkpoint.checkpoint_id,
      processed_boundary: checkpoint.processed_boundary,
      created_at: checkpoint.created_at,
      has_content: Boolean(checkpoint.content),
    } : null,
    waiting: waitingState,
    wake_conditions: wakeConditions,
    shelved_branches: shelved,
    note: checkpoint
      ? "检查点只是恢复入口：关键依据的当前状态从持久记录读取（§十四）"
      : "无检查点——需要从持久记录重建上下文",
  };
}
