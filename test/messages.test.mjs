/**
 * M2 —— 用户消息闭环测试（蓝图 §2.6-2 / P0-6；要求 §4「消息发出后必须看到它已经
 * 被接收、对应哪个任务，以及 AI 作出了什么处理」）。
 *
 * 覆盖：
 *   - 消息闭环：接收（received）→ runOnce（脚本化模型）→ 决定关联 → AI 回复 →
 *     GET 呈现三段（已接收/对应任务/AI 处理结果）；未闭环消息不得显示为已答复；
 *   - 附件闭环：上传 blob → attachments 进入 AI 上下文（read_blob 真实读取字节）→
 *     AI 回复 → GET 呈现 links 含 blob；附件引用不存在 → INVALID_REFERENCE 整条拒绝；
 *   - 唤醒：仅新用户消息即可触发 hasWork；等待中的项目（waiting_for_change）收到
 *     用户消息视为条件变化唤醒（程序 resume，事件落库）；
 *   - 游标分页（cursor/limit，信封 next_cursor + has_more）；
 *   - 引用（refs）逐项校验：不存在的持久记录编号 → INVALID_REFERENCE。
 *
 * 真实注入：存储/事务/Outbox/运行时全真实；模型为确定性替身（沿 AGENTS 模块先例，
 * 不依赖真实 LLM）。并行安全：独立 mkdtemp + 随机端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { startAgentRuntime } from "../lib/agents/runtime.mjs";
import { normalizeAssistantMessage } from "../lib/agents/model.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { withTestServer } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

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

/** 确定性模型替身（同 test/agents.test.mjs 的 reactiveModel；按 system 角色路由）。 */
function reactiveModel(scriptsByRole, { model = "m2-msg-test" } = {}) {
  const cursors = new Map();
  return {
    kind: "scripted",
    model,
    describe: () => `scripted:${model}`,
    async chat({ system, messages }) {
      const role = /Orchestrator/.test(system) ? "orchestrator" : /Planner/.test(system) ? "planner" : "default";
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
      const message = typeof step === "function" ? step(flat) : step;
      return normalizeAssistantMessage(message);
    },
  };
}

test("消息闭环：接收 → 决定关联 → AI 回复 → GET 呈现已接收/对应任务/AI 处理结果", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await s.request("POST", "/sorne/projects", { body: { name: "消息闭环", description: "验证登录相关功能" } })).body.project;

    const sent = await s.request("POST", "/sorne/messages", {
      body: { project_id: p.id, content: "接下来优先研究登录相关功能。" },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const msg = sent.body.message;
    assert.match(msg.id, /^MSG-PRJ-\d{4}-\d{4}$/);
    assert.equal(msg.direction, "user");
    assert.equal(msg.status, "received", "持久化即 received（delivered ≠ handled）");
    assert.equal(sent.body.state, "queued_for_orchestrator");

    // 未闭环时不得显示为已答复
    const before = await s.request("GET", `/sorne/messages/${msg.id}?project_id=${p.id}`);
    assert.equal(before.body.message.status, "received");
    assert.match(before.body.note, /尚未完成处理|received/);

    // 运行时驱动一轮：脚本化 Orchestrator 以 source_message_id 提交决定
    const pctx = { dataDir: s.dataDir, logger: QUIET };
    const model = reactiveModel({
      orchestrator: [
        () => toolCall("submit_decision", {
          rationale: "已收到用户优先级指示：优先研究登录相关功能；已请求规划。", // AI 回复内容 = 决定理由（§2.6-2）
          source_message_id: msg.id,
          actions: [{
            action_kind: "request_planning",
            idempotency_key: "m2-msg-plan-1",
            payload: { question: "优先研究登录相关功能", record_refs: [] },
          }],
        }),
        () => finalText("已受理并请求规划。"),
      ],
    });
    pctx.__modelProvider = model;
    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    assert.equal(rt.started, true);
    const round = await rt.runOnce(p.id);
    assert.ok(round.roles.some((r) => r.role === "orchestrator"), JSON.stringify(round));
    rt.stop();

    // 闭环三段呈现
    const view = await s.request("GET", `/sorne/messages/${msg.id}?project_id=${p.id}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.message.status, "handled", "关联协调决定持久化后才算 handled");
    const decisionLink = view.body.message.links.find((l) => l.kind === "orchestration_decision");
    assert.ok(decisionLink, "links 应含 orchestration_decision");
    const planLink = view.body.message.links.find((l) => l.kind === "plan_run");
    assert.ok(planLink, "动作产生的 plan_run 应补进关联（展示对应任务）");
    assert.equal(view.body.replies.length, 1, "AI 回复应到达");
    const reply = view.body.replies[0];
    assert.equal(reply.direction, "ai");
    assert.equal(reply.reply_to, msg.id);
    assert.match(reply.content, /优先研究登录相关功能/);
    assert.equal(reply.status, "handled");
    assert.equal(reply.source_decision_id, decisionLink.ref_id);

    // 决定已真实落库（request_planning 建立 plan_run）
    const store = await getStore(pctx);
    const planRun = store.db.prepare("SELECT * FROM plan_runs WHERE project_id = ? ORDER BY created_seq DESC LIMIT 1").get(p.id);
    assert.ok(planRun, "request_planning 动作应建立 plan_run");
    assert.equal(planRun.id, planLink.ref_id);

    // 列表面呈现两方向消息
    const list = await s.request("GET", `/sorne/messages?project_id=${p.id}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.messages.some((m) => m.id === msg.id && m.status === "handled"));
    assert.ok(list.body.messages.some((m) => m.direction === "ai"));
    await closeStore(pctx);
  });
});

test("附件消息闭环：blob 字节经 read_blob 进入 AI 上下文；links 含 blob；引用不存在整条拒绝", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await s.request("POST", "/sorne/projects", { body: { name: "附件闭环" } })).body.project;
    const content = "interface-doc-v1: POST /api/login 使用 JSON body";
    const bytes = Buffer.from(content, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const up = await fetch(`${base}/sorne/evidence/blobs?project_id=${p.id}&representation=uploaded_file`, {
      method: "POST", headers: { origin: base, "content-type": "application/octet-stream" }, body: bytes,
    });
    const upText = await up.text();
    assert.equal(up.status, 200, upText);
    const upBody = JSON.parse(upText);
    const blobId = upBody.blob_id ?? upBody.blob?.blob_id;

    let blobToolSawBytes = false;
    const pctx = { dataDir: s.dataDir, logger: QUIET };
    const model = reactiveModel({
      orchestrator: [
        (flat) => {
          void flat;
          return toolCall("read_blob", { sha256: sha });
        },
        (flat) => {
          const blobResult = flat.find((r) => r && r.sha256 === sha);
          blobToolSawBytes = Boolean(blobResult && blobResult.text === content);
          return toolCall("submit_decision", {
            rationale: "已读取用户补充的接口文档并纳入上下文，等待规划消化。",
            source_message_id: currentMsgId,
            actions: [{ action_kind: "record_strategy", idempotency_key: "m2-att-1", payload: { strategy: "continue", reason: "附件已读" } }],
          });
        },
        () => finalText("附件已读。"),
      ],
    });
    pctx.__modelProvider = model;

    // 附件引用不存在 → INVALID_REFERENCE 整条拒绝（不半提交）
    const bad = await s.request("POST", "/sorne/messages", {
      body: { project_id: p.id, content: "带坏附件", attachments: [{ kind: "blob", ref: "deadbeef" }] },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "INVALID_REFERENCE");
    const none = await s.request("GET", `/sorne/messages?project_id=${p.id}`);
    assert.equal(none.body.messages.filter((m) => m.content === "带坏附件").length, 0, "被拒消息不得半提交入库");

    // 正常附件消息
    const sent = await s.request("POST", "/sorne/messages", {
      body: { project_id: p.id, content: "我补充了一份接口文档。", attachments: [{ kind: "blob", ref: sha }] },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const currentMsgId = sent.body.message.id;

    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    await rt.runOnce(p.id);
    rt.stop();
    assert.ok(blobToolSawBytes, "AI 必须经 read_blob 真实读取到附件字节（J4 资料被接收的可证测试）");

    const view = await s.request("GET", `/sorne/messages/${currentMsgId}?project_id=${p.id}`);
    assert.equal(view.body.message.status, "handled");
    const blobLink = view.body.message.attachments.find((a) => a.kind === "blob");
    assert.ok(blobLink, "GET 应呈现附件（blob 半边闭环）");
    assert.equal(blobLink.sha256, sha);
    assert.match(blobLink.read_path, /\/sorne\/evidence\/blobs\//);
    assert.ok(view.body.replies.length >= 1);
    await closeStore(pctx);
  });
});

test("唤醒：仅新用户消息即可触发 hasWork；等待中的项目收到用户消息视为条件变化唤醒", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await s.request("POST", "/sorne/projects", { body: { name: "唤醒项目", description: "目标" } })).body.project;

    const pctx = { dataDir: s.dataDir, logger: QUIET };
    let wakeMsgId;
    pctx.__modelProvider = reactiveModel({
      orchestrator: [
        () => toolCall("submit_decision", {
          rationale: "收到用户消息，条件已变化，继续推进。",
          source_message_id: wakeMsgId,
          actions: [{ action_kind: "record_strategy", idempotency_key: "m2-wake-1", payload: { strategy: "continue", reason: "用户消息唤醒" } }],
        }),
        () => finalText("收到。"),
      ],
    });
    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });

    // 首轮消化项目创建事件；其后无任何工作时等待（不空转）
    await rt.runOnce(p.id);
    const idle = await rt.runOnce(p.id);
    assert.equal(idle.skipped, true, JSON.stringify(idle));

    // 置为等待（waiting_for_change）后，仅新用户消息即应唤醒
    const wait = await s.request("POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "wait" } });
    assert.equal(wait.status, 200, JSON.stringify(wait.body));
    const sent = await s.request("POST", "/sorne/messages", {
      body: { project_id: p.id, content: "我补充了访问条件，请继续。" },
    });
    assert.equal(sent.status, 200);
    wakeMsgId = sent.body.message.id;

    const round = await rt.runOnce(p.id);
    assert.ok(round.roles.some((r) => r.role === "orchestrator"), `用户消息应唤醒等待中的项目：${JSON.stringify(round)}`);

    // 程序 resume 事实落库（waiting_for_change → active + 事件）
    const proj = await s.request("GET", `/sorne/projects/${p.id}`);
    assert.equal(proj.body.project.status, "active", "等待中的项目收到用户消息视为条件变化唤醒");
    const store = await getStore(pctx);
    const ev = store.db
      .prepare(`SELECT payload FROM outbox WHERE project_id = ? AND event_type = 'resource_state.changed' ORDER BY rowid DESC LIMIT 1`)
      .get(p.id);
    assert.ok(ev, "唤醒 resume 应落事件");
    assert.equal(JSON.parse(ev.payload).cause, "user_message");
    rt.stop();
    await closeStore(pctx);
  });
});

test("消息校验与游标分页：content 限长；refs 不存在拒绝；cursor/limit 翻页不重复", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await s.request("POST", "/sorne/projects", { body: { name: "消息分页" } })).body.project;

    const empty = await s.request("POST", "/sorne/messages", { body: { project_id: p.id, content: "  " } });
    assert.equal(empty.status, 400);
    const tooLong = await s.request("POST", "/sorne/messages", { body: { project_id: p.id, content: "x".repeat(8001) } });
    assert.equal(tooLong.status, 400);
    const badRef = await s.request("POST", "/sorne/messages", { body: { project_id: p.id, content: "引用", refs: ["X-9999"] } });
    assert.equal(badRef.status, 422);
    assert.equal(badRef.body.code, "INVALID_REFERENCE");

    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await s.request("POST", "/sorne/messages", { body: { project_id: p.id, content: `消息 ${i}` } });
      assert.equal(r.status, 200);
      ids.push(r.body.message.id);
    }
    const page1 = await s.request("GET", `/sorne/messages?project_id=${p.id}&limit=2`);
    assert.equal(page1.body.messages.length, 2);
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.next_cursor);
    const page2 = await s.request("GET", `/sorne/messages?project_id=${p.id}&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`);
    assert.equal(page2.body.messages.length, 1);
    const seen = [...page1.body.messages, ...page2.body.messages].map((m) => m.id);
    assert.equal(new Set(seen).size, 3, "两页消息集不重复");

    // 跨项目 404 不泄露
    const stranger = await s.request("GET", `/sorne/messages/${ids[0]}?project_id=PRJ-9999`);
    assert.equal(stranger.status, 404);
  });
});
