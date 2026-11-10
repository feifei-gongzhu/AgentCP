/**
 * B2 —— 变化页 / 消费确认 / 动态订阅路由（蓝图 §5 端点 #16–#19）。
 *
 * 规范落点：
 *   - #16 GET  /changes（§11.2、§14.3）：变化页 events/next_cursor/high_watermark/has_more；
 *   - #17 POST /consumer-acks（§11.2、§14.2/§14.3）：持久确认消费结果（applied；
 *     delivered 由服务端在 #16 投递事务内记录，两者分存）；
 *   - #18 POST /subscriptions（§15.5）：建立动态订阅；携带 subscription_id 时为规则更新
 *     （订阅版本推进 → 旧游标 CURSOR_EXPIRED，需重同步）；
 *   - #19 GET  /subscriptions/:id（§15.5）：订阅边界与版本（项目内会话可读的只读视图）；
 *   - GET /change-log：变化流只读视图（user 面工作台可达性；§14.3/§15.2 的读取面）。
 *     #16/#17 属消费者面（程序签发会话，浏览器 UI 无签发通道），工作台对「快照
 *     之后的增量」的可见性由本只读端点承担：不写回执、不推进游标（查看≠消费）。
 *
 * 权限（蓝图 §8.2）：#16/#17/#18 需要程序签发的消费者角色会话（planner/orchestrator/
 * worker/verifier/runtime/projection），project_id/actor 以会话为准；变化流（#16/#17）仅
 * 订阅消费者本人可操作；#19 为只读视图，项目内任意角色（含 user）可读。
 * 模型消费者的「已处理」以已保存的计划/执行结果为前提（§14.2）——本端点只持久化回执
 * 并校验前提（未投递不确认、不越过未扫描区间），不替 AI 判断处理是否完成。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  acknowledgeConsumption,
  CONSUMER_ROLES,
  createSubscription,
  getSubscriptionView,
  readChangeLog,
  readChangesPage,
  updateSubscription,
} from "../store/changes.mjs";

/** 消费者面鉴权：必须携带程序签发会话且角色在消费者集合内（蓝图 §8.2）。 */
function consumerPlane(req) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError(
      "TRUST_DENIED",
      "本端点需要程序签发的会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
    );
  }
  if (!CONSUMER_ROLES.includes(session.role)) {
    throw apiError(
      "TRUST_DENIED",
      `端点属消费者面（变化页/消费确认/动态订阅），会话角色 ${session.role} 无权调用（蓝图 §8.2）`,
      { detail: { role: session.role, allowed_roles: [...CONSUMER_ROLES] } },
    );
  }
  return session;
}

/** #19 只读视图鉴权：任意有效会话（含 user）+ 项目访问权在 store 内校验。 */
function anyPlane(req) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError("TRUST_DENIED", "本端点需要程序签发的会话（请求头 x-sorne-session）");
  }
  return session;
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw apiError("BAD_REQUEST", "limit 必须是 1..500 的整数（服务端另 clamp 到页上限）");
  }
  return n;
}

export const routes = [
  // 变化流只读视图（user 面工作台可达性；§14.3/§15.2 的读取面）：
  // 与 #16 消费者面变化页并列——不写 delivered 回执、不推进订阅游标，查看≠消费。
  // 快照页宣称「增量从 resume_cursor 之后重放」；本端点让工作台能真正读到这些
  // 增量（浏览器无会话签发通道，#16 对 UI 不可达，蓝图 §8.1/§8.2）。
  {
    method: "GET",
    path: "/sorne/change-log",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req); // 会话可选（无会话按 user 面只读处理）
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
      return readChangeLog(pctx, {
        projectId,
        subscriptionId:
          typeof query.subscription === "string" && query.subscription ? query.subscription : null,
        // 游标统一（蓝图 §2.6-6）：cursor 为规范名，after 为既有调用方别名
        after:
          (typeof query.cursor === "string" && query.cursor) ||
          (typeof query.after === "string" && query.after ? query.after : null),
        limit: parseLimit(query.limit),
      });
    },
  },
  // #16 变化页（§14.3：events/next_cursor/high_watermark/has_more）
  {
    method: "GET",
    path: "/sorne/changes",
    async handler(pctx, req, res, { query }) {
      const session = consumerPlane(req);
      if (!query.subscription || typeof query.subscription !== "string") {
        throw apiError("BAD_REQUEST", "缺少 query 参数 subscription（订阅编号，如 SUBS-0001）");
      }
      return readChangesPage(pctx, {
        session,
        subscriptionId: query.subscription,
        // 游标统一（蓝图 §2.6-6）：cursor 为规范名，after 为既有调用方别名
        after: query.cursor !== undefined && query.cursor !== "" ? query.cursor : query.after,
        limit: parseLimit(query.limit),
      });
    },
  },
  // #17 持久确认消费结果（§14.2/§14.3）
  {
    method: "POST",
    path: "/sorne/consumer-acks",
    async handler(pctx, req, res, { body }) {
      const session = consumerPlane(req);
      const b = body || {};
      if (typeof b.subscription_id !== "string" || !b.subscription_id) {
        throw apiError("BAD_REQUEST", "缺少 subscription_id");
      }
      return acknowledgeConsumption(pctx, {
        session,
        subscriptionId: b.subscription_id,
        receiptKind: b.receipt_kind,
        boundary: b.boundary,
        eventIds: b.event_ids,
      });
    },
  },
  // #18 建立动态订阅 / 更新订阅规则（§15.5）
  {
    method: "POST",
    path: "/sorne/subscriptions",
    async handler(pctx, req, res, { body }) {
      const session = consumerPlane(req);
      const b = body || {};
      if (typeof b.subscription_id === "string" && b.subscription_id) {
        return updateSubscription(pctx, {
          session,
          subscriptionId: b.subscription_id,
          focus: b.focus,
          relationRules: b.relation_rules,
          scope: b.scope,
        });
      }
      return createSubscription(pctx, {
        session,
        projectId: b.project_id,
        focus: b.focus,
        relationRules: b.relation_rules,
        scope: b.scope,
      });
    },
  },
  // #19 订阅边界与版本（§15.5）
  {
    method: "GET",
    path: "/sorne/subscriptions/:id",
    async handler(pctx, req, res, { params }) {
      const session = anyPlane(req);
      return getSubscriptionView(pctx, { session, subscriptionId: params.id });
    },
  },
];
