/**
 * AI 半端真实可用性测试（第 3 轮：真实模型联调 P0 修复的回归网）。
 *
 * 覆盖：
 *   1. 多步工具调用线格式（P0）：内部归一化消息 → OpenAI/DeepSeek 线格式
 *      （assistant.tool_calls={id,type:'function',function:{name,arguments:JSON字符串}}，
 *      tool 消息剥离 name）；严格校验的本地服务器（按 DeepSeek 实测 422 行为）不拒绝；
 *   2. 循环内核：超出每步上限的调用也得到 tool 应答（无悬空 tool_call id）；
 *   3. 本地故意漏洞靶标 tools/mock-target.mjs：127.0.0.1-only、GBK 页面、二进制响应、
 *      多 Set-Cookie；Node 22 TextDecoder(gbk) 实测支持；
 *   4. Worker 证据完整性（规范 §13/§18.3）：raw_body = 逐字节真实响应，
 *      exchange_record = 含全量头与完整响应体的 JSON（含二进制 base64）；
 *   5. 提交幂等：确定性 submission_id → 重复 submit_findings 返回原回执、不重复建观察；
 *   6. 意图完成闭环：执行置 running；带 deliverables_proof 的完成建议 → resolved + intent.completed；
 *   7. 真实模型联调（可选）：设置 SORNE_REALRUN=1 且存在 sorne-data/llm.json 时，
 *      用真实 deepseek-flash 驱动 plan→assign→probe→evidence→findings→complete→resolved。
 *      默认跳过（CI 无凭据/不访问外部网络）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTestServer } from "./helpers.mjs";
import { toWireMessages } from "../lib/agents/model.mjs";
import { runAgentLoop } from "../lib/agents/loop.mjs";
import { runPlanner } from "../lib/agents/planner.mjs";
import { runWorker } from "../lib/agents/worker.mjs";
import { startAgentRuntime } from "../lib/agents/runtime.mjs";
import { closeStore, createProject, getStore } from "../lib/store/record-service.mjs";
import { createPlanRequest } from "../lib/store/orchestrator.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { readBlobBytes } from "../lib/store/evidence.mjs";
import { startMockTarget } from "../tools/mock-target.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const pctxOf = (dataDir) => ({ dataDir, logger: QUIET });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const LLM_FILE = "/Users/thorneye/Documents/Agentcp/sorne-data/llm.json";

/* ── 脚本化模型替身（与 agents.test.mjs 同构，收敛在本文件避免跨文件耦合）── */
function toolCall(name, args) {
  return {
    tool_calls: [{ id: "call_" + name + "_" + Math.random().toString(36).slice(2, 6), type: "function", function: { name, arguments: JSON.stringify(args) } }],
    finish_reason: "tool_calls",
  };
}
function finalText(text) {
  return { content: text, finish_reason: "stop" };
}
function reactiveModel(scriptsByRole, { model = "realrun-scripted" } = {}) {
  const cursors = new Map();
  return {
    kind: "scripted",
    model,
    describe: () => "scripted:" + model,
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
          /* 忽略非载荷文本 */
        }
      }
      const flat = toolResults.map((t) => t.result);
      flat.names = toolResults.map((t) => t.name);
      const message = typeof step === "function" ? step(flat, (name) => toolResults.filter((t) => t.name === name).pop() || { result: {} }) : step;
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: (message.tool_calls || []).map((tc) => ({
          id: tc.id || "call_" + Math.random().toString(36).slice(2, 8),
          name: tc.function ? tc.function.name : tc.name,
          arguments: tc.function ? JSON.parse(tc.function.arguments || "{}") : tc.arguments ?? {},
        })),
        finish_reason: message.finish_reason ?? null,
      };
    },
  };
}

/* ══ 1. 线格式（P0）══════════════════════════════════════════════════ */

test("线格式 P0：toWireMessages 产出 OpenAI/DeepSeek 规范形状（id/type/function + JSON 字符串参数）", () => {
  const wire = toWireMessages([
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", finish_reason: "tool_calls", tool_calls: [{ id: "c1", name: "echo", arguments: { v: 1, s: "中文" } }] },
    { role: "tool", tool_call_id: "c1", name: "echo", content: "{\"ok\":true}" },
  ]);
  assert.equal(wire[0].role, "system");
  assert.deepEqual(wire[2].tool_calls, [
    { id: "c1", type: "function", function: { name: "echo", arguments: "{\"v\":1,\"s\":\"中文\"}" } },
  ]);
  assert.equal("finish_reason" in wire[2], false, "剥离内部 finish_reason");
  assert.deepEqual(wire[3], { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" }, "tool 消息剥离内部 name，只保留规范字段");
});

test("多步线格式 P0：严格校验服务器（按 DeepSeek 实测 422 行为）接受修复后的请求", async () => {
  let calls = 0;
  const invalid = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls += 1;
      let body;
      try { body = JSON.parse(raw); } catch { invalid.push("请求体不是 JSON"); }
      const messages = (body && body.messages) || [];
      const answerIds = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      for (const m of messages) {
        if (m.role !== "assistant" || !m.tool_calls) continue;
        for (const tc of m.tool_calls) {
          if (tc.type !== "function") invalid.push("tool_call 缺 type=function");
          if (!tc.function || typeof tc.function.name !== "string") invalid.push("tool_call 缺 function.name");
          if (typeof tc.function.arguments !== "string") invalid.push("arguments 不是 JSON 字符串（DeepSeek 实测此形状 422 缺 type/结构错误）");
          else { try { JSON.parse(tc.function.arguments); } catch { invalid.push("arguments 不是合法 JSON 字符串"); } }
          if (!answerIds.has(tc.id)) invalid.push("悬空 tool_call id：" + tc.id);
        }
      }
      for (const m of messages.filter((x) => x.role === "tool")) {
        if (typeof m.content !== "string") invalid.push("tool 消息 content 不是字符串");
      }
      if (invalid.length) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "wire invalid: " + invalid.slice(0, 3).join("; "), type: "invalid_request_error" } }));
        return;
      }
      const reply = calls === 1
        ? { role: "assistant", content: "", tool_calls: [{ id: "call_echo_1", type: "function", function: { name: "echo", arguments: "{\"v\":42}" } }], finish_reason: "tool_calls" }
        : { role: "assistant", content: "done", tool_calls: [], finish_reason: "stop" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: reply, finish_reason: reply.finish_reason }] }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const prev = { url: process.env.SORNE_LLM_BASE_URL, model: process.env.SORNE_LLM_MODEL, key: process.env.SORNE_LLM_API_KEY };
  try {
    process.env.SORNE_LLM_BASE_URL = "http://127.0.0.1:" + server.address().port + "/v1";
    process.env.SORNE_LLM_MODEL = "strict-wire-model";
    process.env.SORNE_LLM_API_KEY = "sk-wire";
    const { resolveModelProvider } = await import("../lib/agents/model.mjs");
    const provider = resolveModelProvider({});
    const out = await runAgentLoop({
      model: provider,
      system: "s",
      opening: "go",
      maxSteps: 4,
      tools: [{ name: "echo", description: "echo", parameters: { type: "object", properties: { v: { type: "number" } } }, async execute(args) { return { echoed: args.v }; } }],
    });
    assert.equal(out.stop_reason, "final", JSON.stringify(out));
    assert.equal(out.final, "done");
    assert.equal(calls, 2, "应发生两轮真实 HTTP 请求");
    assert.deepEqual(invalid, [], "严格服务器不应发现线格式问题");
  } finally {
    for (const [k, v] of [["SORNE_LLM_BASE_URL", prev.url], ["SORNE_LLM_MODEL", prev.model], ["SORNE_LLM_API_KEY", prev.key]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});

test("循环内核 P0：超出每步上限的 tool_calls 也得到 tool 应答（不产生悬空 id）", async () => {
  let executed = 0;
  let secondMessages = null;
  let calls = 0;
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
  const model = {
    async chat({ messages }) {
      calls += 1;
      if (calls === 1) {
        return { role: "assistant", content: "", finish_reason: "tool_calls", tool_calls: ids.map((id, i) => ({ id, name: "echo", arguments: { i } })) };
      }
      secondMessages = messages.map((m) => JSON.parse(JSON.stringify(m)));
      return { role: "assistant", content: "done", finish_reason: "stop" };
    },
  };
  const tools = [{ name: "echo", description: "", parameters: { type: "object", properties: {} }, async execute() { executed += 1; return { ok: true }; } }];
  const out = await runAgentLoop({ model, system: "s", tools, opening: "go", maxSteps: 4, maxToolCallsPerStep: 2 });
  assert.equal(out.stop_reason, "final");
  assert.equal(executed, 2, "仅执行前 2 个调用");
  const skipped = out.trace.filter((t) => t.skipped);
  assert.equal(skipped.length, 4);
  assert.equal(skipped[0].error.code, "RESOURCE_LIMIT");
  const assistant = secondMessages.find((m) => m.role === "assistant");
  const answered = new Set(secondMessages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  assert.equal(assistant.tool_calls.length, 6);
  for (const id of ids) assert.ok(answered.has(id), "悬空 tool_call id：" + id);
});

/* ══ 2. 本地靶标 ═════════════════════════════════════════════════════ */

test("mock-target：只绑 127.0.0.1；/admin 多 Set-Cookie、/gbk 为 GBK 字节、/backup.zip 为二进制", async () => {
  const target = await startMockTarget({ port: 0 });
  try {
    assert.match(target.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(() => startMockTarget({ host: "0.0.0.0" }), /只允许绑定 127\.0\.0\.1/);

    const admin = await fetch(target.base + "/admin");
    assert.equal(admin.status, 200);
    const cookies = typeof admin.headers.getSetCookie === "function" ? admin.headers.getSetCookie() : [];
    assert.ok(cookies.length >= 2, "应有多个 Set-Cookie（PHPSESSID + role）");
    assert.match(await admin.text(), /未鉴权可访问/);

    const gbkRes = await fetch(target.base + "/gbk");
    assert.match(gbkRes.headers.get("content-type"), /charset=gbk/i);
    const gbkBytes = Buffer.from(await gbkRes.arrayBuffer());
    assert.notEqual(sha256(gbkBytes), sha256(Buffer.from(await (await fetch(target.base + "/gbk")).text(), "utf8")), "GBK 字节不应等于 UTF-8 文本字节");
    // Node 22 TextDecoder 实测支持 gbk（竣工记录有实测证据）
    const decoded = new TextDecoder("gbk").decode(gbkBytes);
    assert.match(decoded, /你好/);

    const zipRes = await fetch(target.base + "/backup.zip");
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipRes.headers.get("content-type"), "application/zip");
    assert.deepEqual([...zipBytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "二进制响应保持原始字节");
  } finally {
    await target.close();
  }
});

/* ══ 3. Worker 证据完整性 + 提交幂等 ═════════════════════════════════ */

async function seedProjectWithIntent(s, { question, deliverables }) {
  const created = await s.request("POST", "/sorne/projects", {
    body: { name: "真实联调测试项目", scope_rules: { allow: ["127.0.0.1"], deny: [], pending: [] } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const projectId = created.body.project.id;
  const model = reactiveModel({
    planner: [
      toolCall("submit_plan", {
        plan_revision: "r1",
        intents: [{
          op: "create",
          local_ref: "i1",
          question,
          kind: "collect",
          success_criteria: "得到可核验的请求/响应证据记录",
          target_asset_ids: [],
          ...(deliverables ? { deliverables } : {}),
        }],
      }),
      finalText("ok"),
    ],
  });
  const plan = await runPlanner(pctxOf(s.dataDir), { projectId, model });
  const call = plan.trace.find((t) => t.tool === "submit_plan" && t.ok);
  assert.ok(call, "计划应提交成功：" + JSON.stringify(plan.trace));
  return { projectId, intentId: call.result.ids.i1 };
}

test("Worker 证据 P0：raw_body 逐字节等于真实响应；同一 tool_call 同表示幂等；同内容提交确定性编号不重复写", () =>
  withTestServer(async (s) => {
    const target = await startMockTarget({ port: 0 });
    try {
      const { projectId, intentId } = await seedProjectWithIntent(s, {
        question: "采集本地靶标 " + target.base + "/gbk 的 GBK 页面原始字节",
      });
      const probeUrl = target.base + "/gbk";
      const model = reactiveModel({
        worker: [
          toolCall("register_tool_call", { url: probeUrl, purpose: "GBK 页面原始字节采集" }),
          (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id, representation: "raw_body" }),
          (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id, representation: "raw_body" }),
          (all, byName) => toolCall("submit_findings", {
            note: "GBK 观察",
            append_observation: { statement: "GBK 页面返回 200，按 charset=gbk 解码后含中文", capture_id: byName("store_evidence").result.capture.capture_id },
          }),
          (all, byName) => toolCall("submit_findings", {
            note: "GBK 观察",
            append_observation: { statement: "GBK 页面返回 200，按 charset=gbk 解码后含中文", capture_id: byName("store_evidence").result.capture.capture_id },
          }),
          (all, byName) => toolCall("complete_tool_call", {
            tool_call_id: byName("register_tool_call").result.tool_call_id,
            outcome: "succeeded",
            evidence_refs: [byName("store_evidence").result.blob.blob_id],
          }),
          () => toolCall("report_progress", { kind: "completion", note: "原始字节已固定" }),
          finalText("done"),
        ],
      });
      const outcome = await runWorker(pctxOf(s.dataDir), { projectId, intentId, model, maxSteps: 10 });
      assert.equal(outcome.stop_reason, "final", JSON.stringify(outcome.trace.map((t) => ({ tool: t.tool, ok: t.ok, code: t.error && t.error.code }))));

      const store = await getStore(pctxOf(s.dataDir));
      const calls = outcome.trace.filter((t) => t.tool === "register_tool_call");
      assert.equal(calls[0].result.observation.body_charset, "gbk", "应按 Content-Type charset 标注 gbk");
      assert.equal(calls[0].result.observation.body_charset_supported, true, "Node 22 TextDecoder 应支持 gbk");
      assert.match(calls[0].result.observation.body_excerpt, /你好/);

      const stores = outcome.trace.filter((t) => t.tool === "store_evidence" && t.ok).map((t) => t.result);
      assert.equal(stores.length, 2);
      assert.equal(stores[0].representation, "raw_body");
      assert.equal(stores[1].idempotent, true, "同表示重复固定应幂等");
      assert.equal(stores[1].blob.blob_id, stores[0].blob.blob_id);
      assert.ok(stores[0].request_ref, "raw_body 应同时固定请求记录（capture.request_ref）");
      assert.ok(stores[0].response_headers_ref, "raw_body 应同时固定全量响应头（capture.response_headers_ref）");

      const blobRow = store.db.prepare("SELECT * FROM blobs WHERE id = ?").get(stores[0].blob.blob_id);
      assert.equal(blobRow.representation, "raw_body");
      const stored = (await readBlobBytes(pctxOf(s.dataDir), { sha256: blobRow.sha256, projectId })).bytes;
      const fresh = Buffer.from(await (await fetch(probeUrl)).arrayBuffer());
      assert.equal(sha256(stored), sha256(fresh), "raw_body 必须逐字节等于真实响应");
      assert.equal(stored.length, fresh.length);

      const captures = store.db.prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id = ?").get(projectId).c;
      assert.equal(captures, 1, "同一 tool_call 只登记一次采集");
      const observations = store.db.prepare("SELECT * FROM observations WHERE project_id = ? ORDER BY created_seq").all(projectId);
      assert.equal(observations.length, 1, "同内容重复提交不得重复建观察（确定性 submission_id 命中原回执）");
      assert.equal(observations[0].capture_id, stores[0].capture.capture_id);
      const subs = outcome.trace.filter((t) => t.tool === "submit_findings" && t.ok).map((t) => t.result);
      assert.equal(subs[0].submission_id, subs[1].submission_id, "submission_id 必须由内容确定性派生");
      assert.deepEqual(subs[0].ids, subs[1].ids);
    } finally {
      await target.close();
    }
  }));

test("Worker 证据 P0：exchange_record 保存全量响应头与完整响应体（二进制用 base64）", () =>
  withTestServer(async (s) => {
    const target = await startMockTarget({ port: 0 });
    try {
      const { projectId, intentId } = await seedProjectWithIntent(s, { question: "采集 " + target.base + "/backup.zip 的二进制响应" });
      const probeUrl = target.base + "/backup.zip";
      const model = reactiveModel({
        worker: [
          toolCall("register_tool_call", { url: probeUrl, purpose: "二进制响应证据" }),
          (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id, representation: "exchange_record" }),
          (all, byName) => toolCall("complete_tool_call", {
            tool_call_id: byName("register_tool_call").result.tool_call_id,
            outcome: "succeeded",
            evidence_refs: [byName("store_evidence").result.blob.blob_id],
          }),
          () => toolCall("report_progress", { kind: "completion", note: "二进制已固定" }),
          finalText("done"),
        ],
      });
      const outcome = await runWorker(pctxOf(s.dataDir), { projectId, intentId, model, maxSteps: 8 });
      assert.equal(outcome.stop_reason, "final");
      const stored = outcome.trace.find((t) => t.tool === "store_evidence" && t.ok).result;
      const blobRow = (await getStore(pctxOf(s.dataDir))).db.prepare("SELECT * FROM blobs WHERE id = ?").get(stored.blob.blob_id);
      assert.equal(blobRow.representation, "exchange_record");
      const bytes = (await readBlobBytes(pctxOf(s.dataDir), { sha256: blobRow.sha256, projectId })).bytes;
      const record = JSON.parse(bytes.toString("utf8"));
      assert.equal(record.schema, "sorne.exchange_record/v1");
      assert.ok(Array.isArray(record.response.headers) && record.response.headers.length >= 3, "全量响应头");
      const fresh = Buffer.from(await (await fetch(probeUrl)).arrayBuffer());
      assert.equal(record.response.body_sha256, sha256(fresh), "完整响应体哈希必须等于真实响应");
      assert.equal(record.response.body_bytes, fresh.length);
      assert.equal(record.response.body_text, null, "二进制不用文本表示");
      assert.equal(Buffer.from(record.response.body_base64, "base64").compare(fresh), 0, "base64 必须逐字节等于真实响应");
      assert.equal(record.response.body_truncated, false);
    } finally {
      await target.close();
    }
  }));

test("意图完成闭环 P0：执行置 running；deliverables_proof 齐备 → resolved + intent.completed；失据 → 待复核", () =>
  withTestServer(async (s) => {
    const target = await startMockTarget({ port: 0 });
    try {
      /* ① 声明交付物 + 提供真实观察编号 → resolved */
      const ok = await seedProjectWithIntent(s, {
        question: "确认 " + target.base + "/health 可访问",
        deliverables: ["带证据的观察记录"],
      });
      const modelOk = reactiveModel({
        worker: [
          toolCall("register_tool_call", { url: target.base + "/health", purpose: "健康端点核验" }),
          (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id }),
          (all, byName) => toolCall("submit_findings", {
            note: "健康端点",
            append_observation: { statement: "健康端点返回 200", capture_id: byName("store_evidence").result.capture.capture_id },
          }),
          (all, byName) => toolCall("complete_tool_call", {
            tool_call_id: byName("register_tool_call").result.tool_call_id,
            outcome: "succeeded",
            evidence_refs: [byName("store_evidence").result.blob.blob_id],
          }),
          (all, byName) => toolCall("report_progress", {
            kind: "completion",
            note: "观察已入库",
            deliverables_proof: [{ index: 0, record_ids: [byName("submit_findings").result.ids.obs1] }],
          }),
          finalText("done"),
        ],
      });
      const outOk = await runWorker(pctxOf(s.dataDir), { projectId: ok.projectId, intentId: ok.intentId, model: modelOk, maxSteps: 10 });
      assert.equal(outOk.intent_state.to, "running", "执行开始应置 running");
      assert.equal(outOk.completion_review.decision, "resolved", JSON.stringify(outOk.completion_review));
      const store = await getStore(pctxOf(s.dataDir));
      assert.equal(store.db.prepare("SELECT status FROM intents WHERE id = ?").get(ok.intentId).status, "resolved");
      assert.ok(
        store.db.prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'intent.completed'").get(ok.projectId),
        "resolved 应产生 intent.completed 事件",
      );
      /* ② 未声明交付物 → awaiting_review（语义不变，不直接 resolved） */
      const pending = await seedProjectWithIntent(s, { question: "语义型问题：" + target.base + "/ 是什么" });
      const modelPending = reactiveModel({
        worker: [
          toolCall("register_tool_call", { url: target.base + "/", purpose: "基线" }),
          (all, byName) => toolCall("store_evidence", { tool_call_id: byName("register_tool_call").result.tool_call_id }),
          (all, byName) => toolCall("complete_tool_call", {
            tool_call_id: byName("register_tool_call").result.tool_call_id,
            outcome: "succeeded",
            evidence_refs: [byName("store_evidence").result.blob.blob_id],
          }),
          () => toolCall("report_progress", { kind: "completion", note: "完成但无交付物" }),
          finalText("done"),
        ],
      });
      const outPending = await runWorker(pctxOf(s.dataDir), { projectId: pending.projectId, intentId: pending.intentId, model: modelPending, maxSteps: 8 });
      assert.equal(outPending.completion_review.decision, "awaiting_review");
      assert.equal(store.db.prepare("SELECT status FROM intents WHERE id = ?").get(pending.intentId).status, "awaiting_review");
    } finally {
      await target.close();
    }
  }));

/* ══ 4. 真实模型联调（可选，SORNE_REALRUN=1）═════════════════════════ */

const realRunReady = process.env.SORNE_REALRUN === "1" && existsSync(LLM_FILE);
test("真实 deepseek-flash 全链路（可选 SORNE_REALRUN=1）：plan→assign→probe→evidence→findings→complete→resolved", { skip: realRunReady ? false : "未设置 SORNE_REALRUN=1 或无 sorne-data/llm.json（不访问外部模型）" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sorne-realrun-test-"));
  copyFileSync(LLM_FILE, join(dataDir, "llm.json"));
  const target = await startMockTarget({ port: 0 });
  const pctx = { dataDir, logger: QUIET };
  try {
    const created = await createProject(pctx, {
      actor: "user",
      name: "真实联调（mock-target）",
      description: "检查 " + target.base + "/admin 是否未授权可访问",
      scopeRules: { allow: [target.base + "/", "127.0.0.1"], deny: [], pending: [] },
    });
    const projectId = created.project.id;
    await createPlanRequest(pctx, {
      session: issueSession({ project_id: projectId, actor: "orchestrator-agent", role: "orchestrator" }),
      question: "首次探索规划：" + target.base + "/admin 是否未授权可访问（授权范围仅 127.0.0.1）",
    });
    const rt = startAgentRuntime(pctx, { tickMs: 600000, logger: QUIET });
    try {
      assert.equal(rt.started, true);
      let resolved = false;
      for (let round = 1; round <= 8 && !resolved; round += 1) {
        const summary = await rt.runOnce(projectId);
        if (summary && summary.skipped) break;
        const store = await getStore(pctx);
        resolved = Boolean(store.db.prepare("SELECT 1 FROM intents WHERE project_id = ? AND status = 'resolved' LIMIT 1").get(projectId));
      }
      const store = await getStore(pctx);
      assert.ok(resolved, "真实模型应至少完成并 resolve 一条意图（完整计划/执行/证据链路）");
      const captures = store.db.prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id = ?").get(projectId).c;
      const blobs = store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ?").get(projectId).c;
      assert.ok(captures >= 1 && blobs >= 1, "应有真实 Capture/Blob 证据：" + captures + "/" + blobs);
      const toolCalls = store.db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE project_id = ? AND status = 'succeeded'").get(projectId).c;
      assert.ok(toolCalls >= 1, "应有成功的工具调用");
    } finally {
      rt.stop();
      await closeStore(pctx);
    }
  } finally {
    await target.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
