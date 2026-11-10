/**
 * 主动阅读服务（01 号基线 §二至§五、§十、§十三；实施计划阶段 2）。
 *
 * 在 projection.mjs 与 records-read.mjs 之上提供统一的分层导航、搜索、
 * 关系跳转、证据片段读取和持久书签，供四角色（Planner/Orchestrator/Worker/
 * Verifier）通过相同协议阅读资产与探索内容。
 *
 * 虚拟节点层（不持久化，由数据库查询计算）：
 *   root:assets → atype:{type} → 各资产记录
 *   root:exploration → goal:{id} / ungrouped:intents / judgements / unresolved → 记录
 *
 * 持久记录节点（以持久表的 id 作为节点 ID）：资产、意图、尝试、观察、假设等。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "./record-service.mjs";
import { locateRecord, getRecord } from "./records-read.mjs";
import { readBlobBytes } from "./evidence.mjs";

/* ── 摘要查找（接入 summaries.mjs 的持久摘要） ─────────────────── */

function lookupSummary(db, projectId, branchId) {
  const row = db.prepare(
    "SELECT semantic_summary, refresh_status, covered_commit_seq FROM branch_summaries WHERE project_id = ? AND branch_id = ?",
  ).get(projectId, branchId);
  if (!row || !row.semantic_summary) return null;
  return { text: row.semantic_summary, refresh_status: row.refresh_status, covered_commit_seq: row.covered_commit_seq };
}

/* ── 常量 ──────────────────────────────────────────────────────────── */

const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

function clampLimit(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

function parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; }
}

function pad4(n) { return String(n).padStart(4, "0"); }

/* ── 序列分配（与 evidence.mjs / record-service.mjs 同源模式） ──── */

function requireProject(db, pid) {
  const row = db.prepare("SELECT id, next_commit_seq FROM projects WHERE id = ?").get(pid);
  if (!row) throw apiError("INVALID_REFERENCE", `项目不存在：${pid}`);
  return row;
}

function allocateCommitSeq(db, pid) {
  const row = requireProject(db, pid);
  db.prepare("UPDATE projects SET next_commit_seq = ? WHERE id = ?").run(row.next_commit_seq + 1, pid);
  return row.next_commit_seq;
}

function allocateSeq(db, pid, kind) {
  db.prepare(
    "INSERT INTO id_sequences (project_id, kind, next_val) VALUES (?, ?, 2) ON CONFLICT DO NOTHING",
  ).run(pid, kind);
  const row = db.prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = ? AND kind = ?").get(pid, kind);
  db.prepare("UPDATE id_sequences SET next_val = ? WHERE project_id = ? AND kind = ?").run(row.n + 1, pid, kind);
  return row.n;
}

/* ── 别名解析（§二「目录调整保留旧入口的可达性」） ────────────── */

function resolveAliasChain(db, pid, nodeId, maxDepth = 5) {
  let current = nodeId;
  for (let i = 0; i < maxDepth; i++) {
    const alias = db.prepare(
      "SELECT target_node_id FROM reading_node_aliases WHERE project_id = ? AND old_node_id = ?",
    ).get(pid, current);
    if (!alias) return current;
    current = alias.target_node_id;
  }
  return current;
}

export async function createAlias(pctx, { projectId, oldNodeId, targetNodeId, reason, actor }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    requireProject(db, projectId);
    const seq = allocateCommitSeq(db, projectId);
    db.prepare(
      `INSERT OR REPLACE INTO reading_node_aliases
         (project_id, old_node_id, target_node_id, reason, created_at, created_by, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, oldNodeId, targetNodeId, reason || "", new Date().toISOString(), actor || "system", seq);
    return { old_node_id: oldNodeId, target_node_id: targetNodeId, created_seq: seq };
  });
}

/* ── 虚拟节点定义 ──────────────────────────────────────────────── */

const VIRTUAL_ROOTS = new Set(["root:assets", "root:exploration"]);

function isVirtualId(nodeId) {
  return VIRTUAL_ROOTS.has(nodeId)
    || nodeId.startsWith("atype:")
    || nodeId.startsWith("goal:")
    || nodeId === "ungrouped:intents"
    || nodeId === "judgements"
    || nodeId.startsWith("judgements:")
    || nodeId === "unresolved";
}

function virtualTitle(nodeId, db, pid) {
  if (nodeId === "root:assets") return "资产";
  if (nodeId === "root:exploration") return "探索";
  if (nodeId.startsWith("atype:")) return nodeId.slice(6);
  if (nodeId === "ungrouped:intents") return "未归属意图";
  if (nodeId === "judgements") return "判断";
  if (nodeId === "judgements:hypotheses") return "假设";
  if (nodeId === "judgements:facts") return "事实";
  if (nodeId === "judgements:vulnerabilities") return "漏洞";
  if (nodeId === "unresolved") return "未解决";
  if (nodeId.startsWith("goal:")) {
    const gid = nodeId.slice(5);
    const g = db.prepare("SELECT statement FROM goals WHERE project_id = ? AND id = ?").get(pid, gid);
    return g ? g.statement : gid;
  }
  return nodeId;
}

function virtualParent(nodeId) {
  if (VIRTUAL_ROOTS.has(nodeId)) return null;
  if (nodeId.startsWith("atype:")) return "root:assets";
  if (nodeId.startsWith("goal:")) return "root:exploration";
  if (nodeId === "ungrouped:intents") return "root:exploration";
  if (nodeId === "judgements") return "root:exploration";
  if (nodeId.startsWith("judgements:")) return "judgements";
  if (nodeId === "unresolved") return "root:exploration";
  return null;
}

/** 为记录节点推断其在虚拟树中的父节点。 */
function recordParent(db, pid, recordId, table) {
  if (table === "assets") {
    const r = db.prepare("SELECT asset_type, parent_asset_id FROM assets WHERE project_id = ? AND id = ?").get(pid, recordId);
    if (!r) return "root:assets";
    return r.parent_asset_id ? r.parent_asset_id : `atype:${r.asset_type}`;
  }
  if (table === "goals") return "root:exploration";
  if (table === "intents") {
    const r = db.prepare("SELECT goal_id FROM intents WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r && r.goal_id ? `goal:${r.goal_id}` : "ungrouped:intents";
  }
  if (table === "attempts") {
    const r = db.prepare("SELECT intent_id FROM attempts WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r ? r.intent_id : "root:exploration";
  }
  if (table === "hypotheses") return "judgements:hypotheses";
  if (table === "facts") return "judgements:facts";
  if (table === "vulnerabilities") return "judgements:vulnerabilities";
  if (table === "observations") {
    const r = db.prepare("SELECT capture_id FROM observations WHERE project_id = ? AND id = ?").get(pid, recordId);
    if (r && r.capture_id) {
      const c = db.prepare("SELECT attempt_id FROM captures WHERE project_id = ? AND id = ?").get(pid, r.capture_id);
      if (c && c.attempt_id) return c.attempt_id;
    }
    return "root:exploration";
  }
  if (table === "captures") {
    const r = db.prepare("SELECT attempt_id FROM captures WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r && r.attempt_id ? r.attempt_id : "root:assets";
  }
  if (table === "tool_calls") {
    const r = db.prepare("SELECT attempt_id FROM tool_calls WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r ? r.attempt_id : "root:exploration";
  }
  if (table === "worker_reports") {
    const r = db.prepare("SELECT attempt_id FROM worker_reports WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r ? r.attempt_id : "root:exploration";
  }
  if (table === "extraction_batches") return "root:assets";
  if (table === "extraction_items") {
    const r = db.prepare("SELECT batch_id FROM extraction_items WHERE project_id = ? AND id = ?").get(pid, recordId);
    return r ? r.batch_id : "root:assets";
  }
  if (table === "check_records") return "root:exploration";
  if (table === "judgement_corrections") return "judgements";
  if (table === "branch_summaries") return "root:exploration";
  if (table === "branch_shelving") return "root:exploration";
  return "root:exploration";
}

/** 从节点 ID 向上走到根，构建面包屑路径。 */
function buildBreadcrumb(db, pid, nodeId, maxDepth = 12) {
  const path = [];
  let cur = nodeId;
  for (let i = 0; i < maxDepth && cur; i++) {
    if (isVirtualId(cur)) {
      path.unshift({ id: cur, title: virtualTitle(cur, db, pid) });
      cur = virtualParent(cur);
    } else {
      const loc = locateRecord(db, pid, cur);
      if (!loc) break;
      const row = db.prepare(`SELECT * FROM ${loc.table} WHERE id = ? AND project_id = ?`).get(cur, pid);
      const title = row
        ? (row.canonical_key || row.question || row.statement || row.category || row.name || cur)
        : cur;
      path.unshift({ id: cur, title: String(title).slice(0, 120) });
      cur = recordParent(db, pid, cur, loc.table);
    }
  }
  return path;
}

/* ── 虚拟节点的子节点查询 ──────────────────────────────────────── */

function cursorWhere(cursor) {
  if (!cursor) return { clause: "", params: [] };
  const sep = cursor.indexOf(":");
  if (sep < 0) return { clause: "", params: [] };
  const seq = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  return {
    clause: " AND (created_seq > ? OR (created_seq = ? AND id > ?))",
    params: [seq, seq, id],
  };
}

function makeCursor(row) {
  return `${row.created_seq}:${row.id}`;
}

function briefNode(row, kind) {
  return {
    id: row.id,
    kind: "record",
    record_kind: kind,
    title: String(row.canonical_key || row.question || row.statement || row.category || row.name || row.id).slice(0, 120),
    status: row.status ?? null,
    created_seq: row.created_seq,
  };
}

function virtualChildNode(id, db, pid) {
  return { id, kind: "virtual", record_kind: null, title: virtualTitle(id, db, pid), status: null, created_seq: null };
}

function queryChildren(db, pid, table, extraWhere, extraParams, cursor, limit) {
  const { clause, params } = cursorWhere(cursor);
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE project_id = ?${extraWhere || ""}${clause} ORDER BY created_seq, id LIMIT ?`,
  ).all(pid, ...(extraParams || []), ...params, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => briefNode(r, table));
  return {
    items,
    has_more: hasMore,
    next_cursor: items.length > 0 ? makeCursor(items[items.length - 1]) : null,
  };
}

function countRows(db, pid, table, extraWhere, extraParams) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?${extraWhere || ""}`,
  ).get(pid, ...(extraParams || [])).c;
}

function virtualChildren(db, pid, nodeId, { cursor, limit, filter }) {
  const lim = clampLimit(limit);

  if (nodeId === "root:assets") {
    const types = db.prepare(
      "SELECT DISTINCT asset_type FROM assets WHERE project_id = ? ORDER BY asset_type",
    ).all(pid);
    const items = types.map((t) => virtualChildNode(`atype:${t.asset_type}`, db, pid));
    return { items, total: items.length, has_more: false, next_cursor: null };
  }

  if (nodeId === "root:exploration") {
    const items = [];
    const goals = db.prepare("SELECT id FROM goals WHERE project_id = ? ORDER BY created_seq").all(pid);
    for (const g of goals) items.push(virtualChildNode(`goal:${g.id}`, db, pid));
    const ungrouped = db.prepare(
      "SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND (goal_id IS NULL OR goal_id = '')",
    ).get(pid).c;
    if (ungrouped > 0) items.push(virtualChildNode("ungrouped:intents", db, pid));
    items.push(virtualChildNode("judgements", db, pid));
    items.push(virtualChildNode("unresolved", db, pid));
    return { items, total: items.length, has_more: false, next_cursor: null };
  }

  if (nodeId.startsWith("atype:")) {
    const atype = nodeId.slice(6);
    const total = countRows(db, pid, "assets", " AND asset_type = ? AND (parent_asset_id IS NULL OR parent_asset_id = '')", [atype]);
    const { items, has_more, next_cursor } = queryChildren(
      db, pid, "assets", " AND asset_type = ? AND (parent_asset_id IS NULL OR parent_asset_id = '')", [atype], cursor, lim,
    );
    return { items, total, has_more, next_cursor };
  }

  if (nodeId.startsWith("goal:")) {
    const gid = nodeId.slice(5);
    const total = countRows(db, pid, "intents", " AND goal_id = ?", [gid]);
    const { items, has_more, next_cursor } = queryChildren(
      db, pid, "intents", " AND goal_id = ?", [gid], cursor, lim,
    );
    return { items, total, has_more, next_cursor };
  }

  if (nodeId === "ungrouped:intents") {
    const where = " AND (goal_id IS NULL OR goal_id = '')";
    const total = countRows(db, pid, "intents", where, []);
    const { items, has_more, next_cursor } = queryChildren(db, pid, "intents", where, [], cursor, lim);
    return { items, total, has_more, next_cursor };
  }

  if (nodeId === "judgements") {
    return {
      items: [
        virtualChildNode("judgements:hypotheses", db, pid),
        virtualChildNode("judgements:facts", db, pid),
        virtualChildNode("judgements:vulnerabilities", db, pid),
      ],
      total: 3,
      has_more: false,
      next_cursor: null,
    };
  }

  if (nodeId === "judgements:hypotheses") {
    const total = countRows(db, pid, "hypotheses", "", []);
    const { items, has_more, next_cursor } = queryChildren(db, pid, "hypotheses", "", [], cursor, lim);
    return { items, total, has_more, next_cursor };
  }
  if (nodeId === "judgements:facts") {
    const total = countRows(db, pid, "facts", "", []);
    const { items, has_more, next_cursor } = queryChildren(db, pid, "facts", "", [], cursor, lim);
    return { items, total, has_more, next_cursor };
  }
  if (nodeId === "judgements:vulnerabilities") {
    const total = countRows(db, pid, "vulnerabilities", "", []);
    const { items, has_more, next_cursor } = queryChildren(db, pid, "vulnerabilities", "", [], cursor, lim);
    return { items, total, has_more, next_cursor };
  }

  if (nodeId === "unresolved") {
    const all = [];
    const openH = db.prepare(
      "SELECT * FROM hypotheses WHERE project_id = ? AND status IN ('open','testing') ORDER BY created_seq, id",
    ).all(pid);
    for (const h of openH) all.push(briefNode(h, "hypotheses"));
    const blocked = db.prepare(
      "SELECT * FROM intents WHERE project_id = ? AND status IN ('blocked','deferred') ORDER BY created_seq, id",
    ).all(pid);
    for (const i of blocked) all.push(briefNode(i, "intents"));
    const suspected = db.prepare(
      "SELECT * FROM vulnerabilities WHERE project_id = ? AND status IN ('suspected','inconclusive') ORDER BY created_seq, id",
    ).all(pid);
    for (const v of suspected) all.push(briefNode(v, "vulnerabilities"));
    all.sort((a, b) => (a.created_seq ?? 0) - (b.created_seq ?? 0) || a.id.localeCompare(b.id));
    let filtered = all;
    if (cursor) {
      const sep = cursor.indexOf(":");
      if (sep >= 0) {
        const cSeq = Number(cursor.slice(0, sep));
        const cId = cursor.slice(sep + 1);
        filtered = all.filter((item) => item.created_seq > cSeq || (item.created_seq === cSeq && item.id > cId));
      }
    }
    const trimmed = filtered.slice(0, lim);
    return {
      items: trimmed,
      total: all.length,
      has_more: filtered.length > lim,
      next_cursor: trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1]) : null,
    };
  }

  return { items: [], total: 0, has_more: false, next_cursor: null };
}

/* ── 记录节点的子节点 ──────────────────────────────────────────── */

function recordChildren(db, pid, recordId, table, { cursor, limit }) {
  const lim = clampLimit(limit);
  if (table === "assets") {
    // 子资产 + 挂在该资产上的漏洞 + 指向该资产的意图 + 关联资源
    const all = [];
    const childAssets = db.prepare(
      "SELECT * FROM assets WHERE project_id = ? AND parent_asset_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const ca of childAssets) all.push(briefNode(ca, "assets"));
    const vulns = db.prepare(
      "SELECT * FROM vulnerabilities WHERE project_id = ? AND asset_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const v of vulns) all.push(briefNode(v, "vulnerabilities"));
    const resources = db.prepare(
      "SELECT * FROM resources WHERE project_id = ? AND asset_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const r of resources) all.push(briefNode(r, "resources"));
    // 意图通过 target_asset_ids JSON 包含该资产
    const intents = db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_seq, id").all(pid);
    for (const i of intents) {
      const targets = parseJson(i.target_asset_ids, []);
      if (targets.includes(recordId)) all.push(briefNode(i, "intents"));
    }
    // 排序后按游标过滤
    all.sort((a, b) => (a.created_seq ?? 0) - (b.created_seq ?? 0) || a.id.localeCompare(b.id));
    let filtered = all;
    if (cursor) {
      const sep = cursor.indexOf(":");
      if (sep >= 0) {
        const cSeq = Number(cursor.slice(0, sep));
        const cId = cursor.slice(sep + 1);
        filtered = all.filter((item) => item.created_seq > cSeq || (item.created_seq === cSeq && item.id > cId));
      }
    }
    const trimmed = filtered.slice(0, lim);
    return {
      items: trimmed,
      total: all.length,
      has_more: filtered.length > lim,
      next_cursor: trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1]) : null,
    };
  }

  if (table === "intents") {
    const total = countRows(db, pid, "attempts", " AND intent_id = ?", [recordId]);
    return queryChildren(db, pid, "attempts", " AND intent_id = ?", [recordId], cursor, lim);
  }

  if (table === "attempts") {
    const all = [];
    const tcs = db.prepare(
      "SELECT * FROM tool_calls WHERE project_id = ? AND attempt_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const tc of tcs) all.push(briefNode(tc, "tool_calls"));
    const caps = db.prepare(
      "SELECT * FROM captures WHERE project_id = ? AND attempt_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const c of caps) all.push(briefNode(c, "captures"));
    const wrs = db.prepare(
      "SELECT * FROM worker_reports WHERE project_id = ? AND attempt_id = ? ORDER BY created_seq, id",
    ).all(pid, recordId);
    for (const wr of wrs) all.push(briefNode(wr, "worker_reports"));
    all.sort((a, b) => (a.created_seq ?? 0) - (b.created_seq ?? 0) || a.id.localeCompare(b.id));
    let filtered = all;
    if (cursor) {
      const sep = cursor.indexOf(":");
      if (sep >= 0) {
        const cSeq = Number(cursor.slice(0, sep));
        const cId = cursor.slice(sep + 1);
        filtered = all.filter((item) => item.created_seq > cSeq || (item.created_seq === cSeq && item.id > cId));
      }
    }
    const trimmed = filtered.slice(0, lim);
    return {
      items: trimmed,
      total: all.length,
      has_more: filtered.length > lim,
      next_cursor: trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1]) : null,
    };
  }

  if (table === "extraction_batches") {
    const total = db.prepare(
      "SELECT COUNT(*) AS c FROM extraction_items WHERE batch_id = ? AND project_id = ?",
    ).get(recordId, pid).c;
    const { clause, params } = cursorWhere(cursor);
    const rows = db.prepare(
      `SELECT * FROM extraction_items WHERE batch_id = ? AND project_id = ?${clause}
       ORDER BY created_seq, id LIMIT ?`,
    ).all(recordId, pid, ...params, lim + 1);
    const hasMore = rows.length > lim;
    const items = rows.slice(0, lim).map((r) => briefNode(r, "extraction_items"));
    return {
      items,
      total,
      has_more: hasMore,
      next_cursor: items.length > 0 ? makeCursor(items[items.length - 1]) : null,
    };
  }

  if (table === "goals") {
    const total = countRows(db, pid, "intents", " AND goal_id = ?", [recordId]);
    return queryChildren(db, pid, "intents", " AND goal_id = ?", [recordId], cursor, lim);
  }

  // 其他类型：通过 relations 表查找关联
  const rels = db.prepare(
    `SELECT * FROM relations WHERE project_id = ? AND retracted_at IS NULL
       AND (from_id = ? OR to_id = ?) ORDER BY valid_from_seq LIMIT ?`,
  ).all(pid, recordId, recordId, lim);
  const items = [];
  for (const rel of rels) {
    const otherId = rel.from_id === recordId ? rel.to_id : rel.from_id;
    const loc = locateRecord(db, pid, otherId);
    if (loc) {
      const r = db.prepare(`SELECT * FROM ${loc.table} WHERE id = ? AND project_id = ?`).get(otherId, pid);
      if (r) items.push({ ...briefNode(r, loc.table), relation_type: rel.relation_type, relation_id: rel.id });
    }
  }
  return { items, total: items.length, has_more: false, next_cursor: null };
}

/* ── 公开接口 ──────────────────────────────────────────────────── */

export async function openNode(pctx, { projectId, nodeId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!nodeId) throw apiError("BAD_REQUEST", "缺少 node_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const resolved = resolveAliasChain(db, projectId, nodeId);
  const aliasNote = resolved !== nodeId ? `别名解析：${nodeId} → ${resolved}` : null;

  if (isVirtualId(resolved)) {
    const parent = virtualParent(resolved);
    const breadcrumb = buildBreadcrumb(db, projectId, resolved);
    const children = virtualChildren(db, projectId, resolved, { cursor: null, limit: 0 });
    // 虚拟节点摘要：聚合子分支的语义摘要
    let summary = null;
    if (resolved.startsWith("goal:")) {
      const goalId = resolved.slice(5);
      const goalRow = db.prepare("SELECT statement FROM goals WHERE project_id = ? AND id = ?").get(projectId, goalId);
      const goalSummary = lookupSummary(db, projectId, goalId);
      summary = goalSummary
        ? goalSummary.text + (goalSummary.refresh_status === "stale" ? "（摘要待刷新）" : "")
        : (goalRow ? goalRow.statement : null);
    } else if (resolved.startsWith("atype:")) {
      const atype = resolved.slice(6);
      const count = db.prepare("SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND asset_type = ?").get(projectId, atype).c;
      summary = `${atype} 类型资产（${count} 项）`;
    }
    return {
      node: {
        id: resolved,
        kind: "virtual",
        record_kind: null,
        title: virtualTitle(resolved, db, projectId),
        summary,
        path: breadcrumb,
        has_children: children.total > 0,
        children_count: children.total,
      },
      alias_note: aliasNote,
    };
  }

  // 记录节点
  const loc = locateRecord(db, projectId, resolved);
  if (!loc) throw apiError("NOT_FOUND", `节点不存在：${resolved}`);
  const row = db.prepare(`SELECT * FROM ${loc.table} WHERE id = ? AND project_id = ?`).get(resolved, projectId);
  if (!row) throw apiError("NOT_FOUND", `节点不存在：${resolved}`);

  const breadcrumb = buildBreadcrumb(db, projectId, resolved);
  const children = recordChildren(db, projectId, resolved, loc.table, { cursor: null, limit: 0 });
  const title = String(row.canonical_key || row.question || row.statement || row.category || row.name || resolved).slice(0, 120);

  // 接入语义摘要：意图、假设等分支节点查找持久化的分支摘要
  const branchSummary = lookupSummary(db, projectId, resolved);
  const baseSummary = row.status ? `${loc.table} · ${row.status}` : loc.table;
  const summary = branchSummary
    ? `${baseSummary}\n${branchSummary.text}${branchSummary.refresh_status === "stale" ? "（摘要待刷新）" : ""}`
    : baseSummary;

  return {
    node: {
      id: resolved,
      kind: "record",
      record_kind: loc.table,
      title,
      summary,
      path: breadcrumb,
      has_children: children.total > 0,
      children_count: children.total,
      created_at: row.created_at,
      created_seq: row.created_seq,
      status: row.status ?? null,
    },
    alias_note: aliasNote,
  };
}

export async function listChildren(pctx, { projectId, nodeId, filter, cursor, limit }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!nodeId) throw apiError("BAD_REQUEST", "缺少 node_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const resolved = resolveAliasChain(db, projectId, nodeId);

  let result;
  if (isVirtualId(resolved)) {
    result = virtualChildren(db, projectId, resolved, { cursor, limit, filter });
  } else {
    const loc = locateRecord(db, projectId, resolved);
    if (!loc) throw apiError("NOT_FOUND", `节点不存在：${resolved}`);
    result = recordChildren(db, projectId, resolved, loc.table, { cursor, limit });
  }

  // 给每个子节点补面包屑
  const parentPath = buildBreadcrumb(db, projectId, resolved);
  for (const item of result.items) {
    item.path = [...parentPath, { id: item.id, title: item.title }];
  }
  return {
    parent_id: resolved,
    ...result,
    note: result.has_more
      ? `仅列前 ${result.items.length} 项（共 ${result.total}）；用 next_cursor 续读，不能只看首页就认为已看全部（§四）`
      : null,
  };
}

export async function searchNodes(pctx, { projectId, query, kinds, cursor, limit }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!query || typeof query !== "string" || !query.trim()) {
    throw apiError("BAD_REQUEST", "缺少搜索关键词 query");
  }
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const lim = clampLimit(limit);
  const pattern = `%${query.trim()}%`;
  const { clause: curClause, params: curParams } = cursorWhere(cursor);

  const searchTables = [
    { table: "assets", cols: ["canonical_key", "original_input"] },
    { table: "intents", cols: ["question", "rationale"] },
    { table: "observations", cols: ["statement"] },
    { table: "hypotheses", cols: ["statement"] },
    { table: "facts", cols: ["statement"] },
    { table: "vulnerabilities", cols: ["category", "location"] },
    { table: "captures", cols: ["request_url_exact"] },
    { table: "extraction_items", cols: ["category", "value"] },
    { table: "extraction_batches", cols: ["extractor_name", "extractor_version"] },
  ];

  const allowed = kinds && Array.isArray(kinds) && kinds.length > 0
    ? new Set(kinds)
    : null;

  const results = [];
  for (const { table, cols } of searchTables) {
    if (allowed && !allowed.has(table)) continue;
    const likeClauses = cols.map((c) => `${c} LIKE ?`).join(" OR ");
    const likeParams = cols.map(() => pattern);
    const rows = db.prepare(
      `SELECT * FROM ${table} WHERE project_id = ? AND (${likeClauses})${curClause}
       ORDER BY created_seq, id LIMIT ?`,
    ).all(projectId, ...likeParams, ...curParams, lim + 1);
    for (const row of rows.slice(0, lim)) {
      results.push({
        ...briefNode(row, table),
        path: buildBreadcrumb(db, projectId, row.id),
      });
    }
  }

  // 按 created_seq 排序合并
  results.sort((a, b) => (a.created_seq ?? 0) - (b.created_seq ?? 0) || a.id.localeCompare(b.id));
  const trimmed = results.slice(0, lim);
  return {
    query: query.trim(),
    items: trimmed,
    total: trimmed.length,
    has_more: results.length > lim,
    next_cursor: trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1]) : null,
    note: results.length > lim
      ? `结果超出单页上限；用 next_cursor 续读（§四：不能只返回前几项让模型误以为看到全部）`
      : null,
  };
}

export async function followRelations(pctx, { projectId, nodeId, types, direction }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!nodeId) throw apiError("BAD_REQUEST", "缺少 node_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const resolved = resolveAliasChain(db, projectId, nodeId);

  let where = "project_id = ? AND retracted_at IS NULL";
  const params = [projectId];
  const dir = direction || "both";
  if (dir === "outgoing") {
    where += " AND from_id = ?";
    params.push(resolved);
  } else if (dir === "incoming") {
    where += " AND to_id = ?";
    params.push(resolved);
  } else {
    where += " AND (from_id = ? OR to_id = ?)";
    params.push(resolved, resolved);
  }
  if (types && Array.isArray(types) && types.length > 0) {
    where += ` AND relation_type IN (${types.map(() => "?").join(",")})`;
    params.push(...types);
  }

  const rels = db.prepare(
    `SELECT * FROM relations WHERE ${where} ORDER BY valid_from_seq LIMIT 200`,
  ).all(...params);

  const items = [];
  for (const rel of rels) {
    const otherId = rel.from_id === resolved ? rel.to_id : rel.from_id;
    const loc = locateRecord(db, projectId, otherId);
    let node = null;
    if (loc) {
      const r = db.prepare(`SELECT * FROM ${loc.table} WHERE id = ? AND project_id = ?`).get(otherId, projectId);
      if (r) node = briefNode(r, loc.table);
    }
    items.push({
      relation_id: rel.id,
      relation_type: rel.relation_type,
      direction: rel.from_id === resolved ? "outgoing" : "incoming",
      target_id: otherId,
      target_node: node,
      conditions: rel.conditions || null,
      requires_state: rel.requires_state || null,
    });
  }
  return { source_id: resolved, items, total: items.length };
}

export async function navigateParent(pctx, { projectId, nodeId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!nodeId) throw apiError("BAD_REQUEST", "缺少 node_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const resolved = resolveAliasChain(db, projectId, nodeId);

  let parentId;
  if (isVirtualId(resolved)) {
    parentId = virtualParent(resolved);
  } else {
    const loc = locateRecord(db, projectId, resolved);
    if (!loc) throw apiError("NOT_FOUND", `节点不存在：${resolved}`);
    parentId = recordParent(db, projectId, resolved, loc.table);
  }

  if (!parentId) return { node_id: resolved, parent: null, note: "已在根节点" };
  return openNode(pctx, { projectId, nodeId: parentId });
}

/* ── 证据片段读取（§十三「原始证据按需获取」；§十「工具记录实际读取范围」） ── */

export async function readEvidenceSlice(
  pctx,
  { projectId, targetId, byteOffset, byteLength, role, actorId, intentId, attemptId },
) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!targetId) throw apiError("BAD_REQUEST", "缺少 target_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);

  // 定位目标记录的关联 Blob
  let blobSha = null;
  let blobId = null;
  let targetKind = "";
  const loc = locateRecord(db, projectId, targetId);

  if (loc && loc.table === "blobs") {
    const b = db.prepare("SELECT sha256, id FROM blobs WHERE project_id = ? AND id = ?").get(projectId, targetId);
    if (b) { blobSha = b.sha256; blobId = b.id; targetKind = "blobs"; }
  } else if (loc && loc.table === "captures") {
    const c = db.prepare("SELECT response_body_blob FROM captures WHERE project_id = ? AND id = ?").get(projectId, targetId);
    if (c && c.response_body_blob) {
      const b = db.prepare("SELECT sha256, id FROM blobs WHERE id = ?").get(c.response_body_blob);
      if (b) { blobSha = b.sha256; blobId = b.id; targetKind = "captures"; }
    }
  } else if (loc && loc.table === "observations") {
    const o = db.prepare("SELECT capture_id FROM observations WHERE project_id = ? AND id = ?").get(projectId, targetId);
    if (o && o.capture_id) {
      const c = db.prepare("SELECT response_body_blob FROM captures WHERE project_id = ? AND id = ?").get(projectId, o.capture_id);
      if (c && c.response_body_blob) {
        const b = db.prepare("SELECT sha256, id FROM blobs WHERE id = ?").get(c.response_body_blob);
        if (b) { blobSha = b.sha256; blobId = b.id; targetKind = "observations"; }
      }
    }
  } else if (/^[0-9a-f]{64}$/i.test(targetId)) {
    // 直接传入 SHA-256
    blobSha = targetId.toLowerCase();
    const b = db.prepare("SELECT id FROM blobs WHERE project_id = ? AND sha256 = ?").get(projectId, blobSha);
    if (b) blobId = b.id;
    targetKind = "sha256";
  }

  if (!blobSha) {
    throw apiError("NOT_FOUND", `未找到 ${targetId} 关联的证据 Blob（仅支持 Blob/Capture/Observation 或直接 SHA-256）`);
  }

  const { bytes } = await readBlobBytes(pctx, { sha256: blobSha, projectId });
  const totalBytes = bytes.length;
  const off = Math.max(0, Math.min(byteOffset || 0, totalBytes));
  const len = byteLength && byteLength > 0
    ? Math.min(byteLength, totalBytes - off)
    : Math.min(4096, totalBytes - off);
  const slice = bytes.subarray(off, off + len);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  const sha256 = blobSha;

  // 记录本次读取范围（§十：material_read_logs）
  if (role && actorId) {
    try {
      await store.runSerial((txDb) => {
        const seq = allocateCommitSeq(txDb, projectId);
        const n = allocateSeq(txDb, projectId, "material_read_log");
        const id = `MRL-${projectId}-${pad4(n)}`;
        txDb.prepare(
          `INSERT INTO material_read_logs
             (id, project_id, role, actor_id, intent_id, attempt_id, tool_name, target_id,
              target_kind, blob_sha256, byte_offset, byte_length, total_bytes,
              locator_json, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, 'read_evidence_slice', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
        ).run(
          id, projectId, role, actorId,
          intentId || null, attemptId || null,
          targetId, targetKind, blobSha,
          off, len, totalBytes,
          new Date().toISOString(), actorId, seq,
        );
      });
    } catch {
      /* 读取日志写入失败不阻断证据读取 */
    }
  }

  return {
    target_id: targetId,
    blob_id: blobId,
    sha256,
    byte_offset: off,
    byte_length: len,
    total_bytes: totalBytes,
    content: text,
    note: len < totalBytes
      ? `本次返回 ${off}–${off + len} 字节（共 ${totalBytes}）；用 byte_offset/byte_length 分段读取`
      : "完整内容",
  };
}

/* ── 书签 CRUD（§四「阅读位置与执行位置分别维护」） ────────────── */

export async function saveBookmark(
  pctx,
  { projectId, role, actorId, attemptId, bookmarkKey, nodeId,
    queryCursor, filter, breadcrumb, executingIntentId, note },
) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!role) throw apiError("BAD_REQUEST", "缺少 role");
  if (!actorId) throw apiError("BAD_REQUEST", "缺少 actor_id");
  if (!nodeId) throw apiError("BAD_REQUEST", "缺少 node_id");
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    requireProject(db, projectId);
    const key = bookmarkKey || "default";
    const att = attemptId || "";
    const now = new Date().toISOString();
    const existing = db.prepare(
      "SELECT id FROM reading_bookmarks WHERE project_id = ? AND role = ? AND actor_id = ? AND attempt_id = ? AND bookmark_key = ?",
    ).get(projectId, role, actorId, att, key);

    if (existing) {
      const seq = allocateCommitSeq(db, projectId);
      db.prepare(
        `UPDATE reading_bookmarks SET
           node_id = ?, query_cursor = ?, filter_json = ?, breadcrumb_json = ?,
           executing_intent_id = ?, note = ?, updated_at = ?, updated_seq = ?
         WHERE id = ?`,
      ).run(
        nodeId, queryCursor || "", JSON.stringify(filter || {}),
        JSON.stringify(breadcrumb || []), executingIntentId || "", note || "",
        now, seq, existing.id,
      );
      return { bookmark_id: existing.id, updated: true, node_id: nodeId };
    }

    const seq = allocateCommitSeq(db, projectId);
    const n = allocateSeq(db, projectId, "reading_bookmark");
    const id = `BMK-${projectId}-${pad4(n)}`;
    db.prepare(
      `INSERT INTO reading_bookmarks
         (id, project_id, role, actor_id, attempt_id, executing_intent_id,
          bookmark_key, node_id, query_cursor, filter_json, breadcrumb_json,
          note, created_at, created_by, created_seq, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, projectId, role, actorId, att, executingIntentId || "",
      key, nodeId, queryCursor || "", JSON.stringify(filter || {}),
      JSON.stringify(breadcrumb || []), note || "",
      now, actorId, seq, now, seq,
    );
    return { bookmark_id: id, updated: false, node_id: nodeId };
  });
}

export async function getBookmark(pctx, { projectId, role, actorId, attemptId, bookmarkKey }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (!role) throw apiError("BAD_REQUEST", "缺少 role");
  if (!actorId) throw apiError("BAD_REQUEST", "缺少 actor_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  const key = bookmarkKey || "default";
  const att = attemptId || "";
  const row = db.prepare(
    "SELECT * FROM reading_bookmarks WHERE project_id = ? AND role = ? AND actor_id = ? AND attempt_id = ? AND bookmark_key = ?",
  ).get(projectId, role, actorId, att, key);
  if (!row) return null;
  return {
    bookmark_id: row.id,
    node_id: row.node_id,
    query_cursor: row.query_cursor || null,
    filter: parseJson(row.filter_json, {}),
    breadcrumb: parseJson(row.breadcrumb_json, []),
    executing_intent_id: row.executing_intent_id || null,
    note: row.note || "",
    updated_at: row.updated_at,
  };
}

export async function listBookmarks(pctx, { projectId, role, actorId, attemptId }) {
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  const store = await getStore(pctx);
  const db = store.db;
  requireProject(db, projectId);
  let where = "project_id = ?";
  const params = [projectId];
  if (role) { where += " AND role = ?"; params.push(role); }
  if (actorId) { where += " AND actor_id = ?"; params.push(actorId); }
  if (attemptId !== undefined) { where += " AND attempt_id = ?"; params.push(attemptId || ""); }
  const rows = db.prepare(
    `SELECT * FROM reading_bookmarks WHERE ${where} ORDER BY updated_seq DESC LIMIT 100`,
  ).all(...params);
  return {
    bookmarks: rows.map((r) => ({
      bookmark_id: r.id,
      bookmark_key: r.bookmark_key,
      role: r.role,
      actor_id: r.actor_id,
      attempt_id: r.attempt_id || null,
      node_id: r.node_id,
      executing_intent_id: r.executing_intent_id || null,
      note: r.note || "",
      updated_at: r.updated_at,
    })),
    total: rows.length,
  };
}
