/**
 * M2 —— 开始探索测试（蓝图 §2.6-3 / §d-5；要求 §3「开始探索后展示真实进展」）。
 *
 * 覆盖：
 *   - 未配置模型 → 409 LLM_NOT_CONFIGURED，next_requirements 指向设置端点；
 *   - 配置后同进程成功（入口 §2.6-8 reload；配置指向本地 OpenAI 兼容 stub）：
 *     复用 E1 createPlanRequest 建立 plan_run（in_flight）与项目保持 active；
 *   - 幂等：重复调用返回既有 plan_run 不重复建（§16.1 单规划在途）；
 *   - stopped 项目需先 resume（沿用生命周期约束）；
 *   - 目标即项目 description（空描述以默认问题发起并明确标注）。
 *
 * 真实注入：真实端点 + 真实 SQLite；本地 stub 用毕即关。并行安全：mkdtemp + 随机端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { withTestServer } from "./helpers.mjs";

function startChatStub() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function call(base, method, path, { body } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test("未配置模型：409 LLM_NOT_CONFIGURED，next_requirements 指向设置；项目仍可保存", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "未配置", description: "目标 A" } })).body.project;
    const res = await call(base, "POST", `/sorne/projects/${p.id}/explore-start`, { body: {} });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "LLM_NOT_CONFIGURED");
    assert.match(res.body.message, /尚未连接模型，项目可以保存，AI 暂不能开始/);
    assert.ok(Array.isArray(res.body.next_requirements));
    assert.ok(res.body.next_requirements.some((r) => r.includes("/sorne/settings/llm")));

    // 项目仍可保存/读取（服务正常 ≠ AI 可工作）
    const detail = await call(base, "GET", `/sorne/projects/${p.id}`);
    assert.equal(detail.status, 200);
  });
});

test("配置后同进程成功：reload 热启动 → 建 plan_request 与 plan_run（in_flight）→ 幂等返回既有", async () => {
  const stub = await startChatStub();
  try {
    await withTestServer(async (s) => {
      const base = s.base;
      const p = (await call(base, "POST", "/sorne/projects", {
        body: { name: "开始探索", description: "对示例站点开展登录相关探索" },
      })).body.project;

      // 配置（经 PUT /sorne/llm/settings；别名面）
      const saved = await call(base, "PUT", "/sorne/llm/settings", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "stub-model", apiKey: "sk-stub" },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.reload.started, true, "配置后运行时热启动（§2.6-8）");

      const started = await call(base, "POST", `/sorne/projects/${p.id}/explore-start`, { body: {} });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.deduped, false);
      assert.ok(started.body.plan_request_id, "应返回规划请求（协调决定）编号");
      assert.match(started.body.plan_run_id, /^PR-/);
      assert.equal(started.body.project.status, "active");
      assert.ok(started.body.reload, "响应如实标注热加载事实");

      // 真实库内事实：plan_run in_flight；决定已持久化
      const run = await call(base, "GET", `/sorne/records/${started.body.plan_run_id}?project_id=${p.id}`);
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.equal(run.body.record.status, "in_flight");

      // 重复调用：幂等返回既有（不重复建）
      const again = await call(base, "POST", `/sorne/projects/${p.id}/explore-start`, { body: {} });
      assert.equal(again.status, 200);
      assert.equal(again.body.deduped, true);
      assert.equal(again.body.plan_run_id, started.body.plan_run_id);

      // 诊断面可见在途规划（§2.6-4 交叉）
      const diag = await call(base, "GET", `/sorne/diagnostics?project_id=${p.id}`);
      assert.equal(diag.body.project.plan.plan_runs_in_flight, 1);
    });
  } finally {
    await stub.close();
  }
});

test("stopped 项目需先 resume；waiting_for_change 开始探索置回 active", async () => {
  const stub = await startChatStub();
  try {
    await withTestServer(async (s) => {
      const base = s.base;
      const saved = await call(base, "POST", "/sorne/settings/llm", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "stub-model" },
      });
      assert.equal(saved.status, 200);

      const p = (await call(base, "POST", "/sorne/projects", { body: { name: "生命周期", description: "g" } })).body.project;
      const stopped = await call(base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
      assert.equal(stopped.status, 200);
      const denied = await call(base, "POST", `/sorne/projects/${p.id}/explore-start`, { body: {} });
      assert.equal(denied.status, 422);
      assert.equal(denied.body.code, "PRECONDITION_INVALID");
      assert.match(denied.body.next_requirements.join(" "), /resume/);

      // resume 后可开始
      await call(base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "resume" } });

      // waiting_for_change → 开始探索置回 active
      const p2 = (await call(base, "POST", "/sorne/projects", { body: { name: "等待后开始", description: "" } })).body.project;
      await call(base, "POST", `/sorne/projects/${p2.id}/lifecycle`, { body: { action: "wait" } });
      const waked = await call(base, "POST", `/sorne/projects/${p2.id}/explore-start`, { body: {} });
      assert.equal(waked.status, 200, JSON.stringify(waked.body));
      assert.equal(waked.body.project.status, "active", "开始探索即条件满足（确保项目处于 active）");
      assert.ok(waked.body.plan_request_id, "空描述以默认问题发起（规划请求仍建立）");
    });
  } finally {
    await stub.close();
  }
});
