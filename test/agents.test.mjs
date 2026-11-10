/**
 * AI 半端测试（第 2 轮打磨：规范 §3.1/§2 约束 11 的 AI 决策半边落地）。
 *
 * 覆盖：
 *   1. Planner/Orchestrator/Worker/Verifier 四个独立 LLM 代理循环经**真实存储
 *      事务**驱动全链路（计划接收→条件领取派发→网关登记+真实 HTTP 探测+证据
 *      固定+发现提交→完成建议；验证任务→Manifest 绑定→状态转换应用）；
 *   2. 独立性（§3.1/§2 约束 6）：四角色各自会话；发现者同名的应用型验证结果
 *      被程序拒绝（TRUST_DENIED 回灌为工具结果，判断不被提升）；
 *   3. 程序资源边界（§3.2）：循环步数上限、未知工具拒绝、工具错误回灌不终止；
 *   4. 模型客户端（lib/agents/model.mjs）：真实 OpenAI 兼容 HTTP 端点（本地
 *      测试服务器，真实 fetch 传输）解析 tool_calls、映射错误；无提供方 →
 *      显式等待；
 *   5. 运行时驱动（lib/agents/runtime.mjs）：runOnce 一轮串联 Orchestrator→
 *      Planner→Worker→Verifier；处理完汇报后无新信息进入等待（§16.4 不空转）；
 *   6. dsh 工具桥接：宿主 tools.register 桩上注册只读 sorne_* 工具并真实执行。
 *
 * 模型替身说明：CI 无法连接真实 LLM——替身只替代**模型**（按角色脚本回放
 * tool_calls，并可读取上一轮真实工具结果以使用真实编号），存储事务、网关、
 * 范围/前提/租约校验、证据固定与状态机全部走真实实现（规范 §20.3 的反 mock
 * 要求针对事务与故障注入，不针对外部模型服务）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { withTestServer } from "./helpers.mjs";
import { closeStore, getStore, submit } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { normalizeAssistantMessage, resolveModelProvider } from "../lib/agents/model.mjs";
import { runAgentLoop } from "../lib/agents/loop.mjs";
import { runPlanner } from "../lib/agents/planner.mjs";
import { runOrchestrator } from "../lib/agents/orchestrator.mjs";
import { runWorker } from "../lib/agents/worker.mjs";
import { runVerifier } from "../lib/agents/verifier.mjs";
import { startAgentRuntime } from "../lib/agents/runtime.mjs";
import { registerDshTools } from "../lib/agents/dsh-bridge.mjs";
import { registerVerificationPolicy, requestVerification } from "../lib/store/verification.mjs";
import { readBlobBytes, storeBlob } from "../lib/store/evidence.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const pctxOf = (dataDir) => ({ dataDir, logger: QUIET });

/* ── 确定性模型替身：按角色脚本回放；步骤可为消息或 (上一轮工具结果) => 消息 ── */

function toolCall(name, args) {
  return {
    tool_calls: [
      { id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
    finish_reason: "tool_calls",
  };
}

function finalText(text) {
  return { content: text, finish_reason: "stop" };
}

/**
 * reactiveModel({ role: [step, …] })：step 为消息对象或 fn(toolResults) => 消息。
 * toolResults 是**全部** role=tool 消息的解析结果数组（真实工具回执，含工具名），
 * 形如 [{ name, result }, …]——替身据此引用此前任何一轮的真实编号。
 */
function reactiveModel(scriptsByRole, { model = "reactive-test" } = {}) {
  const cursors = new Map();
  return {
    kind: "scripted",
    model,
    describe: () => `scripted:${model}`,
    async chat({ system, messages }) {
      const role = /Orchestrator/.test(system) ? "orchestrator"
        : /Planner/.test(system) ? "planner"
        : /Verifier/.test(system) ? "verifier"
        : /Worker/.test(system) ? "worker"
        : "default";
      const script = scriptsByRole[role] || scriptsByRole.default || [];
      const turn = cursors.get(role) ?? 0;
      cursors.set(role, turn + 1);
      const step = script[Math.min(turn, script.length - 1)];
      if (!step) return finalText("（脚本结束）");
      const toolResults = [];
      for (const m of messages) {
        if (m.role !== "tool") continue;
        try {
          toolResults.push({ name: m.name, result: JSON.parse(m.content) });
        } catch {
          /* 非载荷文本忽略 */
        }
      }
      const flat = toolResults.map((t) => t.result);
      flat.names = toolResults.map((t) => t.name);
      const message = typeof step === "function"
        ? step(flat, (name) => toolResults.find((t) => t.name === name) || { result: {} })
        : step;
      return normalizeAssistantMessage(message);
    },
  };
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */

async function seedProject(s, { name = "AI 半端项目", allow = "127.0.0.1" } = {}) {
  const created = await s.request("POST", "/sorne/projects", {
    body: { name, scope_rules: { allow: [allow], deny: [], pending: [] } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.project.id;
}

/** Planner 建一条可执行意图（真实计划面），返回意图编号。 */
async function seedIntent(s, projectId, { question = "探测本地健康端点" } = {}) {
  const model = reactiveModel({
    planner: [
      toolCall("submit_plan", {
        plan_revision: "r1",
        intents: [{ op: "create", local_ref: "i1", question, kind: "collect", success_criteria: "一次可核验响应", target_asset_ids: [] }],
      }),
      finalText("ok"),
    ],
  });
  const plan = await runPlanner(pctxOf(s.dataDir), { projectId, model });
  const call = plan.trace.find((t) => t.tool === "submit_plan" && t.ok);
  assert.ok(call, "种子计划应提交成功");
  return call.result.ids.i1;
}

/* ══ 1. Planner ═════════════════════════════════════════════════════ */

test("Planner 循环：submit_plan 经真实计划接收落库；幽灵资产被程序拒绝并回灌", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    const model = reactiveModel({
      planner: [
        toolCall("submit_plan", {
          plan_revision: "r1",
          rationale: "覆盖缺口优先",
          intents: [{ op: "create", local_ref: "i1", question: "是否存在未鉴权管理入口？", kind: "investigate", success_criteria: "可核验入口观察或明确缺口", target_asset_ids: [], priority: 5 }],
        }),
        finalText("已提交 r1。"),
      ],
    });
    const outcome = await runPlanner(pctxOf(s.dataDir), { projectId, model });
    assert.equal(outcome.stop_reason, "final");
    assert.equal(outcome.actor, "planner-agent");
    const call = outcome.trace.find((t) => t.tool === "submit_plan" && t.ok);
    assert.ok(call);
    assert.equal(call.result.received_status, "accepted");

    const intents = await s.request("GET", `/sorne/intents?project_id=${projectId}`);
    assert.equal(intents.status, 200);
    const row = intents.body.intents.find((i) => i.question.includes("管理入口"));
    assert.ok(row, "意图应已落库");
    assert.equal(row.status, "proposed", "新意图初始为 proposed（等待协调分配）");
    assert.equal(row.created_by, "planner-agent", "创建者为 planner 会话身份（§3.1 独立角色）");

    /* 程序校验真实生效：幽灵资产目标被拒，错误作为工具结果回灌（§3.2）。 */
    const bad = reactiveModel({
      planner: [
        toolCall("submit_plan", {
          plan_revision: "r2",
          intents: [{ op: "create", local_ref: "i1", question: "幽灵资产探测", kind: "collect", target_asset_ids: ["A-9999"], success_criteria: "x" }],
        }),
        finalText("被拒，收回。"),
      ],
    });
    const badOutcome = await runPlanner(pctxOf(s.dataDir), { projectId, model: bad });
    const badCall = badOutcome.trace.find((t) => t.tool === "submit_plan");
    assert.ok(badCall, "submit_plan 调用应完成（错误经结果回灌）");
    const payload = badCall.ok ? badCall.result : badCall.error;
    assert.match(JSON.stringify(payload), /INVALID_REFERENCE/, "幽灵资产应被真实校验拒绝");
  }));

/* ══ 2. Orchestrator ════════════════════════════════════════════════ */

test("Orchestrator 循环：submit_decision 持久化并程序执行分配（C2 条件领取真实建租约）", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    const intentId = await seedIntent(s, projectId, { question: "确认目标入口" });
    const workerActor = `worker-agent-${intentId}`;

    const model = reactiveModel({
      orchestrator: [
        toolCall("submit_decision", {
          rationale: "把唯一意图分配给 worker 代理执行",
          actions: [{ action_kind: "assign_execution", idempotency_key: `assign-${intentId}`, payload: { intent_id: intentId, worker_id: workerActor, handoff_summary: "首轮执行" } }],
        }),
        finalText("已分配。"),
      ],
    });
    const outcome = await runOrchestrator(pctxOf(s.dataDir), { projectId, model });
    assert.equal(outcome.stop_reason, "final");
    assert.equal(outcome.actor, "orchestrator-agent");

    const store = await getStore(pctxOf(s.dataDir));
    const att = store.db.prepare("SELECT * FROM attempts WHERE project_id = ? AND intent_id = ?").get(projectId, intentId);
    assert.ok(att, "Attempt 应经真实条件领取建立");
    assert.equal(att.worker_id, workerActor);
    assert.equal(att.status, "leased");
    const decision = store.db.prepare("SELECT * FROM orchestration_decisions WHERE project_id = ? ORDER BY created_seq DESC").get(projectId);
    assert.ok(decision, "协调决定应持久化");
    assert.equal(decision.created_by, "orchestrator-agent", "决定创建者为 orchestrator 会话身份（与 planner 分立）");
    const action = store.db.prepare("SELECT * FROM orchestration_actions WHERE decision_id = ?").get(decision.id);
    assert.equal(action.status, "executed", "assign_execution 应被程序执行");
  }));

/* ══ 3. Worker：真实探测 → 证据固定 → 发现 → 完成 ═══════════════════ */

test("Worker 循环：网关+范围校验+真实 HTTP 探测→固定证据→提交观察→完成建议落定 Attempt", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    const intentId = await seedIntent(s, projectId);
    const probeUrl = `${s.base}/sorne/health`;

    const model = reactiveModel({
      worker: [
        toolCall("register_tool_call", { url: probeUrl, purpose: "健康端点核验" }),
        (all, byName) => toolCall("store_evidence", {
          tool_call_id: byName("register_tool_call").result.tool_call_id,
          representation: "exchange_record",
        }),
        (all, byName) => toolCall("submit_findings", {
          note: "首轮发现",
          append_observation: {
            statement: "健康端点返回 200",
            capture_id: byName("store_evidence").result.capture.capture_id,
          },
        }),
        (all, byName) => toolCall("complete_tool_call", {
          tool_call_id: byName("register_tool_call").result.tool_call_id,
          outcome: "succeeded",
          evidence_refs: [byName("store_evidence").result.blob.blob_id],
        }),
        () => toolCall("report_progress", { kind: "completion", note: "完成：一次可核验响应已固定" }),
        finalText("完成。"),
      ],
    });
    const outcome = await runWorker(pctxOf(s.dataDir), { projectId, intentId, model });
    assert.equal(outcome.stop_reason, "final");
    assert.ok(outcome.attempt_id, "未给 Attempt 时应自助领取");
    // 第 3 轮 P0：执行开始时程序把意图置 running（§10.1 状态机记账）
    assert.equal(outcome.intent_state && outcome.intent_state.to, "running", "执行开始应把意图置 running");
    // 完成闭环：Intent 无 deliverables → 交复核（awaiting_review），Test 后续断言库内状态
    assert.ok(outcome.completion_review, "完成建议应触发 C1 完成复核");
    assert.ok(
      ["awaiting_review", "resolved"].includes(outcome.completion_review.decision),
      "完成复核结论应为 awaiting_review 或 resolved：" + JSON.stringify(outcome.completion_review),
    );
    const store = await getStore(pctxOf(s.dataDir));
    const intentRow = store.db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId);
    assert.equal(intentRow.status, outcome.completion_review.decision, "意图状态应与完成复核结论一致");
    const att = store.db.prepare("SELECT * FROM attempts WHERE id = ?").get(outcome.attempt_id);
    assert.equal(att.status, "completed", "完成建议应落定 Attempt（§10.1）");

    const tc = store.db.prepare("SELECT * FROM tool_calls WHERE attempt_id = ?").get(outcome.attempt_id);
    assert.ok(tc, "工具调用应登记");
    assert.equal(tc.status, "succeeded");

    const capture = store.db.prepare("SELECT * FROM captures WHERE project_id = ? ORDER BY created_seq DESC").get(projectId);
    assert.ok(capture, "Capture 应登记");
    assert.equal(capture.tool_call_id, tc.id);
    const blob = store.db.prepare("SELECT * FROM blobs WHERE id = ?").get(capture.response_body_blob);
    assert.ok(blob, "Capture 引用固定 Blob");
    assert.equal(blob.storage_status, "fixed");
    assert.ok(blob.byte_size > 0);
    // 第 3 轮 P0：exchange_record 必须是**完整真实**响应（不是 2000 字摘要 JSON）
    assert.equal(blob.representation, "exchange_record");
    const storedBytes = (await readBlobBytes(pctxOf(s.dataDir), { sha256: blob.sha256, projectId })).bytes;
    const record = JSON.parse(storedBytes.toString("utf8"));
    assert.equal(record.schema, "sorne.exchange_record/v1");
    assert.ok(Array.isArray(record.response.headers) && record.response.headers.length > 0, "全量响应头应入证据");
    assert.equal(record.response.body_bytes, Buffer.byteLength(record.response.body_text, "utf8"), "body_bytes 应等于完整响应体字节数");
    // /sorne/health 响应含动态 checked_at，不能与二次请求逐字节比较；改为断言完整字段都在（摘要 JSON 不会含这些）
    const healthBody = JSON.parse(record.response.body_text);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "sorne");
    assert.ok(healthBody.db && healthBody.outbox, "完整响应体应包含 /health 全部字段");

    const obs = store.db.prepare("SELECT * FROM observations WHERE project_id = ? ORDER BY created_seq DESC").get(projectId);
    assert.ok(obs, "观察应已提交（发现即时持久化，§2 约束 1）");
    assert.equal(obs.capture_id, capture.id);
    assert.match(obs.statement, /健康端点返回 200/);

    /* 范围外目标被网关拒绝（§17 逐跳校验）：以新的自助领取 Attempt（租约有效）
       探测范围外目标 → SCOPE_DENIED 回灌、循环继续不崩溃。 */
    const outOfScope = reactiveModel({
      worker: [
        toolCall("register_tool_call", { url: "https://outside.example.net/x", purpose: "越界探测" }),
        finalText("被范围拒绝。"),
      ],
    });
    const deniedOutcome = await runWorker(pctxOf(s.dataDir), {
      projectId,
      intentId,
      assignmentId: `worker-agent-oos-${intentId}`,
      model: outOfScope,
    });
    const deniedTrace = deniedOutcome.trace.filter((t) => !t.ok);
    assert.ok(deniedOutcome.stop_reason === "final", "错误回灌后循环应正常收束");
    assert.ok(
      deniedTrace.some((t) => ["SCOPE_DENIED", "SCOPE_UNRESOLVED"].includes(t.error.code)),
      `范围外目标应被网关拒绝（实际 ${JSON.stringify(deniedTrace.map((t) => t.error.code))}）`,
    );
    const oosAtt = deniedOutcome.attempt_id;
    const oosRow = (await getStore(pctxOf(s.dataDir))).db
      .prepare("SELECT status FROM attempts WHERE id = ?")
      .get(oosAtt);
    assert.ok(oosRow, "越界执行Attempt仍应真实登记（记录实际结果，不假装未发生）");
  }));

/* ══ 4. Verifier：Manifest 绑定 + 独立性 ════════════════════════════ */

test("Verifier 循环：独立 supported 应用转换（suspected→confirmed）；发现者同名被拒（§2 约束 6）", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    registerVerificationPolicy({
      id: "policy-agents-test", version: "v1",
      required_checks: ["evidence_readable", "condition_reproduced"],
      description: "AI 半端测试策略",
    });

    /* 发现链路（真实提交面）：疑似漏洞 + 支持观察 + 固定证据。 */
    const workerSession = issueSession({ project_id: projectId, actor: "w-finder", role: "worker" });
    const bytes = Buffer.from("HTTP/1.1 200 OK\r\nX-Vuln: proof\r\n", "utf8");
    const blob = await storeBlob(pctxOf(s.dataDir), {
      projectId, bytes, representation: "raw_body", sourceKind: "tool_gateway", actor: "w-finder",
    });
    const receipt = await submit(pctxOf(s.dataDir), {
      session: workerSession,
      envelope: {
        submission_id: "seed-agents-1",
        operations: [
          { op: "register_asset", local_ref: "a1", asset_type: "domain", canonicalization_version: "v1", canonical_key: "probe.example.test" },
          { op: "append_observation", local_ref: "o1", statement: "管理端点无鉴权返回 200" },
          { op: "report_vulnerability", local_ref: "v1", category: "auth", asset_id: "a1", location: "/admin" },
          { op: "add_relation", from: "o1", type: "supports", to: "v1" },
        ],
      },
    });
    const vulnId = receipt.ids.v1;

    const orchSession = issueSession({ project_id: projectId, actor: "orch-req", role: "orchestrator" });
    const requested = await requestVerification(pctxOf(s.dataDir), {
      session: orchSession,
      input: { subject_id: vulnId, policy_id: "policy-agents-test", policy_version: "v1", raw_evidence_refs: [blob.blob_id], condition_snapshot_id: "COND-未登录" },
    });
    const jobId = requested.job.id;

    /* 发现者同名对照：vuln.created_by=verifier-agent（直插行精确构造身份冲突）。 */
    const store = await getStore(pctxOf(s.dataDir));
    store.db.prepare(
      `INSERT INTO vulnerabilities (id, project_id, category, status, created_at, created_by, created_seq, state_version, claim_revision, evidence_revision, assessment_epoch)
       VALUES ('V-SELF-TEST', ?, 'auth', 'suspected', ?, 'verifier-agent', 1, 1, 1, 1, 1)`,
    ).run(projectId, new Date().toISOString());
    const selfJob = await requestVerification(pctxOf(s.dataDir), {
      session: issueSession({ project_id: projectId, actor: "orch-req", role: "orchestrator" }),
      input: { subject_id: "V-SELF-TEST", policy_id: "policy-agents-test", policy_version: "v1", raw_evidence_refs: [blob.blob_id], condition_snapshot_id: "COND-未登录" },
    });

    const denyModel = reactiveModel({
      verifier: [
        toolCall("submit_result", { outcome: "supported", checks: [{ name: "evidence_readable", passed: true }, { name: "condition_reproduced", passed: true }] }),
        finalText("被拒。"),
      ],
    });
    const denied = await runVerifier(pctxOf(s.dataDir), { projectId, jobId: selfJob.job.id, model: denyModel, verifierIdentity: "verifier-agent:self" });
    const deniedCall = denied.trace.find((t) => t.tool === "submit_result");
    assert.ok(deniedCall, "submit_result 调用应完成（错误回灌）");
    const deniedPayload = deniedCall.ok ? deniedCall.result : deniedCall.error;
    assert.equal(deniedPayload.code, "TRUST_DENIED", "发现者同名的应用型结果必须被程序拒绝");
    assert.equal(
      store.db.prepare("SELECT status FROM vulnerabilities WHERE id = 'V-SELF-TEST'").get().status,
      "suspected",
      "被拒结果不得提升状态",
    );

    /* 独立 verifier：required_checks 全过 → 应用转换。 */
    const okModel = reactiveModel({
      verifier: [
        toolCall("submit_result", {
          outcome: "supported",
          checks: [
            { name: "evidence_readable", passed: true, note: "Blob 读取核对" },
            { name: "condition_reproduced", passed: true, note: "未登录条件复现" },
          ],
          supporting_refs: [blob.blob_id],
          limitations: "仅未登录条件",
        }),
        finalText("确认（限指定条件）。"),
      ],
    });
    const outcome = await runVerifier(pctxOf(s.dataDir), { projectId, jobId, model: okModel, verifierIdentity: "verifier-agent:independent" });
    assert.equal(outcome.stop_reason, "final");
    const call = outcome.trace.find((t) => t.tool === "submit_result" && t.ok);
    assert.ok(call, "独立提交应成功");
    const vulnRow = store.db.prepare("SELECT status, review FROM vulnerabilities WHERE id = ?").get(vulnId);
    assert.equal(vulnRow.status, "confirmed", "独立验证 supported 应应用状态转换（§12.2）");
    assert.equal(vulnRow.review, "clear");
  }));

/* ══ 5. 循环内核边界（§3.2） ════════════════════════════════════════ */

test("代理循环内核：步数上限止损；未知工具拒绝；工具错误回灌不终止循环", async () => {
  const tools = [
    {
      name: "echo",
      description: "回显",
      parameters: { type: "object", properties: { v: { type: "string" } } },
      async execute(args) {
        if (args.v === "boom") {
          const e = new Error("引用的对象不存在：A-9999");
          e.code = "INVALID_REFERENCE";
          throw e;
        }
        return { ok: true, v: args.v };
      },
    },
  ];

  const greedy = {
    async chat() {
      return { role: "assistant", content: null, tool_calls: [{ id: "c", name: "echo", arguments: { v: "x" } }], finish_reason: "tool_calls" };
    },
  };
  const bounded = await runAgentLoop({ model: greedy, system: "s", tools, opening: "go", maxSteps: 3 });
  assert.equal(bounded.stop_reason, "max_steps");
  assert.equal(bounded.steps, 3);
  assert.equal(bounded.final, null);

  const script = reactiveModel({
    default: [
      toolCall("nope", {}),
      toolCall("echo", { v: "boom" }),
      toolCall("echo", { v: "fine" }),
      finalText("done"),
    ],
  });
  const mixed = await runAgentLoop({ model: script, system: "s", tools, opening: "go", maxSteps: 8 });
  assert.equal(mixed.stop_reason, "final");
  assert.equal(mixed.final, "done");
  assert.equal(mixed.trace[0].ok, false);
  assert.equal(mixed.trace[0].error.code, "BAD_REQUEST");
  assert.equal(mixed.trace[1].ok, false);
  assert.equal(mixed.trace[1].error.code, "INVALID_REFERENCE");
  assert.equal(mixed.trace[2].ok, true);
});

/* ══ 6. 模型客户端：真实 HTTP 传输 + 无提供方显式等待 ════════════════ */

test("模型客户端（HTTP 提供方）：真实 /chat/completions 传输，tool_calls 解析与错误映射", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (body.includes("\"boom-model\"")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "submit_plan", arguments: "{\"plan_revision\":\"r9\"}" } }],
          },
        }],
      }));
    });
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  const prev = { url: process.env.SORNE_LLM_BASE_URL, model: process.env.SORNE_LLM_MODEL, key: process.env.SORNE_LLM_API_KEY };
  try {
    process.env.SORNE_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    process.env.SORNE_LLM_MODEL = "test-model";
    process.env.SORNE_LLM_API_KEY = "sk-test";
    const provider = resolveModelProvider({});
    assert.ok(provider, "环境配置齐全时应解析出 HTTP 提供方");
    assert.equal(provider.kind, "http");
    const reply = await provider.chat({ system: "s", messages: [{ role: "user", content: "go" }], tools: [] });
    assert.equal(reply.tool_calls.length, 1);
    assert.equal(reply.tool_calls[0].name, "submit_plan");
    assert.deepEqual(reply.tool_calls[0].arguments, { plan_revision: "r9" });
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer sk-test");

    process.env.SORNE_LLM_MODEL = "boom-model";
    const bad = resolveModelProvider({});
    await assert.rejects(bad.chat({ messages: [{ role: "user", content: "x" }] }), /HTTP 500/);
  } finally {
    for (const [k, v] of [["SORNE_LLM_BASE_URL", prev.url], ["SORNE_LLM_MODEL", prev.model], ["SORNE_LLM_API_KEY", prev.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});

test("运行时驱动：无 LLM 提供方 → started:false 显式等待（不以固定剧本替代 AI，§3.1）", async () => {
  const prev = { url: process.env.SORNE_LLM_BASE_URL, model: process.env.SORNE_LLM_MODEL };
  delete process.env.SORNE_LLM_BASE_URL;
  delete process.env.SORNE_LLM_MODEL;
  try {
    const rt = startAgentRuntime({ dataDir: "/tmp/sorne-agents-none", logger: QUIET });
    assert.equal(rt.started, false);
    assert.match(rt.reason, /SORNE_LLM_BASE_URL/);
    assert.match(rt.reason, /等待/);
    const once = await rt.runOnce("PRJ-0002");
    assert.equal(once.skipped, true);
    rt.stop();
  } finally {
    for (const [k, v] of [["SORNE_LLM_BASE_URL", prev.url], ["SORNE_LLM_MODEL", prev.model]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/* ══ 7. 运行时单轮全链路 + 等待语义 ═════════════════════════════════ */

test("运行时 runOnce：一轮串联协调分配与真实执行；收尾后无新信息进入等待（§16.4）", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    const intentId = await seedIntent(s, projectId);
    const workerActor = `worker-agent-${intentId}`;
    const probeUrl = `${s.base}/sorne/health`;
    let handledReportId = null;

    const scripts = {
      orchestrator: [
        /* 第 1 轮：分配执行。 */
        toolCall("submit_decision", {
          rationale: "分配唯一意图给 worker 代理",
          actions: [{ action_kind: "assign_execution", idempotency_key: `assign-${intentId}`, payload: { intent_id: intentId, worker_id: workerActor } }],
        }),
        finalText("等待执行结果。"),
        /* 第 2 轮起：处理完成汇报（真实 report_id 从 overview 供给里看不到——
           以 react 回执不可得时改用 read_record? 简化：直接从库侧查出的编号
           经闭包注入）。 */
        () => toolCall("submit_decision", {
          rationale: "接受 worker 的完成汇报",
          actions: [{ action_kind: "handle_report", idempotency_key: `handle-${handledReportId || "pending"}`, payload: { report_id: handledReportId, receipt_kind: "accepted" } }],
        }),
        finalText("已处理。"),
      ],
      worker: [
        toolCall("register_tool_call", { url: probeUrl, purpose: "健康端点" }),
        (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id }),
        (all, byName) => toolCall("submit_findings", {
          note: "n1",
          append_observation: { statement: "健康端点 200", capture_id: byName("store_evidence").result.capture.capture_id },
        }),
        (all, byName) => toolCall("complete_tool_call", {
          tool_call_id: byName("register_tool_call").result.tool_call_id,
          outcome: "succeeded",
          evidence_refs: [byName("store_evidence").result.blob.blob_id],
        }),
        () => toolCall("report_progress", { kind: "completion", note: "完成" }),
        finalText("done"),
      ],
      planner: [finalText("无需新规划。")],
      verifier: [finalText("无任务。")],
      default: [finalText("无操作。")],
    };

    const pctx = pctxOf(s.dataDir);
    pctx.__modelProvider = reactiveModel(scripts, { model: "runtime-once" });
    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    assert.equal(rt.started, true);

    /* 第 1 轮：协调分配 + worker 全链路真实执行。 */
    const round1 = await rt.runOnce(projectId);
    assert.ok(round1.roles.some((r) => r.role === "orchestrator"), "第一轮应含协调");
    assert.ok(round1.roles.some((r) => r.role === "worker"), "第一轮应含执行");

    const store = await getStore(pctx);
    const att = store.db.prepare("SELECT * FROM attempts WHERE project_id = ? AND intent_id = ?").get(projectId, intentId);
    assert.ok(att, "Attempt 应建立");
    assert.equal(att.status, "completed", "worker 完成建议应落定 Attempt");
    const wr = store.db.prepare("SELECT * FROM worker_reports WHERE attempt_id = ? ORDER BY created_seq DESC").get(att.id);
    assert.ok(wr, "完成汇报应留档");
    assert.equal(wr.handling_status, "pending", "回执未落前汇报待处理（§18.5）");

    /* 第 2 轮：协调处理完成汇报（handle_report → accepted → handled）。 */
    handledReportId = wr.id;
    const round2 = await rt.runOnce(projectId);
    assert.ok(round2.roles.some((r) => r.role === "orchestrator"));
    const wrAfter = store.db.prepare("SELECT handling_status FROM worker_reports WHERE id = ?").get(wr.id);
    assert.equal(wrAfter.handling_status, "handled", "回执在决定持久化后标记 handled（§18.5.6）");

    /* 收尾轮：无新信息 → 等待条件变化（不空转，§16.4）。 */
    const idle = await rt.runOnce(projectId);
    assert.equal(idle.skipped, true);
    assert.equal(idle.reason, "waiting_for_change");
    rt.stop();
    await closeStore(pctx);
  }));

test("运行时恢复：只有新事件时，协调器退避结束后无需新输入即可重试", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s);
    const pctx = pctxOf(s.dataDir);
    const providerKey = "scripted:event-recovery";
    let calls = 0;
    pctx.__modelProvider = {
      describe: () => providerKey,
      async chat() {
        if (++calls === 1) {
          throw Object.assign(new Error("temporary outage"), { providerErrorKind: "server_error" });
        }
        return normalizeAssistantMessage(finalText("恢复处理。"));
      },
    };
    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    try {
      assert.equal((await rt.runOnce(projectId)).roles[0]?.stop_reason, "provider_error");
      assert.deepEqual((await rt.runOnce(projectId)).roles, []);
      assert.equal(calls, 1);
      const store = await getStore(pctx);
      store.db.prepare("UPDATE provider_health SET next_retry_at = ? WHERE provider_key = ?")
        .run(new Date(Date.now() - 1000).toISOString(), providerKey);
      assert.equal((await rt.runOnce(projectId)).roles[0]?.stop_reason, "final");
      assert.equal(calls, 2);
      assert.equal((await rt.runOnce(projectId)).skipped, true);
    } finally {
      rt.stop();
      await closeStore(pctx);
    }
  }));

test("运行时恢复：Planner provider_error 后不依赖 Orchestrator 再次触发，退避到期自动续跑", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s, { name: "Planner 恢复项目" });
    const pctx = pctxOf(s.dataDir);
    const store = await getStore(pctx);
    store.db.prepare(
      `INSERT INTO plan_runs (id, project_id, input_boundary, status, created_at, created_by, created_seq)
       VALUES ('PR-RECOVERY-1', ?, '0', 'in_flight', ?, 'orchestrator-agent', 2)`,
    ).run(projectId, new Date().toISOString());

    let plannerCalls = 0;
    pctx.__modelProvider = {
      kind: "scripted",
      model: "planner-recovery",
      describe: () => "scripted:planner-recovery",
      async chat({ system }) {
        if (/Orchestrator/.test(system)) {
          return normalizeAssistantMessage(finalText("协调状态不变。"));
        }
        if (/Planner/.test(system)) {
          plannerCalls += 1;
          if (plannerCalls === 1) {
            const error = new Error("temporary outage");
            error.providerErrorKind = "transient";
            throw error;
          }
          return normalizeAssistantMessage(finalText("provider 已恢复，重新读取在途 plan_run。"));
        }
        return normalizeAssistantMessage(finalText("无操作。"));
      },
    };

    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    const first = await rt.runOnce(projectId);
    assert.equal(first.roles.find((r) => r.role === "planner")?.stop_reason, "provider_error", JSON.stringify(first));
    assert.equal(plannerCalls, 1);

    // 模拟持久退避时间到期；协调器信号没有变化，恢复必须由独立 Planner 驱动完成。
    store.db.prepare("UPDATE provider_health SET next_retry_at = ? WHERE provider_key = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "scripted:planner-recovery");
    const second = await rt.runOnce(projectId);
    assert.equal(second.roles.find((r) => r.role === "planner")?.stop_reason, "final");
    assert.equal(plannerCalls, 2, "Planner 应在同一 plan_run 上自动续跑");
    const health = store.db.prepare("SELECT last_error_kind, consecutive_failures FROM provider_health WHERE provider_key = ?")
      .get("scripted:planner-recovery");
    assert.equal(health.last_error_kind, null);
    assert.equal(health.consecutive_failures, 0);
    rt.stop();
    await closeStore(pctx);
  }));

test("运行时恢复：Verifier provider_error 不会被 drivenJobs 永久去重", () =>
  withTestServer(async (s) => {
    const projectId = await seedProject(s, { name: "Verifier 恢复项目" });
    const pctx = pctxOf(s.dataDir);
    const store = await getStore(pctx);
    store.db.prepare(
      `INSERT INTO verification_jobs
       (id, project_id, subject_id, subject_kind, claim_revision, policy_id, policy_version,
        expected_state_version, expected_evidence_revision, expected_assessment_epoch,
        requested_by, status, dedup_key, created_at, created_by, created_seq)
       VALUES ('VJ-RECOVERY-1', ?, 'V-MISSING', 'vulnerability', 1, 'test', 'v1',
        1, 1, 1, 'orchestrator-agent', 'pending', 'verifier-recovery', ?, 'orchestrator-agent', 2)`,
    ).run(projectId, new Date().toISOString());

    let verifierCalls = 0;
    pctx.__modelProvider = {
      kind: "scripted",
      model: "verifier-recovery",
      describe: () => "scripted:verifier-recovery",
      async chat({ system }) {
        if (/Orchestrator/.test(system)) return normalizeAssistantMessage(finalText("协调状态不变。"));
        if (/Verifier/.test(system)) {
          verifierCalls += 1;
          if (verifierCalls === 1) {
            const error = new Error("temporary verifier outage");
            error.providerErrorKind = "transient";
            throw error;
          }
          return normalizeAssistantMessage(finalText("验证服务恢复，任务仍待处理。"));
        }
        return normalizeAssistantMessage(finalText("无操作。"));
      },
    };

    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    const first = await rt.runOnce(projectId);
    assert.equal(first.roles.find((r) => r.role === "verifier")?.stop_reason, "provider_error", JSON.stringify(first));
    store.db.prepare("UPDATE provider_health SET next_retry_at = ? WHERE provider_key = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "scripted:verifier-recovery");

    const second = await rt.runOnce(projectId);
    assert.equal(second.roles.find((r) => r.role === "verifier")?.stop_reason, "final", JSON.stringify(second));
    assert.equal(verifierCalls, 2, "同一 pending job 应在 provider 恢复后自动续跑");
    rt.stop();
    await closeStore(pctx);
  }));

/* ══ 8. dsh 工具桥接 ════════════════════════════════════════════════ */

test("dsh 桥接：注册只读 sorne_* 工具并真实执行；无 tools 服务静默跳过；dispose 注销", () =>
  withTestServer(async (s) => {
    const created = await s.request("POST", "/sorne/projects", { body: { name: "桥接项目" } });
    assert.equal(created.status, 200);

    const registered = new Map();
    const hostCtx = {
      get(name) {
        if (name !== "tools") return undefined;
        return {
          register(def) {
            registered.set(def.name, def);
            return () => registered.delete(def.name);
          },
        };
      },
    };
    const bridge = registerDshTools(hostCtx, pctxOf(s.dataDir));
    assert.ok(bridge.registered.length >= 6, `应注册 ≥6 个只读工具（实际 ${bridge.registered.length}）`);
    assert.ok(bridge.registered.every((n) => /^sorne_/.test(n)), "工具名以 sorne_ 前缀命名");

    const projects = await registered.get("sorne_projects").execute({});
    assert.ok(projects.some((p) => p.name === "桥接项目"));

    const page = await registered.get("sorne_change_log").execute({ project_id: created.body.project.id });
    assert.ok(Array.isArray(page.events));
    assert.equal(page.read_only, true);

    assert.ok(!bridge.registered.some((n) => /dispatch|submit|create|delete|update/.test(n)), "桥接不得注册变更类工具");

    const empty = registerDshTools({ get: () => undefined }, pctxOf(s.dataDir));
    assert.deepEqual(empty.registered, []);

    bridge.dispose();
    assert.equal(registered.size, 0, "dispose 应注销全部工具");
  }));

/* ══ 10. AI 决策端到端：env 配置的真实 HTTP 提供方驱动全链路 runOnce ══
 *
 * 终审整改回应「AI 决策环节未被端到端驱动」：本用例不注入 __modelProvider 替身，
 * 而是设置 SORNE_LLM_BASE_URL/MODEL 指向本地 OpenAI 兼容服务器——决策流量经
 * resolveModelProvider → 真实 fetch /chat/completions 传输（Bearer 头、超时、
 * 非 2xx 映射均为生产路径），仅远端模型本身由脚本服务器扮演（CI 无法连真实
 * LLM）。存储事务、网关、范围/租约校验、证据固定全部真实。 */

test("AI 端到端（env HTTP 提供方）：runOnce 两轮驱动 协调→执行→汇报处理→等待（真实模型传输通道）", async () => {
  /* 角色脚本（按 system 关键词 + 已回灌工具结果数定位轮次）。 */
  const scripts = {
    orchestrator: [
      { role: "assistant", content: null, tool_calls: [{ id: "o1", type: "function", function: { name: "submit_decision", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: "等待执行结果。", finish_reason: "stop" },
      { role: "assistant", content: null, tool_calls: [{ id: "o2", type: "function", function: { name: "", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: "已处理。", finish_reason: "stop" },
    ],
    planner: [{ role: "assistant", content: "无需新规划。", finish_reason: "stop" }],
    worker: [
      { role: "assistant", content: null, tool_calls: [{ id: "w1", type: "function", function: { name: "register_tool_call", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: null, tool_calls: [{ id: "w2", type: "function", function: { name: "store_evidence", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: null, tool_calls: [{ id: "w3", type: "function", function: { name: "submit_findings", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: null, tool_calls: [{ id: "w4", type: "function", function: { name: "complete_tool_call", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: null, tool_calls: [{ id: "w5", type: "function", function: { name: "report_progress", arguments: "" } }], finish_reason: "tool_calls" },
      { role: "assistant", content: "完成。", finish_reason: "stop" },
    ],
    verifier: [{ role: "assistant", content: "无任务。", finish_reason: "stop" }],
  };
  const state = { intentId: null, workerActor: null, probeUrl: null, reportId: null, toolNames: new Map() };

  function orchestratorArgs(turn) {
    if (turn === 0) {
      return {
        rationale: "分配唯一意图给 worker 代理",
        actions: [{ action_kind: "assign_execution", idempotency_key: `assign-e2e-${state.intentId}`, payload: { intent_id: state.intentId, worker_id: state.workerActor } }],
      };
    }
    return {
      rationale: "接受 worker 的完成汇报",
      actions: [{ action_kind: "handle_report", idempotency_key: `handle-e2e-${state.reportId}`, payload: { report_id: state.reportId, receipt_kind: "accepted" } }],
    };
  }

  function workerArgs(toolMsgs, probeUrl) {
    const byName = (n) => toolMsgs.find((m) => m.name === n);
    const n = toolMsgs.length;
    if (n === 0) return { url: state.probeUrl, purpose: "健康端点" };
    const reg = byName("register_tool_call");
    if (n === 1) return { tool_call_id: JSON.parse(reg.content).tool_call_id };
    if (n === 2) {
      const ev = JSON.parse(byName("store_evidence").content);
      return { note: "e2e", append_observation: { statement: "健康端点 200", capture_id: ev.capture.capture_id } };
    }
    if (n === 3) {
      const ev = JSON.parse(byName("store_evidence").content);
      const r = JSON.parse(reg.content);
      return { tool_call_id: r.tool_call_id, outcome: "succeeded", evidence_refs: [ev.blob.blob_id] };
    }
    return { kind: "completion", note: "完成：一次可核验响应已固定" };
  }

  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 空 */ }
      const auth = req.headers.authorization || "";
      const sys = (body.messages || []).find((m) => m.role === "system");
      const sysText = sys ? sys.content : "";
      const toolMsgs = (body.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => ({ id: m.tool_call_id, name: state.toolNames.get(m.tool_call_id), content: m.content }));
      const role = /Orchestrator/.test(sysText) ? "orchestrator"
        : /Planner/.test(sysText) ? "planner"
        : /Verifier/.test(sysText) ? "verifier"
        : /Worker/.test(sysText) ? "worker"
        : "default";
      state.llmCalls = (state.llmCalls || []) ;
      state.llmCalls.push({ role, url: req.url, auth, model: body.model });
      let message;
      if (role === "orchestrator") {
        const turn = state.orchTurn = state.orchTurn || 0;
        state.orchDone = state.orchDone || 0;
        const step = scripts.orchestrator[Math.min(state.orchDone, scripts.orchestrator.length - 1)];
        state.orchDone += 1;
        message = JSON.parse(JSON.stringify(step));
        if (message.tool_calls) {
          const args = orchestratorArgs(turn);
          if (message.tool_calls[0].function.name === "") message.tool_calls[0].function.name = "submit_decision";
          message.tool_calls[0].function.arguments = JSON.stringify(args);
          state.toolNames.set(message.tool_calls[0].id, message.tool_calls[0].function.name);
        } else {
          state.orchTurn += 1;
        }
      } else if (role === "worker") {
        const n = toolMsgs.length;
        const step = scripts.worker[Math.min(n, scripts.worker.length - 1)];
        message = JSON.parse(JSON.stringify(step));
        if (message.tool_calls) {
          message.tool_calls[0].function.arguments = JSON.stringify(workerArgs(toolMsgs, state.probeUrl));
          state.toolNames.set(message.tool_calls[0].id, message.tool_calls[0].function.name);
        }
      } else {
        message = scripts[role][0];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: message.finish_reason || "stop", message }] }));
    });
  });
  await new Promise((r, j) => { llm.once("error", j); llm.listen(0, "127.0.0.1", r); });

  const prev = { url: process.env.SORNE_LLM_BASE_URL, model: process.env.SORNE_LLM_MODEL, key: process.env.SORNE_LLM_API_KEY };
  process.env.SORNE_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`;
  process.env.SORNE_LLM_MODEL = "e2e-model";
  process.env.SORNE_LLM_API_KEY = "sk-e2e";

  try {
    await withTestServer(async (s) => {
      const created = await s.request("POST", "/sorne/projects", {
        body: { name: "AI-e2e-项目", scope_rules: { allow: ["127.0.0.1"], deny: [], pending: [] } },
      });
      assert.equal(created.status, 200);
      const projectId = created.body.project.id;

      /* 种子意图：亦经 HTTP 提供方跑 planner（同传输通道）。 */
      state.probeUrl = `${s.base}/sorne/health`;
      const seedModel = {
        planner: [{ tool_calls: [{ id: "p1", function: { name: "submit_plan", arguments: "" } }], finish_reason: "tool_calls" }],
      };
      /* 借 planner 脚本：直接构造一次性应答（不经 llm 服务器，简化种子） */
      const { runPlanner } = await import("../lib/agents/planner.mjs");
      let seedTurn = 0;
      const seedProvider = {
        kind: "scripted", model: "e2e-model", describe: () => "scripted:seed",
        async chat() {
          seedTurn += 1;
          if (seedTurn > 1) return { role: "assistant", content: "已提交。", tool_calls: [], finish_reason: "stop" };
          return {
            role: "assistant", content: null, finish_reason: "tool_calls",
            tool_calls: [{ id: "p1", name: "submit_plan", arguments: {
              plan_revision: "r1",
              intents: [{ op: "create", local_ref: "i1", question: "探测本地健康端点", kind: "collect", success_criteria: "一次可核验响应", target_asset_ids: [] }],
            } }],
          };
        },
      };
      void seedModel;
      const plan = await runPlanner(pctxOf(s.dataDir), { projectId, model: seedProvider, maxSteps: 3 });
      const intentId = plan.trace.find((t) => t.tool === "submit_plan" && t.ok).result.ids.i1;
      state.intentId = intentId;
      state.workerActor = `worker-agent-${intentId}`;

      /* 运行时：env 提供方（真实 HTTP 传输）。 */
      const rt = startAgentRuntime(pctxOf(s.dataDir), { tickMs: 60_000, logger: QUIET });
      assert.equal(rt.started, true);

      const round1 = await rt.runOnce(projectId);
      assert.ok(round1.roles.some((r) => r.role === "orchestrator"), "第一轮应含协调");
      assert.ok(round1.roles.some((r) => r.role === "worker"), "第一轮应含执行");
      assert.ok(
        (state.llmCalls || []).some((c) => c.role === "orchestrator" && c.url === "/v1/chat/completions" && c.auth === "Bearer sk-e2e" && c.model === "e2e-model"),
        "协调决策应经真实 HTTP 提供方传输（URL/Bearer/模型名核对）",
      );
      assert.ok((state.llmCalls || []).some((c) => c.role === "worker"), "worker 决策应经真实 HTTP 提供方传输");

      const store = await getStore(pctxOf(s.dataDir));
      const att = store.db.prepare("SELECT * FROM attempts WHERE project_id = ? AND intent_id = ?").get(projectId, intentId);
      assert.ok(att, "Attempt 应建立");
      assert.equal(att.status, "completed", "worker 完成建议应落定 Attempt");
      const wr = store.db.prepare("SELECT * FROM worker_reports WHERE attempt_id = ? ORDER BY created_seq DESC").get(att.id);
      assert.ok(wr, "完成汇报应留档");
      const obs = store.db.prepare("SELECT * FROM observations WHERE project_id = ? ORDER BY created_seq DESC").get(projectId);
      assert.ok(obs, "观察应已提交（真实证据链）");
      const cap = store.db.prepare("SELECT * FROM captures WHERE project_id = ? ORDER BY created_seq DESC").get(projectId);
      assert.ok(cap, "Capture 应登记");

      /* 第二轮：处理完成汇报（仍经 HTTP 提供方）。 */
      state.reportId = wr.id;
      const round2 = await rt.runOnce(projectId);
      assert.ok(round2.roles.some((r) => r.role === "orchestrator"));
      const wrAfter = store.db.prepare("SELECT handling_status FROM worker_reports WHERE id = ?").get(wr.id);
      assert.equal(wrAfter.handling_status, "handled", "回执在决定持久化后标记 handled");

      /* 收尾：无新信息 → 等待（不空转）。 */
      const idle = await rt.runOnce(projectId);
      assert.equal(idle.skipped, true);
      assert.equal(idle.reason, "waiting_for_change");
      rt.stop();
      await closeStore(pctxOf(s.dataDir));
    });
  } finally {
    for (const [k, v] of [["SORNE_LLM_BASE_URL", prev.url], ["SORNE_LLM_MODEL", prev.model], ["SORNE_LLM_API_KEY", prev.key]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => llm.close(r));
  }
});
