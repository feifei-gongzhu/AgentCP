/**
 * 主动阅读协议路由（阶段 2；01 号基线 §四「逐层阅读、搜索与跨分支跳转」）。
 *
 * 全部端点为只读视图（GET），携带会话时校验项目域一致性（§11.2）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  openNode,
  listChildren,
  searchNodes,
  followRelations,
  navigateParent,
  readEvidenceSlice,
  saveBookmark,
  getBookmark,
  listBookmarks,
} from "../store/reading.mjs";

function readPlane(req, query) {
  const session = sessionFromRequest(req);
  const projectId =
    (typeof query.project_id === "string" && query.project_id) ||
    (session && typeof session.project_id === "string" && session.project_id) ||
    null;
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (session && session.project_id && session.project_id !== projectId) {
    throw apiError("TRUST_DENIED", `会话项目（${session.project_id}）与请求项目（${projectId}）不一致`);
  }
  return { session, projectId, actor: session ? session.actor : "user", role: session ? session.role : "user" };
}

export const routes = [
  {
    method: "GET",
    path: "/sorne/reading/nodes/:nodeId",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return openNode(pctx, { projectId, nodeId: decodeURIComponent(params.nodeId) });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/nodes/:nodeId/children",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return listChildren(pctx, {
        projectId,
        nodeId: decodeURIComponent(params.nodeId),
        cursor: query.cursor || null,
        limit: query.limit ? Number(query.limit) : undefined,
        filter: query.filter ? JSON.parse(query.filter) : null,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/search",
    async handler(pctx, req, res, { query }) {
      const { projectId } = readPlane(req, query);
      return searchNodes(pctx, {
        projectId,
        query: query.q || "",
        kinds: query.kinds ? query.kinds.split(",") : null,
        cursor: query.cursor || null,
        limit: query.limit ? Number(query.limit) : undefined,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/nodes/:nodeId/relations",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return followRelations(pctx, {
        projectId,
        nodeId: decodeURIComponent(params.nodeId),
        types: query.types ? query.types.split(",") : null,
        direction: query.direction || "both",
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/nodes/:nodeId/parent",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return navigateParent(pctx, {
        projectId,
        nodeId: decodeURIComponent(params.nodeId),
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/evidence/:targetId",
    async handler(pctx, req, res, { params, query }) {
      const { projectId, role, actor } = readPlane(req, query);
      return readEvidenceSlice(pctx, {
        projectId,
        targetId: decodeURIComponent(params.targetId),
        byteOffset: query.byte_offset ? Number(query.byte_offset) : 0,
        byteLength: query.byte_length ? Number(query.byte_length) : undefined,
        role,
        actorId: actor,
        intentId: query.intent_id || null,
        attemptId: query.attempt_id || null,
      });
    },
  },
  {
    method: "POST",
    path: "/sorne/reading/bookmarks",
    async handler(pctx, req, res, { body, query }) {
      const { projectId, role, actor } = readPlane(req, query);
      return saveBookmark(pctx, {
        projectId,
        role: body.role || role,
        actorId: body.actor_id || actor,
        attemptId: body.attempt_id,
        bookmarkKey: body.bookmark_key,
        nodeId: body.node_id,
        queryCursor: body.query_cursor,
        filter: body.filter,
        breadcrumb: body.breadcrumb,
        executingIntentId: body.executing_intent_id,
        note: body.note,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/bookmarks",
    async handler(pctx, req, res, { query }) {
      const { projectId, role, actor } = readPlane(req, query);
      return listBookmarks(pctx, {
        projectId,
        role: query.role || role,
        actorId: query.actor_id || actor,
        attemptId: query.attempt_id,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/reading/bookmarks/:key",
    async handler(pctx, req, res, { params, query }) {
      const { projectId, role, actor } = readPlane(req, query);
      const bm = await getBookmark(pctx, {
        projectId,
        role: query.role || role,
        actorId: query.actor_id || actor,
        attemptId: query.attempt_id,
        bookmarkKey: params.key,
      });
      if (!bm) throw apiError("NOT_FOUND", `书签不存在：${params.key}`);
      return bm;
    },
  },
];
