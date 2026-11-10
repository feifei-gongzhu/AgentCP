/**
 * A1 —— 服务端会话与角色（规范 §11.1 §8.3 §2.6；蓝图 §8）。
 *
 * 合同落实：
 *   - 会话由**程序**签发（issueSession 仅供运行时/受控宿主在进程内调用；蓝图 §8.1
 *     「签发通道只对回环进程内可用，不经公网端点」——本模块不提供任何签发端点）；
 *     运行时为每个 planner/orchestrator/worker/verifier 会话建立绑定，
 *     UI 使用 user 会话（用户面端点在无会话头时按 user 处理，见 projects.routes.mjs）。
 *   - 会话绑定 { session_token, project_id, actor, role }；客户端与模型自报的
 *     project_id / actor / role 一律忽略，以会话为准（§11.1）。
 *   - 角色（蓝图 §8.2）：planner / orchestrator / worker / verifier / runtime /
 *     projection / user。角色能执行哪些 submission 操作由 Record Service 的
 *     操作注册表按 op.roles 校验（如 worker 不含漏洞确认类操作，§2.6/§8.3）。
 *   - 载体（蓝图 §14 风险 3 的首版决策）：进程内注册表 + 请求头
 *     `x-sorne-session` 承载；token 为 192bit 随机值；支持可选 TTL。
 *     会话不落库（冻结 DDL 无 sessions 表）；进程重启后会话需由运行时重签，
 *     持久对象的身份不受影响（§1：目标/意图/知识/证据独立于 agent 会话）。
 */
import { randomBytes } from "node:crypto";

export const ROLES = Object.freeze([
  "planner",
  "orchestrator",
  "worker",
  "verifier",
  "runtime",
  "projection",
  "user",
]);

export const SESSION_HEADER = "x-sorne-session";

/** 进程内会话注册表：token → session。 */
const registry = new Map();

/**
 * 签发会话（仅限进程内调用，不经 HTTP）。
 * @param {{project_id: string, actor: string, role: string, ttl_ms?: number}} input
 */
export function issueSession({ project_id, actor, role, ttl_ms } = {}) {
  if (typeof project_id !== "string" || !project_id.trim()) {
    throw new Error("issueSession 需要 project_id");
  }
  if (typeof actor !== "string" || !actor.trim()) {
    throw new Error("issueSession 需要 actor");
  }
  if (!ROLES.includes(role)) {
    throw new Error(`未知角色：${role}（允许：${ROLES.join(" / ")}）`);
  }
  const token = `sorne_${randomBytes(24).toString("base64url")}`;
  const session = {
    session_token: token,
    project_id,
    actor,
    role,
    issued_at: new Date().toISOString(),
    expires_at:
      typeof ttl_ms === "number" && ttl_ms > 0
        ? new Date(Date.now() + ttl_ms).toISOString()
        : null,
  };
  registry.set(token, session);
  return { ...session };
}

/** 解析会话；不存在或已过期返回 null（过期即清除）。 */
export function resolveSession(token) {
  if (typeof token !== "string" || !token) return null;
  const session = registry.get(token);
  if (!session) return null;
  if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
    registry.delete(token);
    return null;
  }
  return { ...session };
}

/** 撤销某项目的全部会话（删除项目时清理，避免残留身份可继续调用，§2.6）。 */
export function revokeSessionsForProject(projectId) {
  let n = 0;
  for (const [token, session] of registry) {
    if (session.project_id === projectId) {
      registry.delete(token);
      n += 1;
    }
  }
  return n;
}

/** 撤销会话（幂等）。 */
export function revokeSession(token) {
  return registry.delete(typeof token === "string" ? token : "");
}

/** 从请求头解析会话（未携带/无效 → null）。 */
export function sessionFromRequest(req) {
  const raw = req && req.headers ? req.headers[SESSION_HEADER] : null;
  const token = Array.isArray(raw) ? raw[0] : raw;
  return resolveSession(token);
}

/** 清理过期会话并返回活跃数（供 /health 观测）。 */
export function activeSessionCount() {
  const now = Date.now();
  for (const [token, session] of registry) {
    if (session.expires_at && Date.parse(session.expires_at) <= now) {
      registry.delete(token);
    }
  }
  return registry.size;
}
