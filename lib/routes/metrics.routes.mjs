/**
 * F2 —— 运行观测与恢复演练路由（蓝图 §5 端点 #41/#42）。
 *
 *   - #41 GET  /metrics（§20.2）：运行指标全集（保存延迟、Outbox 积压与重试、
 *     投影滞后、未消费发现数量、重复意图比例、无新增信息的重复执行、验证队列
 *     等待时间、冲突类型、受阻方向恢复率、证据容量及完整性异常 + 项目状态
 *     分布）。只读观测面：携带会话时按会话项目域校验；无会话的回环请求按
 *     user 面只读处理（project_id 取 query，B1/C2 先例）。
 *   - #42 POST /recovery/drill（§18.2）：恢复演练触发——对指定项目执行恢复
 *     顺序七步（真实事务：过期租约清扫、未完成调用标 unknown、Outbox/游标
 *     核对、证据完整性、Checkpoint 生成与边界增量、等待评估）；演练报告留痕
 *     于 work/recovery/drills/。变更面端点：需要程序签发会话且角色为
 *     user/runtime（蓝图 §8.2 user 含 #42；runtime 为程序维护面），project_id
 *     以会话项目域校验。
 *
 * 故障注入说明（§20.3 末段）：进程退出类故障由测试以真实「关库关服→同目录
 * 重启→重签会话」注入，本端点承担重启后的核对与修复（不 mock 故障）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { collectMetrics } from "../store/metrics.mjs";
import { runRecovery } from "../store/recovery.mjs";

function requireSession(req) {
  const session = sessionFromRequest(req);
  if (!session) {
    throw apiError(
      "TRUST_DENIED",
      "本端点需要程序签发的会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
    );
  }
  return session;
}

/** 会话项目域校验：显式 project_id 必须与会话绑定项目一致（§11.2 所有读写校验访问权）。 */
function projectOf(session, raw) {
  const declared = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (declared && declared !== session.project_id) {
    throw apiError(
      "TRUST_DENIED",
      `会话绑定项目 ${session.project_id} 与请求声明的 ${declared} 不一致（跨项目访问被拒绝，§11.2）`,
    );
  }
  return session.project_id;
}

export const routes = [
  // #41 运行指标全集（§20.2）
  {
    method: "GET",
    path: "/sorne/metrics",
    async handler(pctx, req, res, { query }) {
      const session = sessionFromRequest(req);
      let projectId;
      if (session) {
        projectId = projectOf(session, query.project_id);
      } else {
        // 无会话回环按 user 面只读（B1/C2 先例）；project_id 缺省为全部项目
        projectId = typeof query.project_id === "string" && query.project_id.trim() ? query.project_id.trim() : null;
      }
      const metrics = await collectMetrics(pctx, { projectId: projectId || undefined });
      if (session && session.role === "user") {
        metrics.note_for_ui = "总览页指标卡：漏洞数量不是唯一健康指标（§20.2）";
      }
      return metrics;
    },
  },
  // #42 恢复演练触发（§18.2 七步；§20.3 场景 12/24 重启故障注入演练）
  {
    method: "POST",
    path: "/sorne/recovery/drill",
    async handler(pctx, req, res, { body }) {
      const session = requireSession(req);
      if (!["user", "runtime"].includes(session.role)) {
        throw apiError("TRUST_DENIED", `端点 POST /recovery/drill 不允许会话角色 ${session.role} 调用（允许：user / runtime，蓝图 §8.2）`, {
          detail: { role: session.role, allowed_roles: ["user", "runtime"] },
        });
      }
      const b = body || {};
      const projectId = projectOf(session, b.project_id);
      const report = await runRecovery(pctx, {
        projectId,
        actor: session.actor,
        drill: true,
        persistReport: true,
      });
      return {
        drill: report,
        note: "恢复演练已执行 §18.2 七步（基于持久记录与真实事务）；演练报告已留痕于 work/recovery/drills/；进程退出类故障注入由受控测试环境承载（§20.3 末段）",
      };
    },
  },
];
