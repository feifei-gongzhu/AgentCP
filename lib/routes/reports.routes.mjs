/**
 * E2 —— 分层汇报服务路由（规范 §18.3 §18.4 §18.5 §11.2；蓝图端点 #37/#38）。
 * 归属模块：E2（分层汇报服务）。
 *
 *   - #37 POST /sorne/worker-reports：提交分层汇报。仅 worker 会话可调用
 *     （蓝图 §8.2 worker 行含 #37），且只能汇报派给自己的 Attempt；
 *     project_id/actor 以程序签发会话为准（§11.1），自报一律忽略；
 *     程序在事务内检查覆盖（§18.4）与引用有效性，通过后持久保存汇报及
 *     worker_report.submitted 事件（§18.5-3）。
 *   - #38 GET /sorne/worker-reports/:id：按层读取（layer=handoff_card 默认 /
 *     key_records / full_basis，§18.3 三层）。携带会话时按会话项目域校验；
 *     无会话的回环请求按 user 面只读（需显式 project_id，蓝图 §8.2 user 行
 *     「各只读视图」）；跨项目一律 404 不泄露存在性（§11.2 访问权校验）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import {
  MAX_HANDOFF_BUDGET,
  MIN_HANDOFF_BUDGET,
  readWorkerReport,
  submitWorkerReport,
} from "../store/reports.mjs";

export const REPORT_LAYERS = ["handoff_card", "key_records", "full_basis"];

export const routes = [
  // #37 提交分层汇报（交接卡/关键记录/完整依据；程序检查覆盖与引用，§18.4）
  {
    method: "POST",
    path: "/sorne/worker-reports",
    async handler(pctx, req, res, { body }) {
      const session = sessionFromRequest(req);
      if (!session) {
        throw apiError(
          "TRUST_DENIED",
          "POST /worker-reports 需要程序签发的 worker 会话（请求头 x-sorne-session）；project_id/actor/角色由服务端会话决定（§11.1）",
        );
      }
      if (session.role !== "worker") {
        throw apiError(
          "TRUST_DENIED",
          `分层汇报仅 worker 角色可提交（蓝图 §8.2）；当前会话角色为 ${session.role}（actor=${session.actor}）`,
          { detail: { role: session.role, required: "worker" } },
        );
      }
      return submitWorkerReport(pctx, { session, body });
    },
  },
  // #38 按层读取：交接摘要、关键记录、完整依据（§18.3 三层；交接卡预算分页）
  {
    method: "GET",
    path: "/sorne/worker-reports/:id",
    async handler(pctx, req, res, { params, query }) {
      const session = sessionFromRequest(req);
      const reportId = params.id;
      // 鉴权：先按编号定位行（同项目域校验；跨项目 404 不泄露存在性）
      const { getStore } = await import("../store/record-service.mjs");
      const store = await getStore(pctx);
      const row = store.db
        .prepare("SELECT project_id FROM worker_reports WHERE id = ?")
        .get(reportId);
      const ownerProject = row ? row.project_id : null;
      if (session && session.project_id) {
        if (ownerProject && session.project_id !== ownerProject) {
          throw apiError("NOT_FOUND", `汇报不存在：${reportId}`);
        }
      } else {
        // 无会话：user 面只读，需显式 project_id（B1/C1/C2 只读面先例）
        const qp = typeof query.project_id === "string" ? query.project_id : "";
        if (!qp) {
          throw apiError("BAD_REQUEST", "缺少 project_id（无会话的只读请求需显式 project_id，§11.2）");
        }
        if (ownerProject && qp !== ownerProject) {
          throw apiError("NOT_FOUND", `汇报不存在：${reportId}`);
        }
      }
      const layer = query.layer === undefined || query.layer === "" ? "handoff_card" : String(query.layer);
      if (!REPORT_LAYERS.includes(layer)) {
        throw apiError("BAD_REQUEST", `layer 必须是 ${REPORT_LAYERS.join(" / ")} 之一（§18.3 三层）`, {
          detail: { allowed: REPORT_LAYERS },
        });
      }
      let page = 1;
      if (query.page !== undefined && query.page !== "") {
        page = Number(query.page);
        if (!Number.isInteger(page) || page < 1 || page > 2000) {
          throw apiError("BAD_REQUEST", "page 必须是 1..2000 的整数");
        }
      }
      let budget;
      if (query.budget !== undefined && query.budget !== "") {
        budget = Number(query.budget);
        if (!Number.isInteger(budget) || budget < MIN_HANDOFF_BUDGET || budget > MAX_HANDOFF_BUDGET) {
          throw apiError(
            "BAD_REQUEST",
            `budget 必须是 ${MIN_HANDOFF_BUDGET}..${MAX_HANDOFF_BUDGET} 的整数（交接卡长度预算，§18.3）`,
          );
        }
      }
      const includeBase = query.include_base === "1" || query.include_base === "true";
      return readWorkerReport(pctx, { reportId, layer, page, budget, includeBase });
    },
  },
];
