/**
 * Planner AI（规范 §3.1/§16.2/§16.3；蓝图阶段 E 的规划半边）。
 *
 * 合同：
 *   - 独立 LLM + 工具：与 Orchestrator/Worker/Verifier 各自独立会话、独立
 *     system 提示与工具面（§3.1「Planner 是专门负责整体规划的 AI」）。
 *   - 规划成果必须持久保存：工具面唯一落库通道是 submit_plan →
 *     C1 receivePlanRevision（planner 会话；plan_run 关联 §16.2），不能只
 *     存在一次模型回答。
 *   - 输入边界：planner_view 快照（§15.3）+ 自上次已接收规划以来的变化
 *     （change-log 只读视图）+ 现存意图清单；Planner 只确认自己输入边界内
 *     的事件（§16.1）。
 *   - 程序保障边界（§3.2）：循环步数上限；提交经 C1 全套校验（范围有效、
 *     前提版本、依赖死锁、幂等）——错误作为工具结果回灌，由 AI 调整。
 */
import { createHash } from "node:crypto";

import { issueSession } from "../store/sessions.mjs";
import { receivePlanRevision, listIntents } from "../store/intents.mjs";
import { generateSnapshot } from "../store/projection.mjs";
import { getRecord } from "../store/records-read.mjs";
import { readChangeLog } from "../store/changes.mjs";
import { getProjectContext, getProjectScope, getStore } from "../store/record-service.mjs";
import { runAgentLoop } from "./loop.mjs";
import { buildReconSummary } from "./recon.mjs";
import { openNode, listChildren, searchNodes, followRelations, navigateParent, readEvidenceSlice, saveBookmark, getBookmark } from "../store/reading.mjs";
import { beginRefresh, publishRefresh, getSummary, listPendingRefreshes } from "../store/summaries.mjs";

export const PLANNER_ACTOR = "planner-agent";

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 确定性 JSON（键排序）：幂等提交编号的稳定输入。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

/** 成本护栏：Planner 视图按结构裁剪（数组最多 10 项、字符串 1200 字），完整内容按需读取。 */
function compactView(value, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((v) => compactView(v, depth + 1));
    // §15.3：折叠必须保留计数与展开入口，不能让「未显示」变成「不存在」。
    return value.length > 10
      ? { items, total: value.length, omitted: value.length - 10, expand_via: "read_changes / read_record（按编号）" }
      : items;
  }
  if (value && typeof value === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= 30) { out.__omitted_keys__ = "…"; break; }
      out[k] = compactView(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 1200) return value.slice(0, 1200) + "…（截断）";
  return value;
}

const SYSTEM = [
  "你是持续探索型渗透测试系统的 Planner（专门负责整体规划的 AI，规范 §3.1）。",
  "职责：选择探索方向、定义意图、说明依据、安排优先级、修订计划；兼顾深入、扩展、补证与回访（§16.3）。",
  "你没有的权限：直接改数据库、确认漏洞、扩大授权范围（§3）；一切成果经 submit_plan 工具提交，由程序校验落库。",
  "项目目标与授权范围（阶段 1 统一上下文）：以供给面 project_context 中的 goal（task 优先，为空时回退 description；若 goal_missing=true 则显式标记目标缺失）和 scope.rules（allow / deny / pending）及 resource_policy 为唯一准绳，严禁跨项目套用旧目标或规划未授权目标（§17）。",
  "规划要求（§10.1）：一条意图围绕一个明确问题；完成条件说明需要得到什么回答或明确什么缺口，不要求必须发现漏洞；每条意图至少声明 1 项 deliverables（必要产物，如 \"带证据的观察记录\"），完成时 worker 需用真实记录编号为其作证。",
  "按任务与范围类型规划（不强制无关网络探测）："
    + "（1）当项目仅授权本地文件/离线材料或既有证据复核（如 file:// 范围或纯材料审计任务）时，可完全围绕材料检查、证据核对与代码/配置分析制定 investigate / verify 意图，禁止强行安排未授权网络探测；"
    + "（2）当项目授权了网络服务目标且目标要求主动探测或获取权限时，意图的 question/success_criteria 应包含 project_context.scope.rules.allow 中的具体目标（完整 URL 或主机+端口），并结合 recon 线索（均附 source_refs 证据编号）安排「具体请求 + 判据」的探测与验证意图。",
  "最新规划请求（plan_request）里的目标与明确动作是最高优先级：必须在本版计划中拆成意图覆盖，不能遗漏用户/协调者明确要求的动作（如关系绑定、接口模板、独立验证、利用链推进或本地材料核查）。",
  "资产/技术栈推进：已识别到的产品/框架/中间件/版本应安排意图登记为 asset_type=product/technology 的资产（canonical_key 写「产品 版本」、original_input 写证据编号，并关联服务资产）；同时可用 propose_endpoint_template 把可参数化路径登记为候选模板。",
  "先读取供给面（已作为开场内容提供），必要时用 read_record/read_changes 补充依据，然后调用 submit_plan 提交一版计划，最后用中文简述本版计划与理由。",
].join("\n");

/** 供给面（§15.3 Planner 视图 + §16.1 变化）：作为循环开场一次性注入。 */
async function plannerSupply(pctx, projectId) {
  const view = await generateSnapshot(pctx, { projectId, kind: "planner_view", actor: PLANNER_ACTOR });
  const log = await readChangeLog(pctx, { projectId, limit: 10 }); // 成本：事件只给 10 条
  const intents = await listIntents(pctx, { projectId, limit: 50 });
  let projectContext = null;
  try {
    projectContext = await getProjectContext(pctx, projectId);
  } catch {
    projectContext = null;
  }
  // 目标范围（可执行目标的来源；缺失不阻断规划，交由 C1/C2 的 SCOPE_UNRESOLVED 拒绝）
  let projectScope = null;
  try {
    projectScope = await getProjectScope(pctx, projectId);
  } catch {
    projectScope = null;
  }
  return {
    project_context: projectContext,
    project_scope: projectScope
      ? {
          configured: Boolean(projectScope.configured),
          scope_revision_id: projectScope.current ? projectScope.current.id : null,
          revision: projectScope.current ? projectScope.current.revision : null,
          rules: projectScope.current ? projectScope.current.rules : null,
          note: "意图的 question/完成条件应遵循这里 allow/deny/pending 规则；禁止规划范围外网络目标（§17）",
        }
      : null,
    planner_view: {
      snapshot_id: view.snapshot_id,
      snapshot_commit_seq: view.snapshot_commit_seq,
      // 成本护栏：视图按结构裁剪（大数组只留前 10 项），详情用 read_changes/read_record 读取。
      content: compactView(view.content),
      compact_note: "视图已裁剪：数组仅前 10 项、长字符串截断；需要明细时用 read_changes/read_record 按编号读取",
      folding_notes: view.folding_notes,
    },
    subscription: view.subscription ?? null,
    // 成本护栏：事件仅给类型/主体/序号，payload 可由 read_record/read_changes 按需读取。
    recent_events: log.events.map((e) => ({
      event_id: e.event_id,
      commit_seq: e.commit_seq,
      event_type: e.event_type,
      subject_ids: e.subject_ids,
    })),
    next_cursor: log.next_cursor,
    has_more: log.has_more,
    // 结构化侦察摘要（只读）：仅来自本项目既有证据，每条线索附 source_refs。
    recon: await buildReconSummary(pctx, projectId).catch(() => null),
    existing_intents: intents.intents
      ? intents.intents.slice(0, 20).map((i) => ({
          id: i.id,
          status: i.status,
          state_version: i.state_version,
          question: i.question,
          priority: i.priority,
        }))
      : [],
  };
}

export async function runPlanner(pctx, { projectId, model, planRunId, maxSteps = 10 }) {
  if (!projectId) throw new Error("runPlanner 需要 projectId");
  // TTL：见 orchestrator.mjs 同款说明（避免角色会话无界累积）。
  const session = issueSession({ project_id: projectId, actor: PLANNER_ACTOR, role: "planner", ttl_ms: 30 * 60 * 1000 });
  const supply = await plannerSupply(pctx, projectId);

  const tools = [
    {
      name: "read_changes",
      description: "按游标续读项目事件流（只读；next_cursor 续读，不跳过区间）。",
      parameters: {
        type: "object",
        properties: { after: { type: "string", description: "上一页 next_cursor（省略则从头）" } },
      },
      async execute(args) {
        const page = await readChangeLog(pctx, {
          projectId,
          after: typeof args.after === "string" && args.after ? args.after : null,
          limit: 20,
        });
        return { events: page.events, next_cursor: page.next_cursor, has_more: page.has_more };
      },
    },
    {
      name: "read_record",
      description: "按编号读取持久记录与证据索引（§11.2）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "记录编号，如 A-0002/O-0003/V-0002" } },
        required: ["id"],
      },
      async execute(args) {
        return getRecord(pctx, { projectId, id: String(args.id || "") });
      },
    },
    {
      name: "submit_plan",
      description:
        "提交一版计划（经程序校验落库：范围有效、前提版本、依赖死锁、幂等；intents[] 可为空表示仅确认消费边界）。",
      parameters: {
        type: "object",
        properties: {
          plan_revision: { type: "string", description: "计划版本标签，如 r2（1..64 位 [A-Za-z0-9._:-]）" },
          rationale: { type: "string", description: "本版计划的整体依据说明（入修订行）" },
          intents: {
            type: "array",
            description: "意图操作列表",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["create", "revise"] },
                local_ref: { type: "string", description: "提交内引用（非正式编号形态）" },
                question: { type: "string", description: "要回答的问题（create 必填）" },
                kind: { type: "string", enum: ["collect", "investigate", "verify", "revisit"] },
                rationale: { type: "string" },
                success_criteria: { type: "string" },
                target_asset_ids: { type: "array", items: { type: "string" } },
                basis_refs: { type: "array", items: { type: "string" } },
                deliverables: {
                  type: "array",
                  description: "必要产物（建议 1 项；字符串或 {key,description}）。完成时 worker 必须为每项提供真实记录证明才可 resolved（§10.1）",
                  items: {},
                },
                priority: { type: "integer" },
                intent_id: { type: "string", description: "op=revise 时必填" },
                expected_state_version: { type: "integer", description: "op=revise 时必填：待修订意图的当前 state_version（§11.3）" },
              },
              required: ["op"],
            },
          },
        },
        required: ["plan_revision", "intents"],
      },
      async execute(args) {
        // P0：确定性幂等键（同 plan_run + 同内容 → 同 submission_id → C1 返回原回执）。
        // 同一 run 同一 plan_revision 的不同内容仍会被 C1 的 UNIQUE/IDEMPOTENCY_KEY_REUSED 拒绝。
        const submissionId = "PLAN-" + sha256Hex(
          stableJson({
            project_id: projectId,
            plan_run_id: planRunId ?? null,
            plan_revision: String(args.plan_revision || ""),
            rationale: typeof args.rationale === "string" ? args.rationale : null,
            intents: Array.isArray(args.intents) ? args.intents : [],
          }),
        ).slice(0, 32);
        const envelope = {
          submission_id: submissionId,
          plan_revision: String(args.plan_revision || ""),
          ...(planRunId ? { plan_run_id: planRunId } : {}),
          ...(typeof args.rationale === "string" && args.rationale ? { rationale: args.rationale } : {}),
          intents: Array.isArray(args.intents) ? args.intents : [],
          input_boundary: String(supply.planner_view.snapshot_commit_seq),
        };
        return receivePlanRevision(pctx, { session, envelope });
      },
    },
    /* ── 阶段 5：分支摘要工具 ────────────────────────────────── */
    {
      name: "get_branch_summary",
      description: "获取分支摘要 + 即时判断状态 + 未汇总条目数（§十三：判断状态从记录直接读取，不等待摘要刷新）。",
      parameters: { type: "object", properties: { branch_id: { type: "string" }, branch_kind: { type: "string", enum: ["goal", "asset_type"] } }, required: ["branch_id"] },
      async execute(args) { return getSummary(pctx, { projectId, branchId: String(args.branch_id), branchKind: args.branch_kind || "goal" }); },
    },
    {
      name: "list_pending_refreshes",
      description: "列出有新内容未纳入摘要的分支（stale 状态）。",
      parameters: { type: "object", properties: {} },
      async execute() { return listPendingRefreshes(pctx, { projectId }); },
    },
    {
      name: "begin_summary_refresh",
      description: "开始刷新分支摘要：固定输入水位，返回子入口和判断快照供生成语义摘要。",
      parameters: { type: "object", properties: { branch_id: { type: "string" }, branch_kind: { type: "string", enum: ["goal", "asset_type"] } }, required: ["branch_id"] },
      async execute(args) { return beginRefresh(pctx, { projectId, branchId: String(args.branch_id), branchKind: args.branch_kind || "goal", actor: PLANNER_ACTOR }); },
    },
    {
      name: "publish_summary_refresh",
      description: "发布刷新结果：提交语义摘要，推进覆盖水位。刷新期间新增的记录继续标为待汇总。",
      parameters: {
        type: "object",
        properties: {
          branch_id: { type: "string" },
          semantic_summary: { type: "string", description: "语义摘要文本" },
          summary_refs: { type: "array", items: { type: "string" }, description: "摘要引用的记录编号" },
          incremental_prompt: { type: "string", description: "自上次摘要以来的变更提示" },
        },
        required: ["branch_id", "semantic_summary"],
      },
      async execute(args) {
        return publishRefresh(pctx, {
          projectId, branchId: String(args.branch_id),
          semanticSummary: args.semantic_summary,
          summaryRefs: args.summary_refs,
          incrementalPrompt: args.incremental_prompt,
          actor: PLANNER_ACTOR,
        });
      },
    },
    /* ── 阶段 2：主动阅读协议工具 ────────────────────────────── */
    {
      name: "read_open",
      description: "打开导航节点（根入口 root:assets / root:exploration，或任意记录编号）。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return openNode(pctx, { projectId, nodeId: String(args.node_id || "") }); },
    },
    {
      name: "read_children",
      description: "列出节点的子入口（分页；cursor 续读；§四 不能只看首页就认为看到全部）。",
      parameters: {
        type: "object",
        properties: { node_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } },
        required: ["node_id"],
      },
      async execute(args) { return listChildren(pctx, { projectId, nodeId: String(args.node_id), cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_search",
      description: "按关键词搜索记录（返回面包屑与来源；§四 搜索命中保留所属位置）。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, cursor: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
      },
      async execute(args) { return searchNodes(pctx, { projectId, query: args.query, kinds: args.kinds, cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_follow",
      description: "沿关系边跳转到关联节点（§五 跨分支关系）。",
      parameters: {
        type: "object",
        properties: { node_id: { type: "string" }, types: { type: "array", items: { type: "string" } }, direction: { type: "string", enum: ["outgoing","incoming","both"] } },
        required: ["node_id"],
      },
      async execute(args) { return followRelations(pctx, { projectId, nodeId: String(args.node_id), types: args.types, direction: args.direction }); },
    },
    {
      name: "read_parent",
      description: "返回上层节点（§四 当前路径缺少依据时返回并选择其他分支）。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return navigateParent(pctx, { projectId, nodeId: String(args.node_id) }); },
    },
    {
      name: "read_evidence_slice",
      description: "读取证据片段（返回 sha256、字节范围与内容；§十 记录实际读取范围）。",
      parameters: {
        type: "object",
        properties: { target_id: { type: "string" }, byte_offset: { type: "integer" }, byte_length: { type: "integer" } },
        required: ["target_id"],
      },
      async execute(args) {
        return readEvidenceSlice(pctx, { projectId, targetId: String(args.target_id), byteOffset: args.byte_offset, byteLength: args.byte_length, role: "planner", actorId: PLANNER_ACTOR });
      },
    },
    {
      name: "bookmark_save",
      description: "保存阅读书签（§四 阅读位置与执行位置分别维护）。",
      parameters: {
        type: "object",
        properties: { node_id: { type: "string" }, bookmark_key: { type: "string" }, note: { type: "string" } },
        required: ["node_id"],
      },
      async execute(args) {
        return saveBookmark(pctx, { projectId, role: "planner", actorId: PLANNER_ACTOR, nodeId: String(args.node_id), bookmarkKey: args.bookmark_key || "default", note: args.note });
      },
    },
    {
      name: "bookmark_read",
      description: "读取已保存的阅读书签。",
      parameters: { type: "object", properties: { bookmark_key: { type: "string" } } },
      async execute(args) { return getBookmark(pctx, { projectId, role: "planner", actorId: PLANNER_ACTOR, bookmarkKey: args.bookmark_key || "default" }); },
    },
  ];

  // 规划请求正文（§16.1/§16.2）：此前只传了 plan_run_id，Planner 看不到 request_planning 的
  // question，导致「用户/协调者要求」无法进入计划（J5 断链）。直接从 E1 动作记录取原文注入。
  let planRequest = null;
  if (planRunId) {
    try {
      const store = await getStore(pctx);
      const row = store.db
        .prepare(
          `SELECT oa.payload, od.rationale FROM orchestration_actions oa
             JOIN orchestration_decisions od ON od.id = oa.decision_id
            WHERE oa.project_id = ? AND oa.action_kind = 'request_planning' AND oa.result LIKE ?
            ORDER BY oa.created_seq DESC LIMIT 1`,
        )
        .get(projectId, `%${planRunId}%`);
      if (row) {
        let payload = {};
        try { payload = JSON.parse(row.payload) || {}; } catch { payload = {}; }
        planRequest = {
          question: typeof payload.question === "string" ? payload.question : null,
          record_refs: Array.isArray(payload.record_refs) ? payload.record_refs : [],
          urgency: typeof payload.urgency === "string" ? payload.urgency : null,
          rationale: typeof row.rationale === "string" ? row.rationale : null,
        };
      }
    } catch {
      planRequest = null;
    }
  }

  const opening = [
    `项目 ${projectId} 的 Planner 供给面（§15.3/§16.1）：`,
    JSON.stringify(supply, null, 1),
    planRunId ? `本次为规划请求 plan_run_id=${planRunId} 的响应（§16.1：同项目最多一个规划在途）。` : "",
    ...(planRequest
      ? [
          "本次规划请求正文（最高优先级，计划必须覆盖其中明确要求）：",
          JSON.stringify(planRequest, null, 1),
        ]
      : []),
    "导航入口（主动阅读已有证据和摘要再制定计划）：",
    "  root:assets — 资产根；root:exploration — 探索根",
    "  用 read_open / read_children / read_search / read_follow 按需展开，从证据和摘要获取依据。",
    "请基于以上 project_context（主目标 goal 与授权范围 scope.rules）及视图提交一版计划（submit_plan），说明每条意图的问题、依据、优先级与完成条件；"
      + "网络探测意图须引用 allow 规则中的授权目标，本地材料/证据审计意图可围绕授权文件或既有记录开展，每条意图声明至少一项 deliverables。",
  ].join("\n");

  const outcome = await runAgentLoop({ model, system: SYSTEM, tools, opening, maxSteps, role: "planner" });
  return { role: "planner", actor: PLANNER_ACTOR, project_id: projectId, plan_run_id: planRunId ?? null, ...outcome };
}
