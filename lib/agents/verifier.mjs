/**
 * Verifier AI（规范 §3.1/§8.3/§12；蓝图阶段 D 的验证半边）。
 *
 * 合同：
 *   - 独立 LLM + 工具；独立会话（actor 与发现者不同——发现者不能自行确认
 *     自己的漏洞是程序硬校验，§2 约束 6/§8.3，submitVerificationResult 的
 *     TRUST_DENIED 路径）。模型型 verifier 使用独立验证上下文，事实型元数据
 *     与原始证据优先（§8.3）。
 *   - 输入面：验证任务（§8.3 要求的明确判断/条件/证据索引/反对证据/策略及
 *     版本）+ 不可变证据清单（§12.1 Manifest）成员的原始记录。
 *   - 结论面：submit_result → D1 submitVerificationResult（校验判断版本/策略/
 *     Manifest/引用/独立性，§12.2 核心事务：全部匹配且检查通过才应用状态转换，
 *     否则保留意见标记复核）。检查项未覆盖时必须返回 insufficient 或 conflicting，
 *     不得以通用置信分替代（§8.3）。
 */
import { issueSession } from "../store/sessions.mjs";
import { listVerificationJobs, submitVerificationResult } from "../store/verification.mjs";
import { getRecord } from "../store/records-read.mjs";
import { readBlobBytes } from "../store/evidence.mjs";
import { getProjectContext } from "../store/record-service.mjs";
import { runAgentLoop } from "./loop.mjs";
import { openNode, listChildren, searchNodes, followRelations, navigateParent, readEvidenceSlice, saveBookmark, getBookmark } from "../store/reading.mjs";
import { saveCheckRecord } from "../store/coverage.mjs";

export const VERIFIER_ACTOR = "verifier-agent";

const SYSTEM = [
  "你是持续探索型渗透测试系统的独立 Verifier（规范 §3.1/§8.3）。",
  "职责：核查待验证判断——必要的环境与身份条件、原始证据索引、相关反对证据、验证策略及其版本。",
  "你没有的权限：扩展授权、无证据确认、用规划优先级替代真实性判断（§3）。结论只能基于证据与明确条件。",
  "outcome 词汇：supported（支持）/ falsified（明确排除当前判断）/ insufficient（证据不足，不伪装成已排除）/ conflicting（实质矛盾）。",
  "策略 required_checks 未覆盖时必须返回 insufficient 或 conflicting，不得以置信分替代检查项（§8.3）。",
  "先用开场材料核对 Manifest 成员与反对证据（可用 read_record/read_blob 补充），然后 submit_result 提交结论，最后用中文简述依据与限制。",
].join("\n");

/** 任务详情（§8.3 输入面；§12.1 清单绑定——成员明细经 read_record 按需展开）。 */
async function verifierSupply(pctx, projectId, jobId) {
  const listing = await listVerificationJobs(pctx, { projectId, statuses: ["pending", "in_progress"] });
  const job = listing.jobs.find((j) => j.id === jobId) || null;
  if (!job) {
    const any = await listVerificationJobs(pctx, { projectId });
    const byId = any.jobs.find((j) => j.id === jobId) || null;
    if (!byId) return { job: null, note: `任务 ${jobId} 不存在（项目 ${projectId}）` };
    return { job: byId, note: "任务已不在 pending/in_progress（可能已完成或被取代）" };
  }
  return { job, note: null };
}

export async function runVerifier(pctx, { projectId, jobId, model, verifierIdentity, maxSteps = 10 }) {
  if (!projectId || !jobId) throw new Error("runVerifier 需要 projectId 与 jobId");
  const identity = verifierIdentity || `${VERIFIER_ACTOR}:${model?.model ?? "default"}`;
  // TTL：见 orchestrator.mjs 同款说明（避免角色会话无界累积）。
  const session = issueSession({ project_id: projectId, actor: VERIFIER_ACTOR, role: "verifier", ttl_ms: 30 * 60 * 1000 });
  const supply = await verifierSupply(pctx, projectId, jobId);
  if (!supply.job) {
    return { role: "verifier", actor: VERIFIER_ACTOR, project_id: projectId, job_id: jobId, stop_reason: "no_job", trace: [], final: supply.note };
  }
  const job = supply.job;
  const subject = await getRecord(pctx, { projectId, id: job.subject_id }).catch((e) => ({ error: String(e?.message ?? e) }));
  const projectContext = await getProjectContext(pctx, projectId).catch(() => null);

  const tools = [
    {
      name: "read_record",
      description: "按编号读取持久记录与证据索引（观察/假设/漏洞/采集等，§11.2）。",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(args) {
        return getRecord(pctx, { projectId, id: String(args.id || "") });
      },
    },
    {
      name: "read_blob",
      description: "读取原始证据字节（按 SHA-256，§8.3/§18.3 完整依据层；返回解码文本摘要）。",
      parameters: {
        type: "object",
        properties: { sha256: { type: "string", description: "Blob 完整 SHA-256（来自记录的证据索引）" } },
        required: ["sha256"],
      },
      async execute(args) {
        const bytes = await readBlobBytes(pctx, { sha256: String(args.sha256 || ""), projectId });
        return {
          byte_size: bytes.byteLength,
          excerpt: bytes.subarray(0, 4000).toString("utf8"),
          note: "前 4000 字节摘要；完整字节经 /sorne/evidence/blobs/{sha256} 读取",
        };
      },
    },
    {
      name: "submit_result",
      description:
        "提交验证结果（§8.3/§12.2：程序校验判断版本/策略/Manifest/引用/独立性；全部匹配且检查通过才应用状态转换）。",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["supported", "falsified", "insufficient", "conflicting"] },
          checks: {
            type: "array",
            description: "逐项检查结果（策略 required_checks 的每项都必须出现且 passed=true 才可能确认）",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "检查项名称（与策略 required_checks 按名匹配）" },
                passed: { type: "boolean" },
                note: { type: "string", description: "检查说明/依据" },
              },
              required: ["name", "passed"],
            },
          },
          supporting_refs: { type: "array", items: { type: "string" } },
          opposing_refs: { type: "array", items: { type: "string" } },
          limitations: { type: "string" },
          suggested_followups: { type: "array", items: { type: "string" } },
        },
        required: ["outcome", "checks"],
      },
      async execute(args) {
        return submitVerificationResult(pctx, {
          session,
          input: {
            job_id: job.id,
            verifier_identity: identity,
            verifier_kind: "llm_agent",
            policy_version: job.policy_version,
            reviewed_manifest_id: job.evidence_manifest_id,
            reviewed_evidence_revision: job.manifest ? job.manifest.evidence_revision : job.expected.evidence_revision,
            claim_revision: job.claim_revision,
            expected_state_version: job.expected.state_version,
            expected_assessment_epoch: job.expected.assessment_epoch,
            outcome: args.outcome,
            checks: Array.isArray(args.checks) ? args.checks : [],
            supporting_refs: Array.isArray(args.supporting_refs) ? args.supporting_refs : [],
            opposing_refs: Array.isArray(args.opposing_refs) ? args.opposing_refs : [],
            limitations: typeof args.limitations === "string" ? args.limitations : "",
            suggested_followups: Array.isArray(args.suggested_followups) ? args.suggested_followups : [],
          },
        });
      },
    },
    /* ── 阶段 4：覆盖记录工具 ────────────────────────────────── */
    {
      name: "save_check_record",
      description:
        "保存一条检查记录（§十：记录检查范围与未覆盖部分）。Verifier 从 Manifest 定位原始片段后，"
        + "记录实际检查的材料、方法和结论，标注未覆盖部分。",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "string", description: "关联意图编号" },
          material_ids: { type: "array", items: { type: "string" }, description: "涉及材料的记录编号" },
          material_range: { type: "object", description: "材料的字节/行/选择器范围" },
          check_method: { type: "string", description: "检查方法说明" },
          findings_entry_ids: { type: "array", items: { type: "string" }, description: "发现入口编号" },
          uncovered_parts: { type: "array", items: { type: "string" }, description: "未覆盖部分说明" },
          applicable_conditions: { type: "array", items: { type: "string" }, description: "适用条件" },
          coverage_status: { type: "string", enum: ["checked", "partial", "unknown"] },
          note: { type: "string" },
        },
        required: ["check_method"],
      },
      async execute(args) {
        return saveCheckRecord(pctx, {
          projectId,
          intentId: args.intent_id || job.subject_id,
          attemptId: null,
          materialIds: args.material_ids,
          materialRange: args.material_range,
          checkMethod: String(args.check_method),
          findingsEntryIds: args.findings_entry_ids,
          uncoveredParts: args.uncovered_parts,
          applicableConditions: args.applicable_conditions,
          coverageStatus: args.coverage_status || "unknown",
          note: args.note,
          actor: identity,
        });
      },
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
        return readEvidenceSlice(pctx, { projectId, targetId: String(args.target_id), byteOffset: args.byte_offset, byteLength: args.byte_length, role: "verifier", actorId: identity });
      },
    },
    {
      name: "bookmark_save",
      description: "保存阅读书签。",
      parameters: { type: "object", properties: { node_id: { type: "string" }, bookmark_key: { type: "string" }, note: { type: "string" } }, required: ["node_id"] },
      async execute(args) {
        return saveBookmark(pctx, { projectId, role: "verifier", actorId: identity, nodeId: String(args.node_id), bookmarkKey: args.bookmark_key || "default", note: args.note });
      },
    },
    {
      name: "bookmark_read",
      description: "读取已保存的阅读书签。",
      parameters: { type: "object", properties: { bookmark_key: { type: "string" } } },
      async execute(args) { return getBookmark(pctx, { projectId, role: "verifier", actorId: identity, bookmarkKey: args.bookmark_key || "default" }); },
    },
  ];

  const opening = [
    `项目 ${projectId} 的验证任务（§8.3 输入面，含统一项目上下文 project_context）：`,
    JSON.stringify({ project_context: projectContext, job, subject }, null, 1),
    "导航入口（主动阅读原始证据和相关材料再核对）：",
    "  root:assets — 资产根；root:exploration — 探索根",
    "  用 read_open / read_children / read_search / read_evidence_slice 按需定位原始证据。",
    "请核对证据与条件后 submit_result；checks 每项为 { name, passed, note }，策略 required_checks 每项都要覆盖（名称按名匹配）。",
  ].join("\n");

  const outcome = await runAgentLoop({ model, system: SYSTEM, tools, opening, maxSteps, role: "verifier" });
  return { role: "verifier", actor: VERIFIER_ACTOR, project_id: projectId, job_id: jobId, ...outcome };
}
