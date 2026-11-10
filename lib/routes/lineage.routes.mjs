/**
 * 全链路视图（用户面只读）：把一个项目的 计划 → 意图 → 尝试 → 采集 → 观察
 * → 假设/验证 → 漏洞 连成可读的节点/边，供探索页「链路图」直接渲染。
 *
 * 数据全部来自持久表（plan_revisions/intents/attempts/captures/observations/
 * hypotheses/verification_jobs/verification_results/vulnerabilities/
 * evidence_memberships），不读投影缓存、不猜关系；缺少显式关系时不连边。
 */
import { apiError } from "../errors.mjs";
import { getStore } from "../store/record-service.mjs";

const MAX = 240;

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truncate(value, n) {
  const s = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/projects/:id/lineage",
    async handler(pctx, req, res, { params }) {
      const store = await getStore(pctx);
      const pid = params.id;
      const project = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
      if (!project) throw apiError("NOT_FOUND", `项目不存在：${pid}`);

      const nodes = [];
      const edges = [];
      const nodeIds = new Set();
      const addNode = (node) => {
        if (!node || !node.id || nodeIds.has(node.id)) return;
        nodeIds.add(node.id);
        nodes.push(node);
      };
      const addEdge = (from, to, kind, label) => {
        if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return;
        const key = from + "->" + to + ":" + kind;
        if (edges.some((e) => e.key === key)) return;
        edges.push({ key, from, to, kind, label });
      };

      addNode({
        id: "START", kind: "start", layer: 0, ref: project.id,
        title: project.name || project.id,
        summary: truncate((project.task || "") + (project.description ? " · " + project.description : ""), 120) || "项目起点",
        status: project.status, time: project.created_at,
      });

      const plans = store.db
        .prepare("SELECT * FROM plan_revisions WHERE project_id = ? ORDER BY created_seq DESC LIMIT 8")
        .all(pid);
      for (const p of plans) {
        addNode({
          id: p.id, kind: "plan", layer: 1, ref: p.id,
          title: "计划 " + (p.revision || "—"),
          summary: (p.received_status || "—")
            + " · 新增意图 " + parseJsonArray(p.intents_created).length
            + (parseJsonArray(p.intents_updated).length ? " · 更新 " + parseJsonArray(p.intents_updated).length : ""),
          status: p.received_status, time: p.created_at,
        });
        addEdge("START", p.id, "derive", "计划");
      }

      const intents = store.db
        .prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_seq DESC LIMIT 60")
        .all(pid);
      const intentById = new Map(intents.map((i) => [i.id, i]));
      const planByRevision = new Map(plans.map((p) => [String(p.revision), p.id]));
      for (const it of intents) {
        addNode({
          id: it.id, kind: "intent", layer: 2, ref: it.id,
          title: truncate(it.question, 80) || it.id,
          summary: (it.kind || "调查") + " · " + (it.status || "—") + (it.priority !== undefined ? " · P" + it.priority : ""),
          status: it.status, time: it.created_at,
        });
        const planId = planByRevision.get(String(it.plan_revision));
        addEdge(planId || "START", it.id, "derive", planId ? "派生" : "起点");
      }

      const attempts = store.db
        .prepare("SELECT * FROM attempts WHERE project_id = ? ORDER BY created_seq DESC LIMIT 60")
        .all(pid);
      const attemptById = new Map(attempts.map((a) => [a.id, a]));
      for (const at of attempts) {
        const it = intentById.get(at.intent_id);
        addNode({
          id: at.id, kind: "attempt", layer: 3, ref: at.id,
          title: (it ? truncate(it.question, 48) : at.intent_id) + " 尝试",
          summary: "worker " + (at.worker_id || "—") + " · " + (at.status || "—"),
          status: at.status, time: at.created_at,
        });
        addEdge(at.intent_id, at.id, "produce", "产出");
      }

      const captures = store.db
        .prepare("SELECT * FROM captures WHERE project_id = ? ORDER BY created_seq DESC LIMIT 200")
        .all(pid);
      const captureById = new Map(captures.map((c) => [c.id, c]));
      const groups = new Map();
      for (const c of captures) {
        const gid = c.attempt_id ? "CAPG:" + c.attempt_id : "CAPG:" + c.id;
        if (!groups.has(gid)) groups.set(gid, { id: gid, items: [], attempt_id: c.attempt_id });
        groups.get(gid).items.push(c);
      }
      for (const g of groups.values()) {
        const last = g.items[0];
        addNode({
          id: g.id, kind: "capture", layer: 4, ref: g.items[0].id,
          title: "采集 ×" + g.items.length,
          summary: truncate((last ? last.method + " " + last.request_url_exact : "采集记录"), 100),
          status: "recorded", time: last ? last.created_at : null,
        });
        addEdge(g.attempt_id, g.id, "produce", "产出");
      }

      const observations = store.db
        .prepare("SELECT * FROM observations WHERE project_id = ? ORDER BY created_seq DESC LIMIT 80")
        .all(pid);
      for (const o of observations) {
        addNode({
          id: o.id, kind: "observation", layer: 5, ref: o.id,
          title: truncate(o.statement, 80) || o.id,
          summary: o.anchor ? String(o.anchor) : "观察",
          status: "recorded", time: o.created_at,
        });
        const cap = captureById.get(o.capture_id);
        if (cap) {
          const gid = cap.attempt_id ? "CAPG:" + cap.attempt_id : "CAPG:" + cap.id;
          addEdge(gid, o.id, "prove", "证明");
        }
      }

      const hypotheses = store.db
        .prepare("SELECT * FROM hypotheses WHERE project_id = ? ORDER BY created_seq DESC LIMIT 40")
        .all(pid);
      for (const hy of hypotheses) {
        addNode({
          id: hy.id, kind: "hypothesis", layer: 6, ref: hy.id,
          title: truncate(hy.statement, 80) || hy.id,
          summary: "假设 · " + (hy.status || "—"),
          status: hy.status, time: hy.created_at,
        });
      }

      const verifications = store.db
        .prepare("SELECT * FROM verification_jobs WHERE project_id = ? ORDER BY created_seq DESC LIMIT 40")
        .all(pid);
      const results = store.db
        .prepare("SELECT * FROM verification_results WHERE project_id = ? ORDER BY created_seq DESC LIMIT 80")
        .all(pid);
      const resultByJob = new Map(results.map((r) => [r.job_id, r]));
      for (const vj of verifications) {
        const result = resultByJob.get(vj.id);
        addNode({
          id: vj.id, kind: "verification", layer: 6, ref: vj.id,
          title: "验证 " + (vj.subject_kind || "") + " " + (vj.subject_id || ""),
          summary: (result && result.outcome ? "结论 " + result.outcome : "验证任务") + " · " + (vj.status || "—"),
          status: vj.status, time: vj.created_at,
        });
        addEdge(vj.subject_id, vj.id, "verify", "验证");
        for (const ref of parseJsonArray(result && result.supporting_refs)) addEdge(ref, vj.id, "prove", "支持");
        for (const ref of parseJsonArray(result && result.opposing_refs)) addEdge(ref, vj.id, "prove", "反证");
      }

      const vulns = store.db
        .prepare("SELECT * FROM vulnerabilities WHERE project_id = ? ORDER BY created_seq DESC LIMIT 40")
        .all(pid);
      for (const v of vulns) {
        addNode({
          id: v.id, kind: "vulnerability", layer: 7, ref: v.id,
          title: (v.category || "漏洞") + " @ " + truncate(v.location, 60),
          summary: (v.status || "—") + (v.review ? " · 复核 " + v.review : ""),
          status: v.status, time: v.created_at,
        });
      }

      const memberships = store.db
        .prepare("SELECT * FROM evidence_memberships WHERE project_id = ? ORDER BY created_seq DESC LIMIT 500")
        .all(pid);
      for (const m of memberships) {
        if (!m || !m.subject_id || !m.member_id) continue;
        addEdge(m.member_id, m.subject_id, "prove", m.stance === "oppose" ? "反证" : "证明");
      }

      const limited = nodes.slice(0, MAX);
      const ids = new Set(limited.map((n) => n.id));
      const limitedEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      return {
        project_id: pid,
        generated_at: new Date().toISOString(),
        truncated: nodes.length > MAX,
        counts: {
          nodes: limited.length, edges: limitedEdges.length,
          layers: limited.reduce((acc, n) => { acc[n.layer] = (acc[n.layer] || 0) + 1; return acc; }, {}),
        },
        nodes: limited.map((n) => ({
          id: n.id, kind: n.kind, layer: n.layer, ref: n.ref || null,
          title: n.title, summary: n.summary, status: n.status || null, time: n.time || null,
        })),
        edges: limitedEdges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label })),
      };
    },
  },
];
