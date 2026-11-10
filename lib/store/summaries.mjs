/**
 * 分支摘要生命周期服务（01 号基线 §三、§十三；实施计划阶段 5）。
 *
 * 核心流程：
 *   1. beginRefresh：固定输入水位（refresh_input_seq），状态 → refreshing。
 *      §十三「刷新开始时固定输入水位」。
 *   2. publishRefresh：提交语义摘要、引用、子入口及判断快照，推进 covered_commit_seq
 *      到刷新开始时固定的水位。晚于水位的新增材料仍标为待汇总。
 *      §十三「发布时仅推进该水位」。
 *   3. getSummary：返回摘要 + 程序生成的子入口 + 未汇总条目数 + 关键判断即时状态。
 *      §十三「关键结论被修正时，其状态和依据变化立即可见，不等待语义摘要生成」。
 *   4. listPendingRefreshes：列出有新内容未纳入的分支。
 *   5. markStale：新内容写入后标记分支为 stale（程序自动调用或手动触发）。
 *
 * 设计约束：
 *   - 高频写入时不为每条记录重写祖先摘要（§十三）。
 *   - 判断状态即时从记录读取，不等待摘要刷新。
 *   - 结构重组经稳定标识和映射保留旧引用。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";

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

/**
 * 获取项目当前的最高 commit_seq（新内容的水位）。
 */
function currentWatermark(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  return row ? row.n - 1 : 0;
}

/**
 * 程序生成：按分支收集子入口编号。
 */
function collectSubEntries(db, projectId, branchId, branchKind) {
  if (branchKind === "goal") {
    const intents = db.prepare(
      "SELECT id FROM intents WHERE project_id = ? AND goal_id = ? ORDER BY created_seq",
    ).all(projectId, branchId);
    return intents.map((r) => r.id);
  }
  if (branchKind === "asset_type") {
    const assets = db.prepare(
      "SELECT id FROM assets WHERE project_id = ? AND asset_type = ? ORDER BY created_seq",
    ).all(projectId, branchId);
    return assets.map((r) => r.id);
  }
  return [];
}

/**
 * 程序生成：当前判断状态快照（从记录直接读取，不依赖摘要）。
 */
function snapshotJudgementStates(db, projectId, branchId, branchKind) {
  const states = {};
  if (branchKind === "goal") {
    const hyps = db.prepare(
      `SELECT h.id, h.statement, h.status FROM hypotheses h
       INNER JOIN relations r ON r.project_id = h.project_id AND r.from_id = h.id
       INNER JOIN intents i ON i.project_id = r.project_id AND i.id = r.to_id
       WHERE h.project_id = ? AND i.goal_id = ? AND r.retracted_at IS NULL`,
    ).all(projectId, branchId);
    for (const h of hyps) {
      states[h.id] = { kind: "hypothesis", statement: h.statement, status: h.status };
    }
    const vulns = db.prepare(
      `SELECT v.id, v.category, v.status FROM vulnerabilities v
       INNER JOIN relations r ON r.project_id = v.project_id AND r.to_id = v.id
       INNER JOIN intents i ON i.project_id = r.project_id AND i.id = r.from_id
       WHERE v.project_id = ? AND i.goal_id = ? AND r.retracted_at IS NULL`,
    ).all(projectId, branchId);
    for (const v of vulns) {
      states[v.id] = { kind: "vulnerability", category: v.category, status: v.status };
    }
  }
  // Direct lookup for intents under this goal
  const intents = db.prepare(
    "SELECT id, status, question FROM intents WHERE project_id = ? AND goal_id = ?",
  ).all(projectId, branchId);
  for (const i of intents) {
    states[i.id] = { kind: "intent", question: i.question, status: i.status };
  }
  return states;
}

/**
 * 统计分支内晚于某个 commit_seq 的新增记录数（未纳入摘要的条目）。
 */
function countUnsummarized(db, projectId, branchId, branchKind, afterSeq) {
  if (branchKind === "goal") {
    const obs = db.prepare(
      `SELECT COUNT(*) AS c FROM observations WHERE project_id = ? AND created_seq > ?
       AND EXISTS (SELECT 1 FROM relations r WHERE r.project_id = observations.project_id
         AND r.from_id = observations.id
         AND EXISTS (SELECT 1 FROM intents i WHERE i.project_id = r.project_id AND i.id = r.to_id AND i.goal_id = ?))`,
    ).get(projectId, afterSeq, branchId);
    const directIntentItems = db.prepare(
      `SELECT COUNT(*) AS c FROM observations o
       INNER JOIN relations r ON r.project_id = o.project_id AND r.from_id = o.id
       WHERE o.project_id = ? AND o.created_seq > ?
       AND r.to_id IN (SELECT id FROM intents WHERE project_id = ? AND goal_id = ?)`,
    ).get(projectId, afterSeq, projectId, branchId);
    return (obs.c || 0) + (directIntentItems.c || 0);
  }
  return 0;
}

/**
 * 获取或创建分支摘要记录。
 */
async function ensureSummary(pctx, { projectId, branchId, branchKind }) {
  const store = await getStore(pctx);
  const db = store.db;
  const existing = db.prepare(
    "SELECT * FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
  ).get(projectId, branchId);
  if (existing) return existing;

  return store.runSerial((tx) => {
    const commitSeq = allocateCommitSeq(tx, projectId);
    const now = new Date().toISOString();
    const n = allocateSeq(tx, projectId, "branch_summary");
    const id = `BS-${projectId}-${pad4(n)}`;
    tx.prepare(
      `INSERT INTO branch_summaries
         (id, project_id, branch_id, branch_kind,
          semantic_summary, summary_refs_json, covered_commit_seq,
          refresh_status, refresh_input_seq,
          judgement_snapshot_json, sub_entries_json, incremental_prompt,
          created_at, created_by, created_seq, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, '', '[]', 0, 'stale', NULL, '{}', '[]', '', ?, 'system', ?, ?, ?)`,
    ).run(id, projectId, branchId, branchKind || "goal", now, commitSeq, now, commitSeq);
    return tx.prepare("SELECT * FROM branch_summaries WHERE id = ?").get(id);
  });
}

/**
 * 开始刷新：固定输入水位，状态 → refreshing。
 * §十三「刷新开始时固定输入水位」。
 */
export async function beginRefresh(pctx, { projectId, branchId, branchKind, actor }) {
  if (!projectId || !branchId) throw apiError("BAD_REQUEST", "缺少 project_id 或 branch_id");
  const store = await getStore(pctx);
  await ensureSummary(pctx, { projectId, branchId, branchKind });

  return store.runSerial((db) => {
    const watermark = currentWatermark(db, projectId);
    const now = new Date().toISOString();
    const commitSeq = allocateCommitSeq(db, projectId);

    // 程序生成子入口和判断状态
    const subEntries = collectSubEntries(db, projectId, branchId, branchKind || "goal");
    const judgements = snapshotJudgementStates(db, projectId, branchId, branchKind || "goal");

    db.prepare(
      `UPDATE branch_summaries SET
         refresh_status = 'refreshing',
         refresh_input_seq = ?,
         sub_entries_json = ?,
         judgement_snapshot_json = ?,
         updated_at = ?, updated_seq = ?
       WHERE project_id = ? AND branch_id = ?`,
    ).run(watermark, JSON.stringify(subEntries), JSON.stringify(judgements),
      now, commitSeq, projectId, branchId);

    const row = db.prepare(
      "SELECT * FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
    ).get(projectId, branchId);

    return {
      summary_id: row.id,
      branch_id: branchId,
      refresh_status: "refreshing",
      refresh_input_seq: watermark,
      sub_entries: subEntries,
      judgement_states: judgements,
      note: `输入水位已固定于 commit_seq=${watermark}；刷新期间新到的记录将继续标为待汇总`,
    };
  });
}

/**
 * 发布刷新结果：提交语义摘要，推进 covered_commit_seq。
 * §十三「发布时仅推进该水位。晚于水位的新增材料继续显示为待纳入摘要」。
 */
export async function publishRefresh(pctx, {
  projectId, branchId, semanticSummary, summaryRefs, incrementalPrompt, actor,
}) {
  if (!projectId || !branchId) throw apiError("BAD_REQUEST", "缺少 project_id 或 branch_id");
  const store = await getStore(pctx);

  return store.runSerial((db) => {
    const row = db.prepare(
      "SELECT * FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
    ).get(projectId, branchId);
    if (!row) throw apiError("NOT_FOUND", `分支摘要不存在：${branchId}`);
    if (row.refresh_status !== "refreshing") {
      return {
        summary_id: row.id,
        status: row.refresh_status,
        note: "分支未在刷新中，无法发布",
      };
    }

    const now = new Date().toISOString();
    const commitSeq = allocateCommitSeq(db, projectId);
    const newWatermark = currentWatermark(db, projectId);
    const coveredSeq = row.refresh_input_seq;

    // 判断是否有新内容超过固定水位
    const hasNewAfterWatermark = newWatermark > coveredSeq;
    const newStatus = hasNewAfterWatermark ? "stale" : "current";

    db.prepare(
      `UPDATE branch_summaries SET
         semantic_summary = ?,
         summary_refs_json = ?,
         covered_commit_seq = ?,
         refresh_status = ?,
         refresh_input_seq = NULL,
         incremental_prompt = ?,
         updated_at = ?, updated_seq = ?
       WHERE project_id = ? AND branch_id = ?`,
    ).run(
      semanticSummary || "", JSON.stringify(summaryRefs || []),
      coveredSeq, newStatus,
      incrementalPrompt || "", now, commitSeq, projectId, branchId,
    );

    return {
      summary_id: row.id,
      branch_id: branchId,
      covered_commit_seq: coveredSeq,
      refresh_status: newStatus,
      has_unsummarized: hasNewAfterWatermark,
      note: hasNewAfterWatermark
        ? `摘要已发布（覆盖到 commit_seq=${coveredSeq}），但刷新期间有新内容到达——状态为 stale`
        : `摘要已发布（覆盖到 commit_seq=${coveredSeq}），当前无未汇总内容`,
    };
  });
}

/**
 * 获取分支摘要 + 即时判断状态 + 未汇总条目数。
 * §十三「关键结论被修正时，其状态和依据变化立即可见，不等待语义摘要生成」。
 */
export async function getSummary(pctx, { projectId, branchId, branchKind }) {
  if (!projectId || !branchId) throw apiError("BAD_REQUEST", "缺少 project_id 或 branch_id");
  const store = await getStore(pctx);
  const db = store.db;

  const row = db.prepare(
    "SELECT * FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
  ).get(projectId, branchId);

  if (!row) {
    return {
      exists: false,
      branch_id: branchId,
      note: "该分支尚无摘要记录",
    };
  }

  // 即时判断状态（从记录直接读取，不用摘要内的快照）
  const liveJudgements = snapshotJudgementStates(db, projectId, branchId, row.branch_kind);
  const subEntries = collectSubEntries(db, projectId, branchId, row.branch_kind);
  const unsummarizedCount = countUnsummarized(db, projectId, branchId, row.branch_kind, row.covered_commit_seq);

  return {
    exists: true,
    summary_id: row.id,
    branch_id: row.branch_id,
    branch_kind: row.branch_kind,
    semantic_summary: row.semantic_summary,
    summary_refs: JSON.parse(row.summary_refs_json),
    covered_commit_seq: row.covered_commit_seq,
    refresh_status: row.refresh_status,
    incremental_prompt: row.incremental_prompt,
    // 程序生成（实时）
    sub_entries: subEntries,
    live_judgement_states: liveJudgements,
    unsummarized_count: unsummarizedCount,
    note: unsummarizedCount > 0
      ? `有 ${unsummarizedCount} 项新内容未纳入摘要——真实入口已可查，摘要待刷新`
      : null,
  };
}

/**
 * 标记分支为 stale（有新内容未纳入）。
 * 新内容写入后由程序自动触发；不在每条写入时重写摘要（§十三）。
 */
export async function markStale(pctx, { projectId, branchId }) {
  if (!projectId || !branchId) throw apiError("BAD_REQUEST", "缺少 project_id 或 branch_id");
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const row = db.prepare(
      "SELECT id, refresh_status FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
    ).get(projectId, branchId);
    if (!row) return { marked: false, note: "分支摘要不存在" };
    if (row.refresh_status === "refreshing") {
      return { marked: false, note: "分支正在刷新中，不覆盖状态（刷新完成后自动判断）" };
    }
    if (row.refresh_status === "stale") {
      return { marked: false, note: "已是 stale 状态" };
    }
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE branch_summaries SET refresh_status = 'stale', updated_at = ? WHERE id = ?",
    ).run(now, row.id);
    return { marked: true, summary_id: row.id };
  });
}

/**
 * 列出需要刷新的分支（stale 状态）。
 */
export async function listPendingRefreshes(pctx, { projectId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;

  const rows = db.prepare(
    "SELECT id, branch_id, branch_kind, covered_commit_seq, updated_at FROM branch_summaries WHERE project_id = ? AND refresh_status = 'stale' ORDER BY updated_at",
  ).all(projectId);

  return {
    branches: rows.map((r) => ({
      summary_id: r.id,
      branch_id: r.branch_id,
      branch_kind: r.branch_kind,
      covered_commit_seq: r.covered_commit_seq,
      updated_at: r.updated_at,
    })),
    total: rows.length,
  };
}
