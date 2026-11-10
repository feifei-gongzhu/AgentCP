/**
 * F1 —— 报告视图路由（规范 §19 报告与覆盖度）。
 * 归属模块：F1（报告服务）。蓝图 §5 端点 #39/#40。
 *
 *   - #39 GET /reports/vulnerabilities：漏洞报告视图——suspected 起草稿、
 *     状态/证据/条件/影响持续更新、确认版本与排除/争议同步当前视图、历史版本
 *     保留（?id=V-xxx 选单份，?version=vN 读历史版本）；
 *   - #40 GET /reports/milestones：阶段报告视图——数据截止版本与时间、已确认
 *     成果/未确认线索/已完成方向/受阻方向/未覆盖部分 + 覆盖度记录；
 *     ?refresh=1 显式生成新版本（默认读取不增殖版本），?version=vN 读历史。
 *
 * 权限面（蓝图 §8.2）：#39/#40 为只读视图，user 角色可读；携带会话时会话绑定
 * 项目必须与读取项目一致（跨项目拒绝，§11.2）；无会话的回环请求按 user 面
 * 只读处理（B1/D2 同法）。报告为派生资料：同步/生成只写 report_revisions 与
 * §5.2 reports/ 目录，不改业务对象状态、不发 Outbox 事件（蓝图 §6 目录无
 * report.* 类型；B1 快照先例，见竣工记录）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { getMilestoneReportView, getVulnerabilityReportView } from "../store/reportgen.mjs";

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

function optionalString(query, ...names) {
  for (const name of names) {
    const raw = query[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function refreshFlag(query) {
  return ["1", "true", "yes"].includes(String(query.refresh || "").toLowerCase());
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
  // #39 漏洞报告视图（§19：草稿起步、持续更新、历史保留、四向追溯）
  {
    method: "GET",
    path: "/sorne/reports/vulnerabilities",
    async handler(pctx, req, res, { query }) {
      const { projectId, actor } = readPlane(req, query);
      return getVulnerabilityReportView(pctx, {
        projectId,
        subjectId: optionalString(query, "id", "subject_id"),
        version: optionalString(query, "version"),
        actor,
        limit: limitParam(query),
        cursor: optionalString(query, "cursor"),
      });
    },
  },
  // #40 阶段报告视图（§19：数据截止版本与时间、五块内容 + 覆盖度）
  {
    method: "GET",
    path: "/sorne/reports/milestones",
    async handler(pctx, req, res, { query }) {
      const { projectId, actor } = readPlane(req, query);
      return getMilestoneReportView(pctx, {
        projectId,
        refresh: refreshFlag(query),
        version: optionalString(query, "version"),
        actor,
      });
    },
  },
];
