/**
 * B1 —— 投影服务（Projection Service，§3 §15.1–§15.4；蓝图端点 #13/#15）。
 *
 * 规范落实（逐条）：
 *   - §15.1 Map 是视图：asset_map / exploration_map 由结构化数据生成，可完全重建；
 *     每份 Map 含 snapshot_id、schema_version、snapshot_commit_seq、生成时间、
 *     投影范围、折叠/省略说明及展开入口；生成使用一致读视图（单读事务），
 *     并标注内容实际覆盖的提交序号（content_commit_seq），不拿旧投影冒充当前版本。
 *   - §15.2 快照与事件无缝衔接：先建立/更新订阅边界得 S（经 §2.7 冻结签名
 *     openSubscriptionBoundary，B2 实现），再在一致读视图内生成内容——内容必包含
 *     全部 ≤ S 的提交，S 之后的事件重放补齐增量，无间隙；快照同返
 *     subscription_id / subscription_revision / resume_cursor。
 *   - §15.3 Planner 视图：分组资产骨架、活跃与受阻方向、等待验证线索、确认漏洞、
 *     覆盖缺口、预算、自上次已接收规划以来的变化；长期未变分支可折叠但保留计数
 *     与展开入口，折叠节点仍参与依赖检查（requires 边全量列出，§20.3 场景 15）。
 *   - §15.4 Worker 视图：围绕意图 1–2 跳邻居 + 强制项（目标/范围/执行约束、
 *     前提（可超跳数）、身份条件说明、撤回/争议/范围变化、相关尝试与失败、
 *     待解决问题、证据索引）；超预算分层读取并在 not_provided 中明示未提供内容，
 *     不以截断把「未显示」变成「不存在」；原始证据按需获取。
 *   - 投影服务只读业务表（快照自身元数据除外），不成为第二真值来源（§3）；
 *     程序只做投影与规模保障，探索取舍留给 AI（§3.2）。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { apiError } from "../errors.mjs";
import { buildProjectContext, getStore } from "./record-service.mjs";
import { projectDir } from "./layout.mjs";
import { locateRecord } from "./records-read.mjs";
import { buildTechStack, renderTechStackLines } from "./tech-stack.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** 视图规模上限：超出即显式省略（计数 + 展开入口），绝不静默截断（§15.4）。 */
const LIMITS = Object.freeze({
  edges: 500, // asset_map 拓扑边
  exploration_nodes: 200, // exploration_map 各判断清单
  exploration_edges: 300,
  recent_events: 50, // planner_view 自基线以来事件样本
  worker_nodes: 300, // worker 视图闭包节点上限
  prerequisites: 200,
  attempts: 50,
  problem_tool_calls: 100,
  condition_records: 50,
  hypotheses: 50,
  evidence: 100,
  sample_ids: 10,
});

const DEFAULT_WORKER_BUDGET_CHARS = 24000;
const MIN_WORKER_BUDGET_CHARS = 2000;

const SNAPSHOT_KINDS = Object.freeze(["asset_map", "exploration_map", "planner_view", "context"]);
/** 连字符别名（页面/浏览器习惯）→ 下划线规范名（与 snapshots.kind CHECK 一致）。 */
const KIND_ALIASES = Object.freeze({
  "asset-map": "asset_map",
  "exploration-map": "exploration_map",
  "planner-view": "planner_view",
});

export function normalizeSnapshotKind(kind) {
  const text = String(kind ?? "").trim();
  const normalized = KIND_ALIASES[text] || text;
  if (!SNAPSHOT_KINDS.includes(normalized)) {
    throw apiError("BAD_REQUEST", `未知快照类型：${kind}（允许：${SNAPSHOT_KINDS.join(" / ")}）`, {
      detail: { allowed: SNAPSHOT_KINDS },
    });
  }
  return normalized;
}

/* ── 订阅边界（§2.7 冻结签名，B2 实现；B1 不直接写 subscriptions 表） ── */

async function openBoundary(pctx, { projectId, focus, scope }) {
  const mod = await import("./changes.mjs");
  if (typeof mod.openSubscriptionBoundary === "function") {
    return mod.openSubscriptionBoundary(pctx, { projectId, focus, scope });
  }
  return null; // B2 未实装：显式不可用，不伪装成功（见竣工记录协调项）
}

/* ── 基础工具 ─────────────────────────────────────────────────────── */

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 一致读视图（§15.1）：同步读事务（BEGIN DEFERRED）内完成全部内容查询；
 * 视图内高水位 = content_commit_seq。事务体完全同步，与 runSerial 队列无交错。
 */
function readView(store, fn) {
  store.db.exec("BEGIN");
  try {
    const out = fn(store.db);
    store.db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      /* 连接异常时由句柄兜底 */
    }
    throw error;
  }
}

function currentCommitSeq(db, projectId) {
  const row = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId);
  return row ? Math.max(0, row.n - 1) : 0;
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function idList(list, limit) {
  return {
    ids: list.slice(0, limit),
    count: list.length,
    omitted: Math.max(0, list.length - limit),
    omitted_note: list.length > limit ? `仅列前 ${limit} 个编号，其余经 GET /sorne/records/{id} 展开` : undefined,
  };
}

/** 端点编号 → 对象种类（视图内标注；定位失败返回 null，不猜测）。 */
function kindOfId(db, projectId, id, assetIds) {
  if (assetIds && assetIds.has(id)) return "assets";
  const hit = locateRecord(db, projectId, id);
  return hit ? hit.table : null;
}

/** 记录端点的当前状态摘要（依赖/前提检查用；状态以库为准；无状态列的表置 null）。 */
function endpointStatus(db, projectId, id, inView) {
  const hit = locateRecord(db, projectId, id);
  if (!hit) return { id, kind: null, status: null, state_version: null, in_view: Boolean(inView) };
  let row = null;
  try {
    row = db.prepare(`SELECT status, state_version FROM ${hit.table} WHERE id = ?`).get(id);
  } catch {
    row = null; // 表无 status/state_version 列（如 observations/relations）
  }
  return {
    id,
    kind: hit.table,
    status: row ? (row.status ?? null) : null,
    state_version: row ? (row.state_version ?? null) : null,
    in_view: Boolean(inView),
  };
}

/* ── 资产活动度与折叠（§15.3） ───────────────────────────────────── */

/**
 * 资产最近活动提交序号：资产创建 / 触及该资产的边 / 挂在该资产上的漏洞 /
 * 指向该资产的采集（经 resources）。用于「长期没有变化的分支可折叠」的判定。
 */
function assetActivitySeqs(db, projectId) {
  const activity = new Map();
  const bump = (id, seq) => {
    if (typeof seq !== "number") return;
    const cur = activity.get(id) ?? 0;
    if (seq > cur) activity.set(id, seq);
  };
  for (const row of db.prepare("SELECT id, created_seq FROM assets WHERE project_id = ?").all(projectId)) {
    bump(row.id, row.created_seq);
  }
  for (const row of db
    .prepare(
      `SELECT from_id, to_id, created_seq FROM relations WHERE project_id = ?
        AND (from_id IN (SELECT id FROM assets WHERE project_id = ?)
          OR to_id IN (SELECT id FROM assets WHERE project_id = ?))`,
    )
    .all(projectId, projectId, projectId)) {
    bump(row.from_id, row.created_seq);
    bump(row.to_id, row.created_seq);
  }
  for (const row of db
    .prepare("SELECT asset_id, created_seq FROM vulnerabilities WHERE project_id = ? AND asset_id IS NOT NULL")
    .all(projectId)) {
    bump(row.asset_id, row.created_seq);
  }
  for (const row of db
    .prepare(
      `SELECT r.asset_id AS asset_id, c.created_seq AS seq FROM captures c
         JOIN resources r ON r.id = c.resource_id
        WHERE c.project_id = ? AND r.asset_id IS NOT NULL`,
    )
    .all(projectId)) {
    bump(row.asset_id, row.seq);
  }
  return activity;
}

/**
 * 分组资产骨架（asset_map 与 planner_view 共用）。
 * 折叠：activity_seq ≤ foldSince 的资产进入 folded 桶（计数 + 样本 + 展开入口），
 * 其拓扑边仍保留；触及折叠资产的 requires 边全量列入 folded_dependencies
 * （§15.3 折叠节点仍参与依赖检查；§20.3 场景 15）。
 */
function buildAssetSkeleton(db, projectId, foldSince) {
  const assets = db
    .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId);
  const assetIds = new Set(assets.map((a) => a.id));
  const activity = assetActivitySeqs(db, projectId);
  const foldingActive = typeof foldSince === "number";

  const groupsMap = new Map();
  for (const a of assets) {
    if (!groupsMap.has(a.asset_type)) groupsMap.set(a.asset_type, []);
    groupsMap.get(a.asset_type).push(a);
  }

  const groups = [];
  const foldedIds = new Set();
  for (const [asset_type, list] of groupsMap) {
    const visible = [];
    const folded = [];
    for (const a of list) {
      const act = activity.get(a.id) ?? a.created_seq;
      if (foldingActive && act < foldSince) folded.push({ asset: a, activity_seq: act });
      else visible.push({ asset: a, activity_seq: act });
    }
    for (const f of folded) foldedIds.add(f.asset.id);
    const group = {
      asset_type,
      total: list.length,
      assets: visible.map(({ asset, activity_seq }) => ({
        id: asset.id,
        canonical_key: asset.canonical_key,
        original_input: asset.original_input,
        scope_status: asset.scope_status,
        activity_seq: activity_seq,
        created_seq: asset.created_seq,
      })),
    };
    if (folded.length > 0) {
      const minActivity = Math.min(...folded.map((f) => f.activity_seq));
      group.folded = {
        count: folded.length,
        sample_ids: folded.slice(0, LIMITS.sample_ids).map((f) => f.asset.id),
        min_activity_seq: minActivity,
        max_activity_seq: Math.max(...folded.map((f) => f.activity_seq)),
        unfold_fold_since: minActivity, // 该组全部资产活动度 ≥ min，fold_since 取该值即整组展开
        expand: {
          how: `以 fold_since=${minActivity} 重新请求本快照可展开本组全部资产；单个资产经 GET /sorne/records/{id} 读取`,
          note: "折叠只影响展示，不影响依赖、范围、订阅与恢复检查（§15.3）",
        },
      };
    }
    groups.push(group);
  }

  // 拓扑边：任一端点是本项目资产的边（含指向其他种类端点的来源/指向边）
  const allEdges = db
    .prepare("SELECT * FROM relations WHERE project_id = ? ORDER BY valid_from_seq, rowid")
    .all(projectId);
  const touchingTotal = allEdges.filter((e) => assetIds.has(e.from_id) || assetIds.has(e.to_id)).length;
  const assetEdges = [];
  for (const e of allEdges) {
    if (assetIds.has(e.from_id) || assetIds.has(e.to_id)) {
      assetEdges.push(e);
      if (assetEdges.length >= LIMITS.edges) break;
    }
  }
  const edges = assetEdges.map((e) => ({
    id: e.id,
    from: e.from_id,
    to: e.to_id,
    from_kind: kindOfId(db, projectId, e.from_id, assetIds),
    to_kind: kindOfId(db, projectId, e.to_id, assetIds),
    relation_type: e.relation_type,
    requires_state: e.requires_state || undefined,
    valid_from_seq: e.valid_from_seq,
    retracted_at: e.retracted_at || null,
  }));

  // 折叠节点参与的 requires 边：全量列出（不折叠依赖信息；§9.2/§15.3）
  const folded_dependencies = allEdges
    .filter(
      (e) =>
        e.relation_type === "requires" &&
        !e.retracted_at &&
        (foldedIds.has(e.from_id) || foldedIds.has(e.to_id)),
    )
    .map((e) => ({
      relation_id: e.id,
      from: endpointStatus(db, projectId, e.from_id, false),
      to: endpointStatus(db, projectId, e.to_id, false),
      requires_state: e.requires_state || "",
      conditions: e.conditions,
      valid_from_seq: e.valid_from_seq,
      note: "折叠分支的前提边仍参与依赖、范围、订阅与恢复检查（§15.3；§20.3 场景 15）",
    }));

  return {
    groups,
    edges,
    edges_total: touchingTotal,
    edges_omitted: Math.max(0, touchingTotal - assetEdges.length),
    folded_dependencies,
    totals: { assets: assets.length, groups: groups.length, folded_assets: foldedIds.size },
    folding: {
      fold_since: foldingActive ? foldSince : null,
      rule:
        "activity_seq < fold_since（自该边界以来无活动）的资产折叠为计数桶；activity_seq = 资产创建、触及该资产的边、挂载漏洞、关联采集中最近一次的提交序号",
    },
  };
}

/* ── asset_map 接口模板维度（蓝图 §d-10 M2 增量；§7.2 模板是可修正判断） ── */

/**
 * asset_map 快照补 endpoint_templates 分组维度：candidate/confirmed 分列（含
 * 展开样本与计数），split/withdrawn 折叠为计数桶（折叠不删记录，展开入口给出）。
 * 不改动既有折叠/边界语义；模板状态以库为准（§7.2：可确认、拆分或撤回）。
 */
function buildEndpointTemplates(db, projectId) {
  const rows = db
    .prepare("SELECT * FROM endpoint_templates WHERE project_id = ? ORDER BY created_seq, id")
    .all(projectId);
  const listed = rows.filter((r) => r.status === "candidate" || r.status === "confirmed");
  const folded = rows.filter((r) => r.status === "split" || r.status === "withdrawn");
  const itemCount = (r) => ({
    id: r.id,
    method: r.method,
    service_asset_id: r.service_asset_id,
    path_template: r.path_template,
    confidence: r.confidence || null,
    created_seq: r.created_seq,
  });
  const byStatus = {};
  for (const status of ["candidate", "confirmed"]) {
    const list = listed.filter((r) => r.status === status);
    byStatus[status] = {
      total: list.length,
      items: list.slice(0, LIMITS.sample_ids).map(itemCount),
      omitted: Math.max(0, list.length - LIMITS.sample_ids),
    };
  }
  const foldedCounts = { split: 0, withdrawn: 0 };
  for (const r of folded) foldedCounts[r.status] = (foldedCounts[r.status] ?? 0) + 1;
  return {
    total: rows.length,
    by_status: byStatus,
    folded: { ...foldedCounts, note: "split/withdrawn 模板折叠为计数（折叠不删记录，§15.1）" },
    expand: {
      how: "逐条经 GET /sorne/records/{id} 展开（T- 编号）；样本超出上限以计数标明，不静默截断（§15.4）",
    },
    note: "接口模板是候选接口族（§7.2）：模板可信状态可确认/拆分/撤回；原始采集与路径来源保留，不因模板合并丢失",
  };
}

/* ── exploration_map（§15.1：探索方向、依据、漏洞与未解决问题） ───── */

function intentBrief(row) {
  return {
    id: row.id,
    question: row.question,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    target_asset_ids: parseJson(row.target_asset_ids, []),
    basis_refs: parseJson(row.basis_refs, []),
    prerequisite_refs: parseJson(row.prerequisite_refs, []),
    updated_seq: row.updated_seq || row.created_seq,
  };
}

function boundList(items, limit, section) {
  const kept = items.slice(0, limit);
  const omitted = items.length - kept.length;
  return {
    items: kept,
    count: items.length,
    omitted,
    omitted_note: omitted > 0 ? `仅列前 ${limit} 条，其余 ${omitted} 条经 GET /sorne/records/{id} 按编号展开（§15.4）` : undefined,
    section,
  };
}

function buildExplorationMap(db, projectId) {
  const goals = db
    .prepare("SELECT * FROM goals WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId);
  const intents = db
    .prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId);
  const byGoal = new Map(goals.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const it of intents) {
    if (it.goal_id && byGoal.has(it.goal_id)) byGoal.get(it.goal_id).push(intentBrief(it));
    else ungrouped.push(intentBrief(it));
  }
  const directions = goals.map((g) => ({
    goal_id: g.id,
    statement: g.statement,
    status: g.status,
    intents: byGoal.get(g.id),
  }));

  const hypotheses = db
    .prepare("SELECT * FROM hypotheses WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId)
    .map((h) => ({ id: h.id, statement: h.statement, status: h.status, evidence_revision: h.evidence_revision }));
  const facts = db
    .prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId)
    .map((f) => ({ id: f.id, statement: f.statement, status: f.status }));
  const vulnerabilities = db
    .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId)
    .map((v) => ({
      id: v.id,
      category: v.category,
      asset_id: v.asset_id,
      location: v.location,
      status: v.status,
      review: v.review,
      evidence_revision: v.evidence_revision,
    }));

  const includedIds = new Set([
    ...intents.map((i) => i.id),
    ...goals.map((g) => g.id),
    ...hypotheses.map((h) => h.id),
    ...facts.map((f) => f.id),
    ...vulnerabilities.map((v) => v.id),
  ]);
  const allEdges = db
    .prepare("SELECT * FROM relations WHERE project_id = ? ORDER BY valid_from_seq, rowid")
    .all(projectId)
    .filter((e) => includedIds.has(e.from_id) || includedIds.has(e.to_id));
  const edges = allEdges.slice(0, LIMITS.exploration_edges).map((e) => ({
    id: e.id,
    from: e.from_id,
    to: e.to_id,
    relation_type: e.relation_type,
    requires_state: e.requires_state || undefined,
    valid_from_seq: e.valid_from_seq,
    retracted_at: e.retracted_at || null,
  }));

  const blockedIntents = intents.filter((i) => i.status === "blocked" || i.status === "deferred");
  const openHypotheses = hypotheses.filter((h) => h.status === "open" || h.status === "testing");
  const suspected = vulnerabilities.filter((v) => v.status === "suspected" || v.status === "inconclusive");

  return {
    directions,
    ungrouped_intents: ungrouped,
    judgements: {
      hypotheses: boundList(hypotheses, LIMITS.exploration_nodes, "hypotheses"),
      facts: boundList(facts, LIMITS.exploration_nodes, "facts"),
      vulnerabilities: boundList(vulnerabilities, LIMITS.exploration_nodes, "vulnerabilities"),
    },
    unresolved: {
      // §15.1「未解决问题」：开放假设、受阻意图、疑似漏洞、待验证任务
      open_hypotheses: idList(openHypotheses.map((h) => h.id), LIMITS.sample_ids * 5),
      blocked_intents: blockedIntents.slice(0, LIMITS.sample_ids * 5).map((i) => ({
        id: i.id,
        question: i.question,
        status: i.status,
        resume_conditions: parseJson(i.resume_conditions, []),
      })),
      blocked_intents_count: blockedIntents.length,
      suspected_vulnerabilities: idList(suspected.map((v) => v.id), LIMITS.sample_ids * 5),
      pending_verification_jobs: db
        .prepare(
          "SELECT COUNT(*) AS c FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress')",
        )
        .get(projectId).c,
    },
    edges,
    edges_total: allEdges.length,
    edges_omitted: Math.max(0, allEdges.length - LIMITS.exploration_edges),
    omitted_note:
      allEdges.length > LIMITS.exploration_edges
        ? `关系边仅列前 ${LIMITS.exploration_edges} 条，其余 ${allEdges.length - LIMITS.exploration_edges} 条按编号经 /sorne/records/{id} 展开`
        : undefined,
  };
}

/* ── planner_view（§15.3 七要素） ─────────────────────────────────── */

function lastAcceptedPlanBaseline(db, projectId) {
  return (
    db
      .prepare(
        `SELECT id, plan_run_id, revision, created_seq FROM plan_revisions
          WHERE project_id = ? AND received_status = 'accepted'
          ORDER BY created_seq DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) || null
  );
}

function buildPlannerView(db, projectId, foldSince) {
  const skeleton = buildAssetSkeleton(db, projectId, foldSince);
  skeleton.tech_stack = buildTechStack(
    db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq, rowid").all(projectId),
  );

  const intents = db
    .prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY priority DESC, created_seq, rowid")
    .all(projectId);
  const brief = (i, extra = {}) => ({
    id: i.id,
    question: i.question,
    kind: i.kind,
    status: i.status,
    priority: i.priority,
    target_asset_ids: parseJson(i.target_asset_ids, []),
    basis_refs: parseJson(i.basis_refs, []),
    budget: parseJson(i.budget, {}),
    updated_seq: i.updated_seq || i.created_seq,
    ...extra,
  });
  const active = intents
    .filter((i) => ["proposed", "queued", "running", "awaiting_review"].includes(i.status))
    .map((i) => brief(i));
  const blocked = intents
    .filter((i) => ["blocked", "deferred"].includes(i.status))
    .map((i) => brief(i, { resume_conditions: parseJson(i.resume_conditions, []) }));
  const foldedHistory = {};
  for (const st of ["resolved", "obsolete", "cancelled"]) {
    foldedHistory[st] = intents.filter((i) => i.status === st).length;
  }

  const vulnerabilities = db
    .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? ORDER BY created_seq, rowid")
    .all(projectId);
  const confirmed = vulnerabilities
    .filter((v) => v.status === "confirmed")
    .map((v) => ({
      id: v.id,
      category: v.category,
      asset_id: v.asset_id,
      review: v.review,
      confirmed_version: v.confirmed_version,
      evidence_revision: v.evidence_revision,
      updated_seq: v.updated_seq || v.created_seq,
      note: "confirmed 只说明在指定条件下得到确认，不代表持续存在（§8.2）",
    }));
  const suspected = vulnerabilities
    .filter((v) => v.status === "suspected" || v.status === "inconclusive")
    .map((v) => ({ id: v.id, category: v.category, asset_id: v.asset_id, status: v.status, review: v.review }));
  const testingHypotheses = db
    .prepare(
      "SELECT * FROM hypotheses WHERE project_id = ? AND status IN ('testing','open') ORDER BY created_seq, rowid",
    )
    .all(projectId)
    .map((h) => ({ id: h.id, statement: h.statement, status: h.status, evidence_revision: h.evidence_revision }));
  const verificationJobs = db
    .prepare(
      "SELECT id, subject_id, subject_kind, status FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress') ORDER BY created_seq",
    )
    .all(projectId);

  // 覆盖缺口：未被观察/未被指向的资产、无尝试的意图、范围待判定资产
  // （§19 反「资产挂过一个 Fact 就已测」；此处为程序可判定信号，取舍由 Planner 决定 §3.2）
  const observedAssetIds = new Set(
    db
      .prepare(
        `SELECT DISTINCT r.to_id AS asset_id FROM relations r
          WHERE r.project_id = ? AND r.relation_type = 'targets' AND r.retracted_at IS NULL
            AND r.to_id IN (SELECT id FROM assets WHERE project_id = ?)`,
      )
      .all(projectId, projectId)
      .map((x) => x.asset_id),
  );
  const targetedAssetIds = new Set();
  for (const it of intents) {
    for (const id of parseJson(it.target_asset_ids, [])) targetedAssetIds.add(id);
  }
  const allAssets = db.prepare("SELECT id FROM assets WHERE project_id = ?").all(projectId).map((a) => a.id);
  const scopePending = db
    .prepare("SELECT id FROM assets WHERE project_id = ? AND scope_status = 'pending'")
    .all(projectId)
    .map((a) => a.id);
  const unobserved = allAssets.filter((id) => !observedAssetIds.has(id));
  const untargeted = allAssets.filter((id) => !targetedAssetIds.has(id) && !observedAssetIds.has(id));
  const intentsWithoutAttempts = intents.filter(
    (i) =>
      db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND intent_id = ?").get(projectId, i.id).c ===
      0,
  );

  // 预算：程序供给用量数据；预算语义与方向取舍属 Planner（§16.3，不写死）
  const directionsBudget = [];
  for (const i of intents) {
    const attempts = db
      .prepare("SELECT id FROM attempts WHERE project_id = ? AND intent_id = ? ORDER BY created_seq")
      .all(projectId, i.id);
    let toolCalls = 0;
    let unknownCalls = 0;
    if (attempts.length > 0) {
      const placeholders = attempts.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND attempt_id IN (${placeholders}) GROUP BY status`,
        )
        .all(projectId, ...attempts.map((a) => a.id));
      for (const r of rows) {
        toolCalls += r.c;
        if (r.status === "unknown") unknownCalls += r.c;
      }
    }
    directionsBudget.push({
      intent_id: i.id,
      status: i.status,
      budget: parseJson(i.budget, {}),
      attempts: attempts.length,
      tool_calls: toolCalls,
      unknown_tool_calls: unknownCalls,
    });
  }
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);

  // 自上次已接收规划以来的变化（§15.3；Planner 只确认自己输入边界内的事件 §16.1）
  const baseline = lastAcceptedPlanBaseline(db, projectId);
  const sinceSeq = baseline ? baseline.created_seq : 0;
  const eventCountsRows = db
    .prepare(
      "SELECT event_type, COUNT(*) AS c FROM outbox WHERE project_id = ? AND commit_seq > ? GROUP BY event_type ORDER BY event_type",
    )
    .all(projectId, sinceSeq);
  const recentEvents = db
    .prepare(
      `SELECT event_id, commit_seq, event_index, event_type, subject_ids FROM outbox
        WHERE project_id = ? AND commit_seq > ? ORDER BY commit_seq, event_index LIMIT ?`,
    )
    .all(projectId, sinceSeq, LIMITS.recent_events);
  const totalEvents = eventCountsRows.reduce((sum, r) => sum + r.c, 0);

  const projectContext = buildProjectContext(db, projectId);
  return {
    project_context: projectContext,
    asset_skeleton: skeleton,
    directions: {
      active,
      blocked,
      folded_history: {
        counts: foldedHistory,
        note: "已解决/废弃/取消的意图只保留计数，明细经 GET /sorne/records/{id} 读取",
      },
    },
    awaiting_verification: {
      suspected_vulnerabilities: suspected,
      testing_or_open_hypotheses: testingHypotheses,
      pending_verification_jobs: verificationJobs,
    },
    confirmed_vulnerabilities: confirmed,
    coverage_gaps: {
      unobserved_assets: idList(unobserved, LIMITS.sample_ids * 5),
      untargeted_assets: idList(untargeted, LIMITS.sample_ids * 5),
      intents_without_attempts: idList(intentsWithoutAttempts.map((i) => i.id), LIMITS.sample_ids * 5),
      scope_pending_assets: idList(scopePending, LIMITS.sample_ids * 5),
      note: "覆盖度不能简化为「资产挂过一个 Fact 就已测」（§19）；缺口取舍由 Planner 决定（§3.2）",
    },
    budgets: {
      project_policy: parseJson(project.resource_policy, {}),
      directions: directionsBudget,
      note: "程序供给资源用量与预算字段；探索比例与优先级由 Planner 依据证据调整（§16.3），不写固定流水线",
    },
    changes_since_last_plan: {
      baseline: baseline
        ? { plan_revision_id: baseline.id, revision: baseline.revision, commit_seq: baseline.created_seq }
        : null,
      since_commit_seq: sinceSeq,
      event_counts: Object.fromEntries(eventCountsRows.map((r) => [r.event_type, r.c])),
      total_events: totalEvents,
      recent_events: recentEvents.map((e) => ({
        event_id: e.event_id,
        commit_seq: e.commit_seq,
        event_index: e.event_index,
        event_type: e.event_type,
        subject_ids: parseJson(e.subject_ids, []),
      })),
      recent_events_omitted: Math.max(0, totalEvents - recentEvents.length),
      note: baseline
        ? "基线为最近一次 received_status=accepted 的计划修订边界；其后事件构成自上次规划以来的变化"
        : "尚无已接收计划修订（received_status=accepted），自项目起点起算全部变化；完整变化流经 GET /sorne/changes（B2）读取",
    },
    folded_dependencies: skeleton.folded_dependencies,
  };
}

/* ── Worker 视图（§15.4：1–2 跳 + 强制项 + 超预算分层） ───────────── */

function collectNeighbors(db, projectId, seeds, hops) {
  const nodeHop = new Map();
  for (const s of seeds) nodeHop.set(s, 0);
  let frontier = [...seeds];
  const edges = [];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const placeholders = frontier.map(() => "?").join(",");
    const found = db
      .prepare(
        `SELECT * FROM relations WHERE project_id = ? AND retracted_at IS NULL
          AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`,
      )
      .all(projectId, ...frontier, ...frontier);
    for (const e of found) edges.push(e);
    const next = [];
    for (const e of found) {
      // 无向扩展：取尚未入图的一端（found 保证至少一端在 frontier 内）
      const target = nodeHop.has(e.from_id) ? e.to_id : e.from_id;
      if (!nodeHop.has(target)) {
        nodeHop.set(target, hop);
        next.push(target);
      }
    }
    frontier = next;
  }
  return { nodeHop, edges };
}

function buildWorkerView(db, projectId, intentRow, { hops, budgetChars }) {
  const notProvided = [];
  const noteWithheld = (section, count, what, readVia, extraNote) => {
    notProvided.push({
      section,
      withheld: what,
      count,
      read_via: readVia,
      note: extraNote || "超出上下文预算，本层未提供该项内容；「未显示」不代表「不存在」（§15.4）",
    });
  };

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  const scope = project.current_scope_revision
    ? db.prepare("SELECT * FROM scope_revisions WHERE id = ?").get(project.current_scope_revision)
    : null;

  // 种子：意图 + 目标资产 + 目标 goal；1–2 跳无向邻居（visited 与规模限制，§9.2）
  const seeds = new Set([intentRow.id]);
  for (const id of parseJson(intentRow.target_asset_ids, [])) seeds.add(id);
  if (intentRow.goal_id) seeds.add(intentRow.goal_id);
  const { nodeHop, edges: neighborEdges } = collectNeighbors(db, projectId, [...seeds], hops);

  const nodes = [...nodeHop.keys()];
  if (nodes.length > LIMITS.worker_nodes) {
    noteWithheld(
      "neighbors.nodes",
      nodes.length - LIMITS.worker_nodes,
      "超出闭包规模上限的邻居节点（含其关联内容）",
      "GET /sorne/records/{id} 逐节点读取，或减小 hops",
    );
  }
  const visibleNodes = nodes.slice(0, LIMITS.worker_nodes);
  const visibleSet = new Set(visibleNodes);
  const nodesView = visibleNodes.map((id) => ({ id, kind: kindOfId(db, projectId, id, null), hop: nodeHop.get(id) }));

  // 强制项 1：当前目标、范围版本和执行约束（§15.4）
  const projectContext = buildProjectContext(db, projectId);
  const goal = intentRow.goal_id
    ? db.prepare("SELECT * FROM goals WHERE project_id = ? AND id = ?").get(projectId, intentRow.goal_id)
    : null;
  const target_and_scope = {
    project: {
      id: projectContext.project_id,
      name: projectContext.name,
      task: projectContext.task,
      description: projectContext.description,
      goal: projectContext.goal,
      goal_source: projectContext.goal_source,
      goal_missing: projectContext.goal_missing,
      goal_note: projectContext.goal_note,
      status: projectContext.status,
      resource_policy: projectContext.resource_policy,
    },
    intent: {
      id: intentRow.id,
      question: intentRow.question,
      rationale: intentRow.rationale,
      kind: intentRow.kind,
      target_asset_ids: parseJson(intentRow.target_asset_ids, []),
      basis_refs: parseJson(intentRow.basis_refs, []),
      condition_requirements: parseJson(intentRow.condition_requirements, []),
      success_criteria: intentRow.success_criteria,
      deliverables: parseJson(intentRow.deliverables, []),
      priority: intentRow.priority,
      budget: parseJson(intentRow.budget, {}),
      status: intentRow.status,
      state_version: intentRow.state_version,
    },
    goal: goal ? { id: goal.id, statement: goal.statement, status: goal.status } : null,
    scope: scope
      ? { scope_revision_id: scope.id, revision: scope.revision, rules: parseJson(scope.rules, {}), summary: scope.summary, configured: true }
      : {
          scope_revision_id: null,
          configured: false,
          note: "尚未配置范围版本；缺少目标范围不得默认任意目标均可操作（§17）",
        },
    resource_limits: projectContext.resource_policy,
    project_status: project.status,
  };

  // 强制项 2：当前动作必须满足的前提——即使超出默认跳数（§15.4/§9.1）
  const allRequires = db
    .prepare(
      `SELECT * FROM relations WHERE project_id = ? AND relation_type = 'requires'
        AND (from_id IN (SELECT id FROM intents WHERE project_id = ?)
          OR to_id IN (SELECT id FROM intents WHERE project_id = ?)
          OR from_id IN (SELECT id FROM assets WHERE project_id = ?)
          OR to_id IN (SELECT id FROM assets WHERE project_id = ?))
        ORDER BY valid_from_seq, rowid`,
    )
    .all(projectId, projectId, projectId, projectId, projectId)
    .filter((e) => visibleSet.has(e.from_id) || visibleSet.has(e.to_id));
  const prerequisites = allRequires.slice(0, LIMITS.prerequisites).map((e) => ({
    relation_id: e.id,
    from: endpointStatus(db, projectId, e.from_id, visibleSet.has(e.from_id)),
    to: endpointStatus(db, projectId, e.to_id, visibleSet.has(e.to_id)),
    requires_state: e.requires_state || "",
    conditions: e.conditions,
    valid_from_seq: e.valid_from_seq,
    retracted_at: e.retracted_at || null,
    note: "前提检查以库内状态为准（§9.1 requires 注明需要的状态与适用条件）；动作前重查属执行侧（§9.2）",
  }));
  if (allRequires.length > LIMITS.prerequisites) {
    noteWithheld(
      "prerequisites",
      allRequires.length - LIMITS.prerequisites,
      `超出上限的 requires 边（已列 ${LIMITS.prerequisites} 条）`,
      "GET /sorne/records/{id} 逐边读取",
    );
  }
  // §10.1 prerequisite_refs：意图合同声明的必要前提，逐个取当前状态（可超跳数）
  const prerequisiteRefs = parseJson(intentRow.prerequisite_refs, []).map((id) =>
    endpointStatus(db, projectId, id, visibleSet.has(id)),
  );

  // 强制项 3：涉及身份、条件和环境的必要说明（§15.4）
  const conditionOwners = db
    .prepare(
      `SELECT 'observations' AS t, id, conditions, statement, capture_id FROM observations WHERE project_id = ?
       UNION ALL SELECT 'hypotheses', id, conditions, statement, NULL FROM hypotheses WHERE project_id = ?
       UNION ALL SELECT 'vulnerabilities', id, conditions, category AS statement, NULL FROM vulnerabilities WHERE project_id = ?`,
    )
    .all(projectId, projectId, projectId)
    .filter((r) => visibleSet.has(r.id));
  const recordConditions = [];
  for (const owner of conditionOwners) {
    const conds = parseJson(owner.conditions, []);
    if (conds.length > 0) {
      recordConditions.push({ id: owner.id, kind: owner.t, conditions: conds, statement: owner.statement });
      if (recordConditions.length >= LIMITS.condition_records) break;
    }
  }
  const captureConditionSnapshots = db
    .prepare(
      `SELECT c.id, c.condition_snapshot_id, c.request_url_exact, c.method FROM captures c
        WHERE c.project_id = ? AND c.condition_snapshot_id IS NOT NULL
          AND c.id IN (SELECT capture_id FROM observations WHERE project_id = ? AND capture_id IS NOT NULL)`,
    )
    .all(projectId, projectId)
    .filter((c) =>
      db
        .prepare("SELECT id FROM observations WHERE project_id = ? AND capture_id = ?")
        .all(projectId, c.id)
        .some((o) => visibleSet.has(o.id)),
    );

  // 强制项 4：关键撤回、争议和范围变化（§15.4）
  const retractedInView = db
    .prepare(
      `SELECT id, from_id, to_id, relation_type, retracted_at FROM relations
        WHERE project_id = ? AND retracted_at IS NOT NULL ORDER BY retracted_at DESC LIMIT 200`,
    )
    .all(projectId)
    .filter((e) => visibleSet.has(e.from_id) || visibleSet.has(e.to_id))
    .map((e) => ({ ...e, note: "撤回保留历史，不自动撤销下游（§9.1）" }));
  const disputedVulns = db
    .prepare("SELECT id, status, review FROM vulnerabilities WHERE project_id = ? AND review != 'clear'")
    .all(projectId)
    .filter((v) => visibleSet.has(v.id))
    .map((v) => ({ id: v.id, status: v.status, review: v.review, note: "复核状态独立于结论状态（§8.2）" }));
  const disputedFacts = db
    .prepare("SELECT id, status FROM facts WHERE project_id = ? AND status IN ('disputed','superseded')")
    .all(projectId)
    .filter((f) => visibleSet.has(f.id));
  const scopeHistory = db
    .prepare(
      "SELECT id, revision, summary, created_seq FROM scope_revisions WHERE project_id = ? ORDER BY CAST(revision AS INTEGER) DESC LIMIT 10",
    )
    .all(projectId);

  // 强制项 5：相关尝试、失败原因、待解决问题及证据索引（§15.4）
  const allAttempts = db
    .prepare("SELECT * FROM attempts WHERE project_id = ? AND intent_id = ? ORDER BY created_seq DESC")
    .all(projectId, intentRow.id);
  const attempts = allAttempts.slice(0, LIMITS.attempts);
  if (allAttempts.length > LIMITS.attempts) {
    noteWithheld(
      "attempts_and_failures.attempts",
      allAttempts.length - LIMITS.attempts,
      `更早的执行尝试（已列最近 ${LIMITS.attempts} 条）`,
      "GET /sorne/records/{attempt_id} 逐条读取",
    );
  }
  const attemptIds = attempts.map((a) => a.id);
  let problemToolCalls = [];
  if (attemptIds.length > 0) {
    const placeholders = attemptIds.map(() => "?").join(",");
    problemToolCalls = db
      .prepare(
        `SELECT id, attempt_id, tool_name, status, error FROM tool_calls
          WHERE project_id = ? AND attempt_id IN (${placeholders}) AND status IN ('failed','unknown','running')`,
      )
      .all(projectId, ...attemptIds)
      .slice(0, LIMITS.problem_tool_calls);
  }
  const openQuestions = db
    .prepare("SELECT id, statement, status FROM hypotheses WHERE project_id = ? AND status IN ('open','testing')")
    .all(projectId)
    .filter((h) => visibleSet.has(h.id))
    .slice(0, LIMITS.hypotheses);

  // 证据索引：视图内观察引用的采集与 Blob（编号与入口，不含字节；§15.4）
  const evidenceIndex = [];
  for (const owner of conditionOwners) {
    if (owner.t !== "observations" || !owner.capture_id) continue;
    const cap = db.prepare("SELECT * FROM captures WHERE id = ?").get(owner.capture_id);
    if (!cap) continue;
    let blob = null;
    if (cap.response_body_blob) {
      const b = db.prepare("SELECT * FROM blobs WHERE id = ?").get(cap.response_body_blob);
      if (b) {
        blob = { blob_id: b.id, sha256: b.sha256, representation: b.representation, storage_status: b.storage_status };
      }
    }
    evidenceIndex.push({
      observation_id: owner.id,
      capture_id: cap.id,
      condition_snapshot_id: cap.condition_snapshot_id,
      response_body_blob: blob,
      read_paths: {
        capture: `/sorne/captures/${cap.id}`,
        bytes: blob ? `/sorne/evidence/blobs/${blob.sha256}?project_id=${encodeURIComponent(projectId)}` : null,
      },
    });
    if (evidenceIndex.length >= LIMITS.evidence) break;
  }

  const view = {
    target_and_scope,
    prerequisites,
    prerequisite_refs: prerequisiteRefs,
    identity_conditions: {
      intent_condition_requirements: parseJson(intentRow.condition_requirements, []),
      record_conditions: recordConditions,
      capture_condition_snapshots: captureConditionSnapshots,
      note: "观察来自特定身份/条件时不得推广到其他身份（§18.4）；条件以持久记录为准",
    },
    retractions_disputes_scope_changes: {
      retracted_relations: retractedInView,
      disputed_vulnerabilities: disputedVulns,
      disputed_or_superseded_facts: disputedFacts,
      scope_revisions: scopeHistory,
      current_scope_revision: project.current_scope_revision,
    },
    attempts_and_failures: {
      attempts: attempts.map((a) => ({
        id: a.id,
        worker_id: a.worker_id,
        status: a.status,
        lease_expires_at: a.lease_expires_at,
        recovery_note: a.recovery_note,
      })),
      problem_tool_calls: problemToolCalls,
      problem_tool_calls_note: "unknown 调用先检查现状再决定重试（§10.2）",
    },
    unresolved_questions: openQuestions,
    evidence_index: evidenceIndex,
    evidence_access: {
      note: "原始证据字节按验证或具体执行需要获取，不默认送入模型（§15.4）",
      bytes_path_template: "/sorne/evidence/blobs/{sha256}?project_id={pid}",
    },
    neighbors: {
      hops_used: hops,
      nodes: nodesView,
      edges: neighborEdges.slice(0, LIMITS.exploration_edges).map((e) => ({
        id: e.id,
        from: e.from_id,
        to: e.to_id,
        relation_type: e.relation_type,
        valid_from_seq: e.valid_from_seq,
      })),
      edges_total: neighborEdges.length,
      edges_omitted: Math.max(0, neighborEdges.length - LIMITS.exploration_edges),
      node_cap: LIMITS.worker_nodes,
    },
    not_provided: notProvided,
  };

  // 超预算分层读取：逐层降级，未提供内容必须明示（§15.4）；强制项不参与降级
  const degradeTiers = [
    {
      section: "evidence_index",
      apply(v) {
        const count = v.evidence_index.length;
        v.evidence_index = [];
        return { count, what: "证据索引逐项明细（采集/Blob 编号与读取入口）", read_via: "GET /sorne/records/{observation_id} 或 GET /sorne/captures/{id}" };
      },
    },
    {
      section: "neighbors.edges",
      apply(v) {
        const count = v.neighbors.edges.length;
        v.neighbors.edges = [];
        return { count, what: "邻居关系边明细", read_via: "GET /sorne/records/{id}（relations 含端点）" };
      },
    },
    {
      section: "identity_conditions.record_conditions",
      apply(v) {
        const count = v.identity_conditions.record_conditions.length;
        v.identity_conditions.record_conditions = [];
        return { count, what: "视图内记录的身份/条件明细", read_via: "GET /sorne/records/{id}" };
      },
    },
    {
      section: "attempts_and_failures.problem_tool_calls",
      apply(v) {
        const count = v.attempts_and_failures.problem_tool_calls.length;
        v.attempts_and_failures.problem_tool_calls = [];
        return { count, what: "失败/未知工具调用明细", read_via: "GET /sorne/records/{id}" };
      },
    },
    {
      section: "neighbors.nodes(2跳)",
      apply(v) {
        const before = v.neighbors.nodes.length;
        v.neighbors.nodes = v.neighbors.nodes.filter((n) => n.hop <= 1).slice(0, LIMITS.sample_ids * 3);
        v.neighbors.hops_provided = 1;
        return {
          count: before - v.neighbors.nodes.length,
          what: "第 2 跳邻居节点明细（保留 1 跳内样本）",
          read_via: "GET /sorne/contexts/{intentId}?hops=2 或 GET /sorne/records/{id}",
        };
      },
    },
  ];

  let tierIndex = 0;
  while (JSON.stringify(view).length > budgetChars && tierIndex < degradeTiers.length) {
    const tier = degradeTiers[tierIndex++];
    const meta = tier.apply(view);
    if (meta.count > 0) noteWithheld(tier.section, meta.count, meta.what, meta.read_via);
  }
  if (JSON.stringify(view).length > budgetChars) {
    notProvided.push({
      section: "budget",
      withheld: "按分层降级后仍超出预算的剩余内容",
      count: null,
      read_via: "调大 max_chars 后重新请求本端点",
      note: "强制项（目标/范围/前提/撤回争议）不参与降级；其余未提供内容以本清单明示（§15.4）",
    });
  }
  return view;
}

/* ── Markdown 渲染（§15.1：输出可为 Markdown；仍是派生视图） ───────── */

function mdEscape(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderAssetMapMarkdown(content) {
  const lines = [];
  for (const g of content.groups) {
    lines.push(`## 资产组：${g.asset_type}（共 ${g.total}）`);
    for (const a of g.assets) {
      lines.push(`- ${a.id}｜${mdEscape(a.canonical_key)}｜范围=${a.scope_status}｜活动序号=${a.activity_seq}`);
    }
    if (g.folded) {
      lines.push(
        `- 〔折叠〕长期未变化资产 ${g.folded.count} 个（样本：${g.folded.sample_ids.join("、") || "无"}）；展开：${g.folded.expand.how}`,
      );
    }
  }
  if (content.edges_omitted > 0) {
    lines.push(`> 拓扑边仅列前 ${content.edges.length} 条，另有 ${content.edges_omitted} 条经编号展开。`);
  }
  for (const dep of content.folded_dependencies) {
    lines.push(
      `- 前提（折叠分支）：${dep.relation_id} ${dep.from.id} → ${dep.to.id}（requires_state=${dep.requires_state || "未注明"}）`,
    );
  }
  const techLines = content.tech_stack ? renderTechStackLines(content.tech_stack) : "";
  if (techLines) {
    lines.push("");
    lines.push("## " + techLines.split("\n")[0]);
    lines.push(...techLines.split("\n").slice(1));
  }
  return lines.join("\n");
}

function renderExplorationMapMarkdown(content) {
  const lines = [];
  const groups = [
    ...content.directions,
    { goal_id: null, statement: "（无目标分组的意图）", intents: content.ungrouped_intents },
  ];
  for (const d of groups) {
    if (d.intents.length === 0) continue;
    lines.push(`## 方向：${d.goal_id ? `${d.goal_id} ${mdEscape(d.statement)}` : d.statement}`);
    for (const i of d.intents) {
      lines.push(`- ${i.id}［${i.status}/${i.kind}］${mdEscape(i.question)}（依据：${i.basis_refs.join("、") || "无"}）`);
    }
  }
  lines.push(
    `## 判断：假设 ${content.judgements.hypotheses.count}／事实 ${content.judgements.facts.count}／漏洞 ${content.judgements.vulnerabilities.count}`,
  );
  for (const v of content.judgements.vulnerabilities.items) {
    lines.push(`- ${v.id}［${v.status}/复核=${v.review}］${mdEscape(v.category)} @ ${v.asset_id ?? "未挂资产"}`);
  }
  lines.push("## 未解决问题");
  lines.push(
    `- 开放假设：${content.unresolved.open_hypotheses.ids.join("、") || "无"}（共 ${content.unresolved.open_hypotheses.count}）`,
  );
  lines.push(
    `- 受阻意图：${content.unresolved.blocked_intents.map((i) => i.id).join("、") || "无"}（共 ${content.unresolved.blocked_intents_count}）`,
  );
  lines.push(
    `- 疑似漏洞：${content.unresolved.suspected_vulnerabilities.ids.join("、") || "无"}（共 ${content.unresolved.suspected_vulnerabilities.count}）`,
  );
  return lines.join("\n");
}

function renderPlannerViewMarkdown(content) {
  const lines = [];
  lines.push("## 活跃方向");
  for (const i of content.directions.active) lines.push(`- ${i.id}［${i.status}］${mdEscape(i.question)}`);
  lines.push("## 受阻方向");
  for (const i of content.directions.blocked) {
    lines.push(`- ${i.id}［${i.status}］${mdEscape(i.question)}（恢复条件 ${i.resume_conditions.length} 项）`);
  }
  lines.push(
    `## 等待验证：疑似漏洞 ${content.awaiting_verification.suspected_vulnerabilities.length}／待验假设 ${content.awaiting_verification.testing_or_open_hypotheses.length}／验证任务 ${content.awaiting_verification.pending_verification_jobs.length}`,
  );
  lines.push(`## 确认漏洞：${content.confirmed_vulnerabilities.length}`);
  for (const v of content.confirmed_vulnerabilities) lines.push(`- ${v.id}［复核=${v.review}］${mdEscape(v.category)}`);
  lines.push("## 覆盖缺口");
  const gaps = content.coverage_gaps;
  lines.push(
    `- 未观察资产 ${gaps.unobserved_assets.count}／未指向资产 ${gaps.untargeted_assets.count}／无尝试意图 ${gaps.intents_without_attempts.count}／范围待判定 ${gaps.scope_pending_assets.count}`,
  );
  lines.push("## 自上次规划以来的变化");
  const ch = content.changes_since_last_plan;
  lines.push(`- 基线：${ch.baseline ? `${ch.baseline.plan_revision_id}@${ch.baseline.commit_seq}` : "无已接收计划"}；事件共 ${ch.total_events} 条`);
  for (const [type, c] of Object.entries(ch.event_counts)) lines.push(`- ${type}: ${c}`);
  return lines.join("\n");
}

function renderWorkerMarkdown(view) {
  const lines = [];
  const t = view.target_and_scope;
  lines.push(`## 任务：${t.intent.id} ${mdEscape(t.intent.question)}`);
  lines.push(`- 状态=${t.intent.status}；项目状态=${t.project_status}；范围=${t.scope.revision ?? "未配置"}`);
  lines.push(`## 前提（${view.prerequisites.length}）`);
  for (const p of view.prerequisites) {
    lines.push(
      `- ${p.relation_id}：${p.from.id}${p.from.status ? `(${p.from.status})` : ""} requires ${p.requires_state || "未注明"} → ${p.to.id}${p.to.status ? `(${p.to.status})` : ""}${p.retracted_at ? "〔已撤回〕" : ""}`,
    );
  }
  if (view.not_provided.length > 0) {
    lines.push("## 未提供（分层读取）");
    for (const n of view.not_provided) {
      lines.push(`- ${n.section}：${n.withheld}${n.count != null ? `（${n.count} 项）` : ""}；读取：${n.read_via}`);
    }
  }
  return lines.join("\n");
}

/* ── 快照持久化（§5.2 maps/；快照为派生资料，可完全重建） ──────────── */

function allocateSnapshotSeq(db, projectId) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, 'snapshot', 2) ON CONFLICT DO NOTHING",
  ).run(projectId);
  const row = db
    .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = 'snapshot'")
    .get(projectId);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = 'snapshot'").run(
    row.n + 1,
    projectId,
  );
  return row.n;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function writeAtomic(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, filePath);
}

/** 写 maps/snapshots/<id>/content.json + map.md，并更新最新入口；临时文件 + 原子改名。 */
function writeSnapshotFiles(dataDir, projectId, snapshotId, kind, envelope) {
  const baseDir = projectDir(dataDir, projectId);
  const snapshotDir = join(baseDir, "maps", "snapshots", snapshotId);
  mkdirSync(snapshotDir, { recursive: true });
  const contentPath = join(snapshotDir, "content.json");
  const mapPath = join(snapshotDir, "map.md");
  writeAtomic(contentPath, JSON.stringify(envelope, null, 2));
  writeAtomic(
    mapPath,
    `# ${kind} 快照 ${snapshotId}\n\n边界 commit_seq=${envelope.snapshot_commit_seq}（内容覆盖至 ${envelope.content_commit_seq}）\n\n${envelope.markdown}\n`,
  );
  const latestName =
    kind === "asset_map"
      ? "asset-map.md"
      : kind === "exploration_map"
        ? "exploration-map.md"
        : kind === "planner_view"
          ? "planner-view.md"
          : null;
  if (latestName) {
    writeAtomic(
      join(baseDir, "maps", latestName),
      `# ${kind} 最新视图\n\n> 快照 ${envelope.snapshot_id}｜边界 commit_seq=${envelope.snapshot_commit_seq}｜生成于 ${envelope.generated_at}\n> 本文件是可重建的派生视图（§15.1），不是事实源；最新快照经 GET /sorne/snapshots/${kind} 获取。\n\n${envelope.markdown}\n`,
    );
  }
  return {
    snapshot_dir: relative(dataDir, snapshotDir),
    content_file: relative(dataDir, contentPath),
    map_file: relative(dataDir, mapPath),
    latest_file: latestName ? relative(dataDir, join(baseDir, "maps", latestName)) : null,
  };
}

function insertSnapshotRow(db, { snapshotId, projectId, kind, scopeJson, snapshotCommitSeq, contentFile, foldingNotesJson, generatedAt, actor }) {
  db.prepare(
    `INSERT INTO snapshots (id, project_id, kind, scope, snapshot_commit_seq, content_ref,
       schema_version, folding_notes, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshotId,
    projectId,
    kind,
    scopeJson,
    snapshotCommitSeq,
    contentFile,
    SNAPSHOT_SCHEMA_VERSION,
    foldingNotesJson,
    generatedAt,
    actor || "projection",
    snapshotCommitSeq, // 快照是派生资料：created_seq 记录其生成依据的提交边界
  );
}

/* ── 对外入口：生成快照（§15.1/§15.2）与任务上下文（§15.4） ────────── */

/**
 * GET /snapshots/{kind} 主体。
 * 顺序（§15.2 无间隙的关键）：先建立/更新订阅边界得 S，再在一致读视图内生成内容——
 * 内容必包含全部 ≤ S 的提交；S 之后的增量由事件重放补齐（重放与内容可能重叠，
 * 由消费端幂等处理，不产生间隙）。
 */
export async function generateSnapshot(pctx, { projectId, kind, foldSince, actor }) {
  const normalizedKind = normalizeSnapshotKind(kind);
  if (normalizedKind === "context") {
    throw apiError("BAD_REQUEST", "kind=context 的快照经 GET /sorne/contexts/{intentId} 生成（§15.4）");
  }
  const store = await getStore(pctx);
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw apiError("NOT_FOUND", `项目不存在：${projectId}`);
  }

  const fold =
    foldSince === undefined || foldSince === null
      ? null
      : clampInt(foldSince, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: null });

  // 1) 订阅边界（§2.7 冻结签名；B1 不直接写 subscriptions 表）
  const boundary = await openBoundary(pctx, {
    projectId,
    focus: { kind: normalizedKind, fold_since: fold },
    scope: { fold_since: fold },
  });
  const hasBoundary = Boolean(boundary && boundary.subscription_id);
  const boundaryS = hasBoundary && Number.isInteger(boundary.snapshot_commit_seq) ? boundary.snapshot_commit_seq : null;

  // 2) 一致读视图内生成内容（纯读事务，§15.1）
  const prepared = readView(store, (db) => ({
    contentCommitSeq: currentCommitSeq(db, projectId),
    content:
      normalizedKind === "asset_map"
        ? { ...buildAssetSkeleton(db, projectId, fold), endpoint_templates: buildEndpointTemplates(db, projectId), tech_stack: buildTechStack(db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_seq, rowid").all(projectId)) }
        : normalizedKind === "exploration_map"
          ? buildExplorationMap(db, projectId)
          : buildPlannerView(db, projectId, fold),
  }));

  // S 取边界值；边界不可用时以内容读视图高水位充当（同视图内自洽，无间隙）
  const snapshotCommitSeq = boundaryS ?? prepared.contentCommitSeq;
  if (boundaryS !== null && prepared.contentCommitSeq < boundaryS) {
    // 防御：内容视图若早于边界（边界先于内容的顺序下理论不可达）则拒绝发布，防间隙
    throw apiError(
      "INTERNAL_ERROR",
      `一致读视图(${prepared.contentCommitSeq})早于订阅边界(${boundaryS})，拒绝发布快照以防间隙`,
    );
  }

  // 3) 分配快照编号（独立小事务；失败只留下可识别的序列空洞）
  const seq = await store.runSerial((db) => allocateSnapshotSeq(db, projectId));
  const snapshotId = `SNAP-${projectId}-${pad4(seq)}`;
  const generatedAt = new Date().toISOString();
  const foldingNotes = buildFoldingNotes(normalizedKind, prepared.content);
  const markdown =
    normalizedKind === "asset_map"
      ? renderAssetMapMarkdown(prepared.content)
      : normalizedKind === "exploration_map"
        ? renderExplorationMapMarkdown(prepared.content)
        : renderPlannerViewMarkdown(prepared.content);

  const envelope = {
    kind: normalizedKind,
    snapshot_id: snapshotId,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot_commit_seq: snapshotCommitSeq,
    content_commit_seq: prepared.contentCommitSeq,
    generated_at: generatedAt,
    projection_scope: {
      project_id: projectId,
      fold_since: fold,
      limits: { edges: LIMITS.edges, exploration_nodes: LIMITS.exploration_nodes, recent_events: LIMITS.recent_events },
    },
    folding_notes: foldingNotes,
    content: prepared.content,
    markdown,
  };

  // 4) 文件先落盘（maps/），再登记 snapshots 行；登记失败只留可识别的孤立文件
  let files;
  try {
    files = writeSnapshotFiles(pctx.dataDir, projectId, snapshotId, normalizedKind, envelope);
  } catch (error) {
    const code = error && (error.code === "ENOSPC" || error.code === "EDQUOT") ? "RESOURCE_LIMIT" : "INTERNAL_ERROR";
    throw apiError(code, `快照文件写入失败，不发布半成品快照：${error?.message ?? error}`, {
      retryable: code === "RESOURCE_LIMIT",
      detail: { snapshot_id: snapshotId },
    });
  }
  await store.runSerial((db) => {
    insertSnapshotRow(db, {
      snapshotId,
      projectId,
      kind: normalizedKind,
      scopeJson: JSON.stringify({ fold_since: fold }),
      snapshotCommitSeq,
      contentFile: files.content_file,
      foldingNotesJson: JSON.stringify(foldingNotes),
      generatedAt,
      actor,
    });
  });

  return {
    ...envelope,
    rebuild: {
      note: "本快照为派生视图，可由持久记录完全重建（§15.1/§21 阶段 B）",
      rebuild_command: `GET /sorne/snapshots/${normalizedKind}?project_id=${encodeURIComponent(projectId)}`,
    },
    files,
    current_commit_seq: currentCommitSeq(store.db, projectId),
    subscription: hasBoundary
      ? {
          available: true,
          subscription_id: boundary.subscription_id,
          subscription_revision: boundary.subscription_revision,
          resume_cursor: boundary.resume_cursor ?? String(snapshotCommitSeq),
          snapshot_commit_seq: boundaryS,
          note: "后续从 snapshot_commit_seq 之后重放事件（GET /sorne/changes，B2），快照+增量无间隙（§15.2）",
        }
      : {
          available: false,
          reason:
            "订阅边界服务（B2 openSubscriptionBoundary，蓝图 §2.7 冻结签名）尚未实装；快照边界仍一致（S=内容读视图高水位），事件重放边界待 B2 接入",
        },
  };
}

function buildFoldingNotes(kind, content) {
  const notes = [];
  if (kind === "asset_map" || kind === "planner_view") {
    if (content.edges_omitted > 0) {
      notes.push({
        section: "edges",
        omitted: content.edges_omitted,
        how_to_expand: "关系边经 GET /sorne/records/{id} 按编号展开",
      });
    }
    const folded = (content.groups || []).filter((g) => g.folded);
    if (folded.length > 0) {
      notes.push({
        section: "folded_assets",
        groups: folded.length,
        total_folded: folded.reduce((s, g) => s + g.folded.count, 0),
        how_to_expand: "提高 fold_since 参数重新请求快照，或经 GET /sorne/records/{id} 读取单个资产",
        note: "折叠只影响展示；折叠节点仍参与依赖、范围、订阅和恢复检查（§15.3）",
      });
    }
    if ((content.folded_dependencies || []).length > 0) {
      notes.push({
        section: "folded_dependencies",
        count: content.folded_dependencies.length,
        note: "折叠分支上的 requires 前提边全量列出（§20.3 场景 15：折叠分支的前提失效仍触发依赖处理）",
      });
    }
  }
  if (kind === "exploration_map" && content.edges_omitted > 0) {
    notes.push({
      section: "edges",
      omitted: content.edges_omitted,
      how_to_expand: "关系边经 GET /sorne/records/{id} 按编号展开",
    });
  }
  return notes;
}

/**
 * GET /contexts/{intentId} 主体（§11.2 任务快照与必要约束；§15.4 Worker 视图）。
 * 同样先建订阅边界（focus=本意图），再一致读视图生成内容。
 */
export async function generateWorkerContext(pctx, { projectId, intentId, hops, maxChars, actor }) {
  const store = await getStore(pctx);
  if (!store.db.prepare("SELECT 1 FROM intents WHERE project_id = ? AND id = ?").get(projectId, intentId)) {
    throw apiError("NOT_FOUND", `项目 ${projectId} 内不存在意图：${intentId}`, {
      detail: { intent_id: intentId },
    });
  }
  const usedHops = clampInt(hops, { min: 1, max: 2, fallback: 2 });
  const budget = clampInt(maxChars, { min: MIN_WORKER_BUDGET_CHARS, max: 2_000_000, fallback: DEFAULT_WORKER_BUDGET_CHARS });

  const boundary = await openBoundary(pctx, {
    projectId,
    focus: { kind: "intent", intent_id: intentId, hops: usedHops },
    scope: { intent_id: intentId, hops: usedHops },
  });
  const hasBoundary = Boolean(boundary && boundary.subscription_id);
  const boundaryS = hasBoundary && Number.isInteger(boundary.snapshot_commit_seq) ? boundary.snapshot_commit_seq : null;

  const prepared = readView(store, (db) => {
    const fresh = db.prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?").get(projectId, intentId);
    return {
      view: buildWorkerView(db, projectId, fresh, { hops: usedHops, budgetChars: budget }),
      contentCommitSeq: currentCommitSeq(db, projectId),
    };
  });

  const snapshotCommitSeq = boundaryS ?? prepared.contentCommitSeq;
  if (boundaryS !== null && prepared.contentCommitSeq < boundaryS) {
    throw apiError(
      "INTERNAL_ERROR",
      `一致读视图(${prepared.contentCommitSeq})早于订阅边界(${boundaryS})，拒绝发布任务快照以防间隙`,
    );
  }

  const seq = await store.runSerial((db) => allocateSnapshotSeq(db, projectId));
  const snapshotId = `SNAP-${projectId}-${pad4(seq)}`;
  const generatedAt = new Date().toISOString();
  const envelope = {
    kind: "context",
    snapshot_id: snapshotId,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot_commit_seq: snapshotCommitSeq,
    content_commit_seq: prepared.contentCommitSeq,
    generated_at: generatedAt,
    projection_scope: {
      project_id: projectId,
      intent_id: intentId,
      hops: usedHops,
      budget_chars: budget,
      node_cap: LIMITS.worker_nodes,
    },
    worker_view: prepared.view,
    markdown: renderWorkerMarkdown(prepared.view),
    not_provided: prepared.view.not_provided,
  };

  let files;
  try {
    files = writeSnapshotFiles(pctx.dataDir, projectId, snapshotId, "context", envelope);
  } catch (error) {
    const code = error && (error.code === "ENOSPC" || error.code === "EDQUOT") ? "RESOURCE_LIMIT" : "INTERNAL_ERROR";
    throw apiError(code, `任务快照文件写入失败：${error?.message ?? error}`, { retryable: code === "RESOURCE_LIMIT" });
  }
  await store.runSerial((db) => {
    insertSnapshotRow(db, {
      snapshotId,
      projectId,
      kind: "context",
      scopeJson: JSON.stringify({ intent_id: intentId, hops: usedHops, budget_chars: budget }),
      snapshotCommitSeq,
      contentFile: files.content_file,
      foldingNotesJson: JSON.stringify(prepared.view.not_provided),
      generatedAt,
      actor,
    });
  });

  return {
    ...envelope,
    current_commit_seq: currentCommitSeq(store.db, projectId),
    subscription: hasBoundary
      ? {
          available: true,
          subscription_id: boundary.subscription_id,
          subscription_revision: boundary.subscription_revision,
          resume_cursor: boundary.resume_cursor ?? String(snapshotCommitSeq),
          note: "以本意图关注对象为基的订阅边界（§15.5 动态订阅经 B2 扩展）",
        }
      : {
          available: false,
          reason: "订阅边界服务（B2 openSubscriptionBoundary）尚未实装；任务快照边界仍一致，事件重放边界待 B2 接入",
        },
  };
}
