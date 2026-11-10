/**
 * Orchestrator AI（规范 §3.1/§3.3/§18.5/§18.6；蓝图阶段 E 的协调半边）。
 *
 * 合同：
 *   - 独立 LLM + 工具实现（§3.1「Orchestrator 就是主 AI」；与 Planner 分别的
 *     独立会话与工具面）；理解计划与实际进展，决定直接交接、追问、安排执行、
 *     请求规划或请求独立验证，不被降为固定流程引擎。
 *   - 每次协调决定持久保存：唯一落库通道 submit_decision → E1 recordDecision
 *     （决定+动作，每动作独立幂等编号）+ executeDecisionActions（程序执行
 *     AI 已提交的分配决定：assign_execution 经 C2 条件领取建租约等）。
 *   - 输入面：E1 orchestratorOverview（当前计划、活跃/受阻方向、未处理汇报、
 *     资源与待决事项，§18.6 工作面板）+ 只读事件流。
 *   - 程序保障边界（§3.2）：动作白名单与资源上限由 E1/C2 校验；越权/失效前提
 *     的动作被拒绝，错误作为工具结果回灌，由 AI 调整。
 */
import { issueSession } from "../store/sessions.mjs";
import {
  executeDecisionActions,
  orchestratorOverview,
  recordDecision,
} from "../store/orchestrator.mjs";
import { getRecord } from "../store/records-read.mjs";
import { readChangeLog } from "../store/changes.mjs";
import { getStore } from "../store/record-service.mjs";
import { markMessageProcessing } from "../store/messages.mjs";
import { readBlobBytes } from "../store/evidence.mjs";
import { listVerificationPolicies } from "../store/verification.mjs";
import { runAgentLoop } from "./loop.mjs";
import { buildReconSummary } from "./recon.mjs";
import { openNode, listChildren, searchNodes, followRelations, navigateParent, readEvidenceSlice, saveBookmark, getBookmark } from "../store/reading.mjs";
import { shelveBranch, resumeBranch, listShelvedBranches, evaluateWakeConditions, phaseBoundaryCheckpoint, recoverContext } from "../store/scheduling.mjs";

export const ORCHESTRATOR_ACTOR = "orchestrator-agent";

/** 读取待处理用户消息（§2.6-2：附件以编号注入上下文，AI 经 read_record/read_blob 取字节）。 */
async function loadPendingUserMessages(pctx, projectId, max = 4) {
  const store = await getStore(pctx);
  return store.runSerial((db) =>
    db
      .prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM message_links l WHERE l.message_id = m.id) AS link_count
           FROM messages m WHERE m.project_id = ? AND m.direction = 'user' AND m.status IN ('received','processing')
          ORDER BY m.created_seq, m.id LIMIT ?`,
      )
      .all(projectId, max),
  );
}

/** 待处理用户消息的关联与附件编号（注入上下文的紧凑形态）。 */
function messageBrief(db, row) {
  const links = db
    .prepare("SELECT link_kind, ref_id FROM message_links WHERE message_id = ? ORDER BY link_kind, ref_id")
    .all(row.id);
  const refs = links.map((l) => `[${l.link_kind} ${l.ref_id}]`);
  const attachments = links
    .filter((l) => l.link_kind === "blob" || l.link_kind === "capture")
    .map((l) => l.ref_id);
  return { id: row.id, content: row.content, refs, attachments };
}

const SYSTEM = [
  "你是持续探索型渗透测试系统的 Orchestrator（主协调 AI，规范 §3.1/§3.3）。",
  "职责：理解当前项目的计划与实际进展，回答「目前由谁推进、如何并行、怎样交接、遇到阻塞怎么办、是否需要调整计划」。",
  "你没有的权限：绕过范围、证据准入、资源上限或独立验证（§3）；一切决定经 submit_decision 工具提交，由程序执行并保存结果。",
  "项目目标与授权范围（阶段 1 统一上下文）：严格依据工作面板 project_context 中的主目标（goal：task 优先，为空回退 description；若 goal_missing=true 则标记目标缺失）、授权范围（scope.rules 的 allow / deny / pending）与资源限制（resource_policy）做协调决定，不得跨项目混用目标或授权。",
  "意图调整与派发边界：assign_execution 仅分配已持久化的意图（传 intent_id / worker_id / handoff_summary），禁止在派发时静默改写意图的问题、目标资产或完成条件；"
    + "若需修改现存意图的问题、目标或完成条件，必须使用 revise_intent 动作（持久化修订并推进版本）或使用 request_planning 请求 Planner 重新规划。",
  "决定词汇（action_kind）：assign_execution 分配执行；revise_intent 持久化修订现存意图；suspend/resume/cancel_execution 暂缓/恢复/取消；request_verification 请求独立验证；request_planning 请求重新规划；followup 追问 worker；attach_context 补充上下文；handle_report 处理汇报；set_execution_limits 设并行上限；record_strategy 记录策略决定（continue/ask/switch_method/defer/replan）。",
  "受阻不是一律重试：相同条件下反复失败时评估继续是否有价值，选择追问、换方法、暂缓或请求重新规划并保存理由与恢复条件（§16.3）。",
  "孤儿意图不变式：orphaned_running_intents 由程序确定性对账（无活跃 Attempt 的 running 意图会自动退回 queued 或按死胡同搁置），正常应恒为 0。若该信号 > 0，说明对账尚未跑到或存在异常，视情况正常派发 queued 意图即可，无需手动修复。",
  "疑似漏洞的确认只能经独立验证：对已有证据链、值得确认的 suspected 记录，用 request_verification 动作发起独立验证（payload 至少含 subject_id、policy_id、policy_version；证据/条件字段按 D1 合同从 read_record 的 evidence_index 取编号填入）；没有证据链时先 assign_execution 补齐。你自己不得把状态改成 confirmed（§8.3/§8.4）。",
  "读取开场的工作面板后，调用 submit_decision 提交本次协调决定，最后用中文简述决定与理由。",
].join("\n");

export async function runOrchestrator(pctx, { projectId, model, maxSteps = 10 }) {
  if (!projectId) throw new Error("runOrchestrator 需要 projectId");
  // 会话 TTL：角色循环每次 tick 新建会话，若不设过期会无限累积（实测 40 分钟 34 个）。
  // TTL 只影响进程内注册表；持久对象身份不依赖会话。
  const session = issueSession({ project_id: projectId, actor: ORCHESTRATOR_ACTOR, role: "orchestrator", ttl_ms: 30 * 60 * 1000 });
  const overview = await orchestratorOverview(pctx, { session, projectId });
  const log = await readChangeLog(pctx, { projectId, limit: 10 }); // 成本：事件只给 10 条

  // M2（§2.6-2）：待处理用户消息进入面板（附件以编号注入；字节经既有工具按需读取）；
  // 读取即置 processing（received → processing → handled；读取后未提交决定不算已处理）
  const store = await getStore(pctx);
  const pendingMessages = store.db
    .prepare(
      `SELECT * FROM messages WHERE project_id = ? AND direction = 'user' AND status IN ('received','processing')
        ORDER BY created_seq, id LIMIT 4`,
    )
    .all(projectId);
  const messageBriefs = [];
  for (const row of pendingMessages) {
    await markMessageProcessing(pctx, { projectId, messageId: row.id });
    messageBriefs.push(messageBrief(store.db, row));
  }

  const tools = [
    {
      name: "read_changes",
      description: "按游标续读项目事件流（只读）。",
      parameters: {
        type: "object",
        properties: { after: { type: "string", description: "上一页 next_cursor" } },
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
      description: "按编号读取持久记录（汇报/判断/资产等，§11.2）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      async execute(args) {
        return getRecord(pctx, { projectId, id: String(args.id || "") });
      },
    },
    {
      // M2（§2.6-2 冻结通道）：附件字节经既有证据读取通道按需获取（不复制进消息）；
      // 文本形态直接返回（限 4KB），二进制返回 sha256 校验与字节大小，不内联大 payload
      name: "read_blob",
      description:
        "按 sha256 读取本项目固定 Blob 的字节（消息附件等原始证据；§15.4 按需获取，不默认全量送入上下文）。",
      parameters: {
        type: "object",
        properties: { sha256: { type: "string", description: "Blob 的完整 SHA-256（或 B- 编号）" } },
        required: ["sha256"],
      },
      async execute(args) {
        let sha = String(args.sha256 || "").trim();
        if (!/^[0-9a-f]{64}$/i.test(sha)) {
          const store = await getStore(pctx);
          const row = store.db.prepare("SELECT sha256 FROM blobs WHERE project_id = ? AND id = ?").get(projectId, sha);
          if (!row) return { error: "INVALID_REFERENCE", message: `Blob 不存在于本项目：${sha}` };
          sha = row.sha256;
        }
        try {
          const { bytes, row } = await readBlobBytes(pctx, { sha256: sha, projectId });
          // 文本判定按字节内容（不含 NUL 即按文本内联；限 4KB），与表示形式解耦
          const isText = !bytes.subarray(0, Math.min(bytes.length, 512)).includes(0);
          if (isText && bytes.length <= 4096) {
            return { sha256: sha, byte_size: bytes.length, representation: row.representation, text: bytes.toString("utf8") };
          }
          return {
            sha256: sha,
            byte_size: bytes.length,
            representation: row.representation,
            text: null,
            note: `二进制或超大内容不内联（${bytes.length} 字节）；完整性已校验（sha256 匹配）`,
          };
        } catch (error) {
          return { error: error?.code ?? "EVIDENCE_NOT_COMMITTED", message: String(error?.message ?? error) };
        }
      },
    },
    {
      name: "submit_decision",
      description:
        "提交一次协调决定并执行其动作（E1 持久化：决定+动作+执行结果；程序执行 assign_execution 等分配决定）。",
      parameters: {
        type: "object",
        properties: {
          rationale: { type: "string", description: "简要理由（非空，≤4000 字，§3.3）" },
          input_report_ids: { type: "array", items: { type: "string" }, description: "输入汇报引用" },
          input_event_refs: { type: "array", items: { type: "string" }, description: "输入事件引用" },
          source_message_id: {
            type: "string",
            description: "本次决定所处理的用户消息编号（MSG-…）；决定持久化时消息置 handled 并自动回复用户（§2.6-2）",
          },
          actions: {
            type: "array",
            description: "1..16 个动作，每动作独立幂等编号",
            items: {
              type: "object",
              properties: {
                action_kind: {
                  type: "string",
                  enum: [
                    "assign_execution", "revise_intent", "suspend_execution", "resume_execution", "cancel_execution",
                    "request_verification", "request_planning", "followup", "attach_context",
                    "handle_report", "set_execution_limits", "record_strategy",
                  ],
                },
                idempotency_key: { type: "string", description: "1..128 位 [A-Za-z0-9._:-]" },
                payload: { type: "object", description: "动作载荷（如 assign_execution: intent_id/worker_id/handoff_summary；revise_intent: intent_id/expected_state_version/question/success_criteria；request_planning: question）" },
              },
              required: ["action_kind", "idempotency_key"],
            },
          },
        },
        required: ["rationale", "actions"],
      },
      async execute(args) {
        const decision = await recordDecision(pctx, {
          session,
          inputReportIds: Array.isArray(args.input_report_ids) ? args.input_report_ids : [],
          inputEventRefs: Array.isArray(args.input_event_refs) ? args.input_event_refs : [],
          rationale: String(args.rationale || ""),
          actions: Array.isArray(args.actions) ? args.actions : [],
          sourceMessageId: typeof args.source_message_id === "string" && args.source_message_id.trim() ? args.source_message_id.trim() : undefined,
        });
        const executed = await executeDecisionActions(pctx, { projectId, decisionId: decision.id });
        return executed;
      },
    },
    /* ── 阶段 6：检查点与调度工具 ────────────────────────────── */
    {
      name: "shelve_branch",
      description: "搁置一个分支并记录原因、范围和唤醒条件（§十四/§十六）。",
      parameters: {
        type: "object",
        properties: {
          branch_id: { type: "string", description: "分支标识（意图/目标 ID）" },
          branch_kind: { type: "string", enum: ["intent", "goal", "asset"] },
          shelve_reason: { type: "string", enum: ["insufficient_evidence", "conditions_unmet", "unrelated", "cost_too_high", "hypothesis_falsified", "blocked", "unknown"] },
          reason_detail: { type: "string" },
          scope: { type: "string" },
          reconsider_conditions: { type: "array", items: { type: "string" } },
          wake_on_event_types: { type: "array", items: { type: "string" } },
        },
        required: ["branch_id", "shelve_reason"],
      },
      async execute(args) {
        return shelveBranch(pctx, { projectId, branchId: args.branch_id, branchKind: args.branch_kind, shelveReason: args.shelve_reason, reasonDetail: args.reason_detail, scope: args.scope, reconsiderConditions: args.reconsider_conditions, wakeOnEventTypes: args.wake_on_event_types, actor: ORCHESTRATOR_ACTOR });
      },
    },
    {
      name: "resume_branch",
      description: "恢复搁置的分支。",
      parameters: { type: "object", properties: { branch_id: { type: "string" }, resume_note: { type: "string" } }, required: ["branch_id"] },
      async execute(args) { return resumeBranch(pctx, { projectId, branchId: args.branch_id, actor: ORCHESTRATOR_ACTOR, resumeNote: args.resume_note }); },
    },
    {
      name: "list_shelved",
      description: "列出搁置的分支及其唤醒条件。",
      parameters: { type: "object", properties: {} },
      async execute() { return listShelvedBranches(pctx, { projectId }); },
    },
    {
      name: "check_wake_conditions",
      description: "检查搁置分支是否有匹配的唤醒事件（§十六：根据相关变化唤醒）。",
      parameters: { type: "object", properties: {} },
      async execute() { return evaluateWakeConditions(pctx, { projectId }); },
    },
    {
      name: "save_checkpoint",
      description: "在阶段边界创建检查点（§十四：当前问题/阅读位置/依据/假设/变化/下一步）。",
      parameters: { type: "object", properties: { intent_id: { type: "string" }, attempt_id: { type: "string" }, phase_note: { type: "string" } } },
      async execute(args) { return phaseBoundaryCheckpoint(pctx, { projectId, intentId: args.intent_id, attemptId: args.attempt_id, actor: ORCHESTRATOR_ACTOR, phaseNote: args.phase_note }); },
    },
    {
      name: "recover_context",
      description: "恢复入口：读取最近检查点 + 等待状态 + 搁置分支唤醒条件。",
      parameters: { type: "object", properties: {} },
      async execute() { return recoverContext(pctx, { projectId }); },
    },
    /* ── 阶段 2：主动阅读协议工具 ────────────────────────────── */
    {
      name: "read_open",
      description: "打开导航节点（根入口 root:assets / root:exploration，或记录编号）。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return openNode(pctx, { projectId, nodeId: String(args.node_id || "") }); },
    },
    {
      name: "read_children",
      description: "列出节点的子入口（分页；cursor 续读）。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } }, required: ["node_id"] },
      async execute(args) { return listChildren(pctx, { projectId, nodeId: String(args.node_id), cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_search",
      description: "按关键词搜索记录（返回面包屑与来源）。",
      parameters: { type: "object", properties: { query: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, cursor: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      async execute(args) { return searchNodes(pctx, { projectId, query: args.query, kinds: args.kinds, cursor: args.cursor, limit: args.limit }); },
    },
    {
      name: "read_follow",
      description: "沿关系边跳转到关联节点。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, types: { type: "array", items: { type: "string" } }, direction: { type: "string", enum: ["outgoing","incoming","both"] } }, required: ["node_id"] },
      async execute(args) { return followRelations(pctx, { projectId, nodeId: String(args.node_id), types: args.types, direction: args.direction }); },
    },
    {
      name: "read_parent",
      description: "返回上层节点。",
      parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
      async execute(args) { return navigateParent(pctx, { projectId, nodeId: String(args.node_id) }); },
    },
    {
      name: "read_evidence_slice",
      description: "读取证据片段（返回 sha256、字节范围与内容）。",
      parameters: { type: "object", properties: { target_id: { type: "string" }, byte_offset: { type: "integer" }, byte_length: { type: "integer" } }, required: ["target_id"] },
      async execute(args) {
        return readEvidenceSlice(pctx, { projectId, targetId: String(args.target_id), byteOffset: args.byte_offset, byteLength: args.byte_length, role: "orchestrator", actorId: ORCHESTRATOR_ACTOR });
      },
    },
    {
      name: "bookmark_save",
      description: "保存阅读书签。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, bookmark_key: { type: "string" }, note: { type: "string" } }, required: ["node_id"] },
      async execute(args) {
        return saveBookmark(pctx, { projectId, role: "orchestrator", actorId: ORCHESTRATOR_ACTOR, nodeId: String(args.node_id), bookmarkKey: args.bookmark_key || "default", note: args.note });
      },
    },
    {
      name: "bookmark_read",
      description: "读取已保存的阅读书签。",
      parameters: { type: "object", properties: { bookmark_key: { type: "string" } } },
      async execute(args) { return getBookmark(pctx, { projectId, role: "orchestrator", actorId: ORCHESTRATOR_ACTOR, bookmarkKey: args.bookmark_key || "default" }); },
    },
  ];

  const verificationPolicies = listVerificationPolicies().map((p) => ({
    policy_id: p.id,
    policy_version: p.version,
    required_checks: p.required_checks,
    description: p.description,
  }));

  // 结构化侦察摘要（只读）：让协调者知道当前项目已有哪些可追溯证据线索与候选入口面。
  const recon = await buildReconSummary(pctx, projectId).catch(() => null);
  const reconBrief = recon
    ? {
        project_id: recon.project_id,
        product: recon.product,
        version: recon.version,
        server: recon.server,
        php: recon.php,
        title: recon.title,
        template: recon.template,
        candidate_surface: (recon.candidate_surface || []).map((x) => ({
          path: x.path,
          surfaces: x.surfaces,
          next: x.next,
          source_refs: x.source_refs || [],
        })),
        observed_paths: (recon.observed_paths || []).slice(0, 12),
        clues: recon.clues || [],
        evidence: recon.evidence || [],
        note: recon.note,
      }
    : null;

  const opening = [
    `项目 ${projectId} 的 Orchestrator 工作面板（§18.6）：`,
    JSON.stringify(overview, null, 1),
    "侦察摘要（只读；来自既有证据，产品级入口面=候选未验证，派单时要求带判据）：",
    JSON.stringify(reconBrief, null, 1),
    "可用验证策略（request_verification 的 payload 需携带 policy_id/policy_version；\"未注册策略\"会整条拒绝）：",
    JSON.stringify(verificationPolicies, null, 1),
    "最近事件（只读）：",
    JSON.stringify(log.events.map((e) => ({ event_type: e.event_type, subject_ids: e.subject_ids, commit_seq: e.commit_seq })), null, 1),
    ...(messageBriefs.length
      ? [
          "待处理用户消息（delivered ≠ handled：处理哪条就在 submit_decision 携带其 source_message_id；"
            + "附件与引用以编号给出，字节经 read_record / read_blob 按需读取）：",
          JSON.stringify(messageBriefs, null, 1),
        ]
      : []),
    "导航入口（主动阅读证据和分支摘要，了解实际进展再做协调决定）：",
    "  root:assets — 资产根；root:exploration — 探索根",
    "  用 read_open / read_children / read_search / read_follow / recover_context 按需展开。",
    "请按当前计划与进展提交本次协调决定（submit_decision）。",
  ].join("\n");

  const outcome = await runAgentLoop({ model, system: SYSTEM, tools, opening, maxSteps, role: "orchestrator" });
  return { role: "orchestrator", actor: ORCHESTRATOR_ACTOR, project_id: projectId, ...outcome };
}
