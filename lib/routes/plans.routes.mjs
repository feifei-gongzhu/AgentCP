/**
 * C1 —— 意图与计划接收路由（规范 §10.1 §16.2 §11.2）。
 * 归属模块：C1（意图与计划接收）。蓝图 §5 端点 #20/#21。
 *
 * 权限面（蓝图 §8.2）：
 *   - #20 POST /plan-revisions 必须携带程序签发的 planner 会话（x-sorne-session），
 *     其余角色一律 403；project_id/actor 以会话为准，信封内自报一律拒绝（§11.1）；
 *   - #21 GET /intents 为只读视图：全角色可读；携带会话时会话绑定项目必须与
 *     读取项目一致（跨项目拒绝，§11.2）；无会话的回环请求按 user 面只读处理
 *     （需显式 project_id，蓝图 §8.2 user 行含 #21）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { INTENT_KINDS, INTENT_STATUSES, listIntents, receivePlanRevision } from "../store/intents.mjs";

/** 只读面鉴权：会话可选；会话项目域与目标项目不一致 → 403（§11.2，B1 同法）。 */
function readPlane(req, query) {
  const session = sessionFromRequest(req);
  const projectId =
    (typeof query.project_id === "string" && query.project_id) ||
    (session && typeof session.project_id === "string" && session.project_id) ||
    null;
  if (!projectId) {
    throw apiError("BAD_REQUEST", "缺少 project_id（query 参数，或由会话绑定项目提供）");
  }
  if (session && session.project_id && session.project_id !== projectId) {
    throw apiError(
      "TRUST_DENIED",
      `会话绑定的项目（${session.project_id}）与请求读取的项目（${projectId}）不一致，拒绝跨项目读取（§11.2）`,
    );
  }
  return { session, projectId, actor: session ? session.actor : "user" };
}

function csvParam(query, name, allowed, label) {
  const raw = query[name];
  if (raw === undefined || raw === null || raw === "") return [];
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!allowed.includes(p)) {
      throw apiError("BAD_REQUEST", `参数 ${name} 的取值 ${p} 非法；${label}允许：${allowed.join("、")}`);
    }
  }
  return parts;
}

function intParam(query, name) {
  const raw = query[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw apiError("BAD_REQUEST", `参数 ${name} 必须是整数`);
  }
  return n;
}

function limitParam(query) {
  const raw = query.limit;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw apiError("BAD_REQUEST", "参数 limit 必须是 1..200 的整数（列表分页走游标，不静默截断）");
  }
  return n;
}

export const routes = [
  // #20 接收 planner 的新意图与计划修订（§11.2/§16.2）
  {
    method: "POST",
    path: "/sorne/plan-revisions",
    async handler(pctx, req, res, { body }) {
      const session = sessionFromRequest(req);
      if (!session) {
        throw apiError(
          "TRUST_DENIED",
          "POST /plan-revisions 需要程序签发的 planner 会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
        );
      }
      if (session.role !== "planner") {
        throw apiError(
          "TRUST_DENIED",
          `计划提交仅 planner 角色可调用（蓝图 §8.2）；当前会话角色为 ${session.role}（actor=${session.actor}）`,
          { detail: { role: session.role, required: "planner" } },
        );
      }
      return receivePlanRevision(pctx, { session, envelope: body });
    },
  },
  // #21 意图列表（§10.1 状态/优先级过滤；游标分页）
  {
    method: "GET",
    path: "/sorne/intents",
    async handler(pctx, req, res, { query }) {
      const { projectId } = readPlane(req, query);
      return listIntents(pctx, {
        projectId,
        statuses: csvParam(query, "status", INTENT_STATUSES, "意图状态"),
        kinds: csvParam(query, "kind", INTENT_KINDS, "意图类型"),
        goalId: typeof query.goal_id === "string" && query.goal_id ? query.goal_id : undefined,
        priorityMin: intParam(query, "priority_min"),
        priorityMax: intParam(query, "priority_max"),
        limit: limitParam(query),
        cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : undefined,
        includeHistory: ["1", "true"].includes(String(query.include_history || "")),
      });
    },
  },
];
