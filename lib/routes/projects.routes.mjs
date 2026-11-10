/**
 * A1 —— 项目 / 范围 / 幂等提交路由（规范 §5.1 §6.1 §11.1 §11.3 §16.4 §17）。
 * 归属模块：A1（幂等提交与统一记录服务）。蓝图 §5 端点 #4–#10。
 *
 * 权限面（蓝图 §8.2）：
 *   - #4–#9 为用户面端点（项目/范围/生命周期管理）：无会话头的回环同源请求按
 *     user 角色处理；携带会话时仅接受 user 角色，其余角色一律 403；
 *   - #10 POST /submissions 必须携带程序签发的会话（x-sorne-session），
 *     project_id/actor/role 以会话为准，信封内自报一律拒绝（§11.1）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { getStore } from "../store/record-service.mjs";
import {
  createProject,
  createScopeRevision,
  deleteProject,
  getProjectDetail,
  getProjectScope,
  listProjects,
  submit,
  updateProjectLifecycle,
} from "../store/record-service.mjs";
import { readLlmSettings, writeLlmSettings } from "../store/llm-settings.mjs";

/** 用户面鉴权：无会话 → user；非 user 会话 → 403（蓝图 §8.2 端点矩阵）。 */
function userPlane(req) {
  const session = sessionFromRequest(req);
  if (!session) return { actor: "user", role: "user", project_id: null };
  if (session.role !== "user") {
    throw apiError(
      "TRUST_DENIED",
      `端点属用户面（项目/范围/生命周期），会话角色 ${session.role} 无权调用（蓝图 §8.2）`,
      { detail: { role: session.role } },
    );
  }
  return session;
}

/* ── #4 summary 扩展（蓝图 §2.6-5；M2）────────────────────────────── */

function limitParam(query) {
  const raw = query.limit;
  if (raw === undefined || raw === null || raw === "") return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw apiError("BAD_REQUEST", "参数 limit 必须是 1..200 的整数（列表分页走游标，不静默截断）");
  }
  return n;
}

/** 最近一条事件的一句话摘要（event_type + 主体编号；按已加载数据推导口径）。 */
function latestProgressOf(db, projectId) {
  const ev = db
    .prepare(
      `SELECT event_type, subject_ids, created_at FROM outbox
        WHERE project_id = ? ORDER BY commit_seq DESC, event_index DESC, rowid DESC LIMIT 1`,
    )
    .get(projectId);
  if (!ev) return { summary: null, at: null };
  let subjects = [];
  try {
    subjects = JSON.parse(ev.subject_ids || "[]");
  } catch {
    subjects = [];
  }
  return {
    summary: `${ev.event_type}（${subjects.slice(0, 3).join("、") || "无主体编号"}）`,
    at: ev.created_at,
  };
}

/** 单项目待处理计数（§20.2 观测口径：库内可核对，全部「按已加载数据推导」）。 */
function pendingOf(db, projectId) {
  return {
    unhandled_reports: db
      .prepare("SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ? AND handling_status = 'pending'")
      .get(projectId).c,
    pending_verification: db
      .prepare("SELECT COUNT(*) AS c FROM verification_jobs WHERE project_id = ? AND status IN ('pending','in_progress')")
      .get(projectId).c,
    blocked_intents: db
      .prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND status = 'blocked'")
      .get(projectId).c,
  };
}

/** summary 形体：真分页（cursor/limit）+ 五列摘要（蓝图 §2.6-5/§1.3）。 */
async function listProjectsSummary(pctx, { cursor, limit }) {
  const store = await getStore(pctx);
  return store.runSerial((db) => {
    const where = [];
    const args = [];
    if (cursor) {
      const m = /^(\d+):(.+)$/.exec(cursor);
      if (!m) {
        throw apiError("BAD_REQUEST", "cursor 格式非法（应使用上一页返回的 next_cursor）");
      }
      where.push("(created_seq > ? OR (created_seq = ? AND id > ?))");
      args.push(Number(m[1]), Number(m[1]), m[2]);
    }
    const rows = db
      .prepare(
        `SELECT * FROM projects ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_seq, id LIMIT ?`,
      )
      .all(...args, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const projects = page.map((row) => {
      const progress = latestProgressOf(db, row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        latest_progress: progress.summary,
        last_activity_at: progress.at ?? row.created_at,
        pending: pendingOf(db, row.id),
      };
    });
    const last = page[page.length - 1];
    return {
      projects,
      next_cursor: hasMore && last ? `${last.created_seq}:${last.id}` : null,
      has_more: hasMore,
      note: "五列摘要（项目/状态/最近进展/待处理/最近活动）全部来自库内记录；计数按已加载数据推导，不代表全量",
    };
  });
}

export const routes = [
  // #4 项目列表（include=summary → 五列摘要 + 真分页；缺省保持旧形体兼容既有调用方）
  {
    method: "GET",
    path: "/sorne/projects",
    async handler(pctx, req, res, { query }) {
      userPlane(req);
      if (query.include === "summary") {
        return listProjectsSummary(pctx, { cursor: query.cursor, limit: limitParam(query) });
      }
      return listProjects(pctx);
    },
  },
  // #5 创建项目（名称 / 测试目标 / 测试任务 / 初始范围 / LLM 基础配置）
  {
    method: "POST",
    path: "/sorne/projects",
    async handler(pctx, req, res, { body }) {
      const who = userPlane(req);
      const b = body || {};
      // target 是单值「测试目标 URL」；scope_rules 是完整 allow/deny/pending（二选一，优先显式 rules）。
      let scopeRules = b.scope_rules;
      if (scopeRules === undefined && typeof b.target === "string" && b.target.trim()) {
        scopeRules = { allow: [b.target.trim()], deny: [], pending: [] };
      }
      const created = await createProject(pctx, {
        actor: who.actor,
        name: b.name,
        description: b.description,
        task: b.task,
        scopeRules: scopeRules ?? null,
      });
      // LLM 基础配置（可选；写入全局 sorne-data/llm.json，与 M2 设置端点同一存储）
      let llmUpdated = false;
      if (b.llm && typeof b.llm === "object" && !Array.isArray(b.llm)) {
        const llm = b.llm;
        const baseUrl = typeof llm.baseUrl === "string" ? llm.baseUrl : (typeof llm.base_url === "string" ? llm.base_url : "");
        const model = typeof llm.model === "string" ? llm.model : "";
        const apiKey = llm.apiKey !== undefined ? llm.apiKey : llm.api_key;
        if (baseUrl.trim() && model.trim()) {
          await writeLlmSettings(pctx.dataDir, {
            baseUrl,
            model,
            ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
          });
          llmUpdated = true;
        }
      }
      const llmView = readLlmSettings(pctx.dataDir);
      return {
        ...created,
        llm_configured: Boolean(llmView.config && llmView.config.apiKey && llmView.config.model),
        llm_updated: llmUpdated,
      };
    },
  },
  // 删除项目（不可逆；必须显式 ?confirm=delete 或 body.confirm=true）
  {
    method: "DELETE",
    path: "/sorne/projects/:id",
    async handler(pctx, req, res, { params, query, body }) {
      const who = userPlane(req);
      const confirmed = query?.confirm === "delete" || (body && body.confirm === true);
      if (!confirmed) {
        throw apiError("PRECONDITION_INVALID", "删除项目需要显式确认：DELETE /sorne/projects/:id?confirm=delete", {
          next_requirements: ["确认删除会清空项目记录、证据文件与进程内会话，且不可恢复"],
        });
      }
      return deleteProject(pctx, { projectId: params.id, actor: who.actor });
    },
  },
  // #6 项目详情
  {
    method: "GET",
    path: "/sorne/projects/:id",
    async handler(pctx, req, res, { params }) {
      userPlane(req);
      return getProjectDetail(pctx, params.id);
    },
  },
  // #7 生命周期：pause / wait / resume / stop（§16.4）
  {
    method: "POST",
    path: "/sorne/projects/:id/lifecycle",
    async handler(pctx, req, res, { params, body }) {
      const who = userPlane(req);
      const b = body || {};
      return updateProjectLifecycle(pctx, {
        projectId: params.id,
        actor: who.actor,
        action: b.action,
        expectedStateVersion: b.expected_state_version,
      });
    },
  },
  // #8 新范围版本（§17：版本化 allow/deny/pending）
  {
    method: "POST",
    path: "/sorne/scope-revisions",
    async handler(pctx, req, res, { body }) {
      const who = userPlane(req);
      const b = body || {};
      if (typeof b.project_id !== "string" || !b.project_id) {
        throw apiError("BAD_REQUEST", "缺少 project_id");
      }
      return createScopeRevision(pctx, {
        projectId: b.project_id,
        actor: who.actor,
        rules: b.rules,
        summary: b.summary,
      });
    },
  },
  // #9 当前范围与历史
  {
    method: "GET",
    path: "/sorne/projects/:id/scope",
    async handler(pctx, req, res, { params }) {
      userPlane(req);
      return getProjectScope(pctx, params.id);
    },
  },
  // #10 幂等统一提交（§11.1/§11.3）
  {
    method: "POST",
    path: "/sorne/submissions",
    async handler(pctx, req, res, { body }) {
      const session = sessionFromRequest(req);
      if (!session) {
        throw apiError(
          "TRUST_DENIED",
          "POST /submissions 需要程序签发的会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
        );
      }
      return submit(pctx, { session, envelope: body });
    },
  },
];
