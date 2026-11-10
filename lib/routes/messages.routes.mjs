/**
 * M2 —— 用户消息路由（蓝图 §2.6-2 端点 #46/#47 + 单条 #47b；M2）。
 *
 * 路径面（蓝图 §10.7「竣工时如有出入以竣工记录为准」）：
 *   - 施工要点主路径：POST /sorne/messages、GET /sorne/messages、GET /sorne/messages/{id}
 *     （project_id 由 body/query 提供，归属校验同 §2.6 通用规则：不存在/跨项目 → 404）；
 *   - 蓝图别名（M1–M6 契约兼容）：POST/GET /sorne/projects/{id}/messages ——
 *     项目编号在路径上，同一存储与语义，不设第二套行为。
 *
 * 权限面：用户面端点（无会话头的回环同源请求按 user 处理，projects.routes.mjs
 * 同法）；携带会话时仅接受 user 角色。信任边界由 dispatcher 统一实施（lib/http.mjs）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { createUserMessage, getMessage, listMessages } from "../store/messages.mjs";

function userPlane(req) {
  const session = sessionFromRequest(req);
  if (!session) return { actor: "user", role: "user", project_id: null };
  if (session.role !== "user") {
    throw apiError(
      "TRUST_DENIED",
      `端点属用户面（消息），会话角色 ${session.role} 无权调用（蓝图 §8.2）`,
      { detail: { role: session.role } },
    );
  }
  return session;
}

/** 归属校验（§2.6 通用规则）：query 或会话提供 project_id；跨项目会话拒绝。 */
function projectOf(query, session) {
  const projectId =
    (typeof query.project_id === "string" && query.project_id) ||
    (session && typeof session.project_id === "string" && session.project_id) ||
    null;
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id（query 参数，或由会话绑定项目提供）");
  if (session && session.project_id && session.project_id !== projectId) {
    throw apiError(
      "TRUST_DENIED",
      `会话绑定的项目（${session.project_id}）与请求操作的项目（${projectId}）不一致，拒绝跨项目访问（§11.2）`,
    );
  }
  return projectId;
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

/** 消息读取面参数归一（cursor 规范名；游标统一见蓝图 §2.6-6）。 */
function listParams(query) {
  return {
    direction: typeof query.direction === "string" && query.direction ? query.direction : undefined,
    limit: limitParam(query),
    cursor: (typeof query.cursor === "string" && query.cursor) || null,
  };
}

export const routes = [
  // #46 POST /sorne/messages（施工要点主路径）
  {
    method: "POST",
    path: "/sorne/messages",
    async handler(pctx, req, res, { query, body }) {
      const who = userPlane(req);
      const b = body || {};
      const projectId =
        (typeof b.project_id === "string" && b.project_id) || projectOf(query, sessionFromRequest(req));
      return createUserMessage(pctx, {
        projectId,
        actor: who.actor,
        content: b.content,
        replyTo: b.reply_to,
        attachments: b.attachments,
        refs: b.refs,
      });
    },
  },
  // #46 别名：POST /sorne/projects/{id}/messages（蓝图路径）
  {
    method: "POST",
    path: "/sorne/projects/:id/messages",
    async handler(pctx, req, res, { params, body }) {
      const who = userPlane(req);
      const b = body || {};
      if (b.project_id && b.project_id !== params.id) {
        throw apiError("BAD_REQUEST", `body.project_id（${b.project_id}）与路径项目（${params.id}）不一致`);
      }
      return createUserMessage(pctx, {
        projectId: params.id,
        actor: who.actor,
        content: b.content,
        replyTo: b.reply_to,
        attachments: b.attachments,
        refs: b.refs,
      });
    },
  },
  // #47 GET /sorne/messages（施工要点主路径；cursor/limit 游标分页）
  {
    method: "GET",
    path: "/sorne/messages",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req);
      const projectId = projectOf(query, session);
      return listMessages(pctx, { projectId, ...listParams(query) });
    },
  },
  // #47 别名：GET /sorne/projects/{id}/messages（蓝图路径）
  {
    method: "GET",
    path: "/sorne/projects/:id/messages",
    async handler(pctx, req, res, { params, query }) {
      const session = sessionFromRequest(req);
      if (session && session.project_id && session.project_id !== params.id) {
        throw apiError(
          "TRUST_DENIED",
          `会话绑定的项目（${session.project_id}）与请求读取的项目（${params.id}）不一致，拒绝跨项目读取（§11.2）`,
        );
      }
      return listMessages(pctx, { projectId: params.id, ...listParams(query) });
    },
  },
  // #47b GET /sorne/messages/{id}（单条：回复链 + 全部关联）
  {
    method: "GET",
    path: "/sorne/messages/:id",
    async handler(pctx, req, res, { params, query }) {
      const session = sessionFromRequest(req);
      const projectId = projectOf(query, session);
      return getMessage(pctx, { projectId, messageId: params.id });
    },
  },
];
