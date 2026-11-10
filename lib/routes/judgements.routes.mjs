/**
 * D2 —— 判断分层与漏洞状态机路由（蓝图 §5 端点 #30）。
 * 归属模块：D2（判断分层与漏洞状态机）。
 *
 *   - #30 GET /vulnerabilities：漏洞台账视图（§8.2/§19）——状态与复核状态分列、
 *     条件与证据入口、游标分页不静默截断；
 *   - 观察/假设/漏洞（suspected）与关系的写入走 A1 的 /sorne/submissions 操作集；
 *     Fact 准入（record_fact，verifier 会话）与 §7.1–§7.3 资产/样本/模板/候选组
 *     操作由本模块注册进同一提交信封（lib/store/judgements.mjs、lib/store/dedup.mjs，
 *     经下方 import 触发注册）；
 *   - 状态转换（§8.4 合同）没有 HTTP 端点：全系统唯一入口是 §2.7 冻结签名
 *     applyStateTransition（D1 的 §12.2 核心事务调用），不经请求面直改状态。
 *
 * 权限（蓝图 §8.2）：#30 为只读视图，user 角色可读；携带会话时会话绑定项目必须
 * 与读取项目一致（跨项目拒绝，§11.2）；无会话的回环请求按 user 面只读处理
 * （需显式 project_id，与 C1 #21 同法）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { listVulnerabilities, REVIEW_STATUSES, VULNERABILITY_STATUSES } from "../store/judgements.mjs";
import { CANONICALIZATION_VERSION } from "../store/dedup.mjs"; // 副作用：注册 D2 提交操作

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
  return { session, projectId };
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
  // #30 漏洞台账视图（§8.2 状态与复核分列；§19 条件与证据入口）
  {
    method: "GET",
    path: "/sorne/vulnerabilities",
    async handler(pctx, req, res, { query }) {
      const { projectId } = readPlane(req, query);
      return listVulnerabilities(pctx, {
        projectId,
        statuses: csvParam(query, "status", VULNERABILITY_STATUSES, "漏洞状态"),
        reviews: csvParam(query, "review", REVIEW_STATUSES, "复核状态"),
        assetId: typeof query.asset_id === "string" && query.asset_id ? query.asset_id : undefined,
        category: typeof query.category === "string" && query.category ? query.category : undefined,
        limit: limitParam(query),
        cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : undefined,
      });
    },
  },
];

/** 供诊断/文档引用：D2 资产规范化规则版本（§7.1 规则版本化）。 */
export const D2_CANONICALIZATION_VERSION = CANONICALIZATION_VERSION;
