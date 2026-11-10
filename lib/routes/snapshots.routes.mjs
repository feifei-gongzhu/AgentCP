/**
 * B1 —— 投影 / 记录读取 / 任务上下文路由（§15.1–§15.4 §11.2）。
 * 归属模块：B1（投影与记录读取）。蓝图 §5 端点 #13/#14/#15。
 *
 * 权限面（蓝图 §8.2）：本组端点为只读视图，全部角色（planner/orchestrator/worker/
 * verifier/runtime/projection/user）可读；携带会话时会话绑定的 project_id 必须
 * 与读取的项目一致（跨项目拒绝，不泄露对象存在性，§11.2「所有读写都校验项目和
 * 对象访问权」）；无会话的回环请求按 user 面只读处理。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { generateSnapshot, generateWorkerContext } from "../store/projection.mjs";
import { getRecord } from "../store/records-read.mjs";

/** 只读面鉴权：会话可选；会话项目域与目标项目不一致 → 403（§11.2）。 */
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

function parseIntParam(query, name) {
  const raw = query[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw apiError("BAD_REQUEST", `参数 ${name} 必须是非负整数`);
  }
  return n;
}

export const routes = [
  // #13 快照：kind = asset_map | exploration_map | planner_view（§15.1–§15.3；
  // 连字符别名归一化）；同返 snapshot_commit_seq + subscription_id/revision/resume_cursor
  // （§15.2，订阅边界经 B2 冻结契约 openSubscriptionBoundary 建立/更新）
  {
    method: "GET",
    path: "/sorne/snapshots/:kind",
    async handler(pctx, req, res, { params, query }) {
      const { projectId, actor } = readPlane(req, query);
      return generateSnapshot(pctx, {
        projectId,
        kind: params.kind,
        foldSince: parseIntParam(query, "fold_since"),
        actor,
      });
    },
  },
  // #14 按编号读取记录与证据索引（§11.2）
  {
    method: "GET",
    path: "/sorne/records/:id",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return getRecord(pctx, { projectId, id: params.id });
    },
  },
  // #15 Worker 任务快照与必要约束（§11.2；§15.4 1–2 跳 + 强制项 + 分层读取）
  {
    method: "GET",
    path: "/sorne/contexts/:intentId",
    async handler(pctx, req, res, { params, query }) {
      const { projectId, actor } = readPlane(req, query);
      const hops = parseIntParam(query, "hops");
      if (hops !== undefined && (hops < 1 || hops > 2)) {
        throw apiError("BAD_REQUEST", "参数 hops 只允许 1 或 2（§15.4 默认 1–2 跳）");
      }
      const maxChars = parseIntParam(query, "max_chars");
      return generateWorkerContext(pctx, {
        projectId,
        intentId: params.intentId,
        hops,
        maxChars,
        actor,
      });
    },
  },
];
