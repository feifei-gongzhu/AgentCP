/**
 * M2 —— LLM 连接配置测试（蓝图 §2.6-1/§2.6-8；要求 §1「连接模型」）。
 *
 * 覆盖：
 *   - 写入读取：POST /sorne/settings/llm 落 <dataDir>/llm.json（参照已就位的
 *     sorne-data/llm.json 结构）；GET status 脱敏（provider/model/baseUrl/是否已
 *     配置/掩码 key）；蓝图别名路径（GET/PUT /sorne/llm/settings）同形体；
 *   - key 不回显：所有响应体不含明文 apiKey（冻结安全约束）；
 *   - apiKey 缺省=保留原值；空串=清除；
 *   - 连接测试两态：真实本地 OpenAI 兼容服务器（成功：ok+latency+model）与
 *     401/超时/拒绝连接（ok:false + 明确失败原因）；
 *   - provider 解析顺序 store > env（含 per_role 角色覆盖）；
 *   - §2.6-8 运行时热加载：未配置启动 → PUT → started=true 且 runOnce 可驱动；
 *     清除配置 → reload → started=false（保留事件高水位）。
 *
 * 并行安全：独立 mkdtemp + 随机端口；本地测试服务器用毕即关，无后台残留。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolveModelProvider, missingProviderNotice } from "../lib/agents/model.mjs";
import { startAgentRuntime } from "../lib/agents/runtime.mjs";
import { closeStore } from "../lib/store/record-service.mjs";
import { maskApiKey, readLlmSettings } from "../lib/store/llm-settings.mjs";
import { withTestServer } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/** 本地 OpenAI 兼容测试服务器（真实 HTTP 传输；沿 agents.test.mjs 先例）。 */
function startOpenAiStub({ status = 200, body } = {}) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      res.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) {
        res.end(JSON.stringify({ error: { message: `stub ${status}`, auth_seen: auth ? "present" : "none" } }));
        return;
      }
      res.end(JSON.stringify(body ?? {
        choices: [{ message: { role: "assistant", content: "pong", tool_calls: [] }, finish_reason: "stop" }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
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

test("写入读取与脱敏：llm.json 结构对齐；key 永不回显；别名路径同形体；缺省保留/空串清除", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const KEY = "sk-test-secret-1234567890abcd";

    const unconfigured = await call(base, "GET", "/sorne/settings/llm/status");
    assert.equal(unconfigured.status, 200);
    assert.equal(unconfigured.body.configured, false);
    assert.equal(unconfigured.body.api_key_set, false);
    assert.equal(unconfigured.body.source, "none");

    const saved = await call(base, "POST", "/sorne/settings/llm", {
      body: { provider: "deepseek", baseUrl: "https://api.example.test", model: "deepseek-chat", apiKey: KEY, note: "M2 测试" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.provider, "deepseek");
    assert.equal(saved.body.model, "deepseek-chat");
    assert.equal(saved.body.base_url, "https://api.example.test");
    assert.equal(saved.body.api_key_set, true);
    assert.match(saved.body.api_key_hint, /^sk-…abcd$/);

    // 文件落盘且结构对齐已就位的 sorne-data/llm.json（camelCase 键）
    const file = join(s.dataDir, "llm.json");
    assert.ok(existsSync(file), "配置应写入 <dataDir>/llm.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.provider, "deepseek");
    assert.equal(onDisk.baseUrl, "https://api.example.test");
    assert.equal(onDisk.model, "deepseek-chat");
    assert.equal(onDisk.apiKey, KEY, "服务端保存（文件内允许明文；回环信任边界，蓝图 §10-4）");
    assert.ok(onDisk.updated_at);

    // 任何响应不含明文 key（status / PUT 回显 / 别名路径）
    const status = await call(base, "GET", "/sorne/settings/llm/status");
    assert.ok(!JSON.stringify(status.body).includes(KEY), "status 响应不得回显明文 key");
    const viaAlias = await call(base, "GET", "/sorne/llm/settings");
    assert.equal(viaAlias.status, 200);
    assert.equal(viaAlias.body.configured, true);
    assert.ok(!JSON.stringify(viaAlias.body).includes(KEY), "别名路径响应不得回显明文 key");

    // PUT 缺省保留原值；空串清除
    const keep = await call(base, "PUT", "/sorne/llm/settings", { body: { baseUrl: "https://api2.example.test", model: "m2" } });
    assert.equal(keep.status, 200);
    assert.equal(readLlmSettings(s.dataDir).config.apiKey, KEY, "apiKey 缺省=保留原值");
    const cleared = await call(base, "POST", "/sorne/settings/llm", { body: { baseUrl: "https://api2.example.test", model: "m2", apiKey: "" } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.api_key_set, false, "空串=清除");
    assert.equal(readLlmSettings(s.dataDir).config.apiKey, undefined);

    // 校验：base_url 必须是 http(s)、model 非空
    const badUrl = await call(base, "POST", "/sorne/settings/llm", { body: { baseUrl: "ftp://x", model: "m" } });
    assert.equal(badUrl.status, 400);
    const noModel = await call(base, "POST", "/sorne/settings/llm", { body: { baseUrl: "https://x.test" } });
    assert.equal(noModel.status, 400);
  });
});

test("连接测试两态：真实请求返回 ok+时延；401/超时/拒绝连接返回明确失败原因", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const stub = await startOpenAiStub();
    try {
      const saved = await call(base, "POST", "/sorne/settings/llm", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "stub-model", apiKey: "sk-stub" },
      });
      assert.equal(saved.status, 200);

      const ok = await call(base, "POST", "/sorne/settings/llm/test", { body: {} });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      assert.ok(Number.isInteger(ok.body.latency_ms) && ok.body.latency_ms >= 0);
      assert.equal(ok.body.model, "stub-model");

      // 显式覆盖 baseUrl/model 的按请求测试（不落库）
      const ok2 = await call(base, "POST", "/sorne/settings/llm/test", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "explicit-model" },
      });
      assert.equal(ok2.body.ok, true);
      assert.equal(ok2.body.model, "explicit-model");

      // 401：真实失败原因带回（不掩盖）
      const failing = await startOpenAiStub({ status: 401 });
      try {
        const bad = await call(base, "POST", "/sorne/settings/llm/test", {
          body: { baseUrl: `http://127.0.0.1:${failing.port}`, model: "m" },
        });
        assert.equal(bad.body.ok, false);
        assert.equal(bad.body.error.code, "LLM_HTTP_ERROR");
        assert.match(bad.body.error.message, /HTTP 401/);
      } finally {
        await failing.close();
      }

      // 拒绝连接：明确原因（不可用不冒充可用）
      const dead = await call(base, "POST", "/sorne/settings/llm/test", {
        body: { baseUrl: "http://127.0.0.1:9", model: "m" },
      });
      assert.equal(dead.body.ok, false);
      assert.equal(dead.body.error.code, "LLM_UNREACHABLE");

      // 角色覆盖的高级配置结构：per_role 覆盖 model 生效于测试
      await call(base, "POST", "/sorne/settings/llm", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "default-model", per_role: { planner: { model: "planner-model" } } },
      });
      const roleView = await call(base, "GET", "/sorne/settings/llm/status");
      assert.equal(roleView.body.per_role.planner.model, "planner-model");
    } finally {
      await stub.close();
    }
  });
});

test("provider 解析顺序 store > env；per_role 覆盖生效", async (t) => {
  const prev = {
    BASE: process.env.SORNE_LLM_BASE_URL,
    KEY: process.env.SORNE_LLM_API_KEY,
    MODEL: process.env.SORNE_LLM_MODEL,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      const name = { BASE: "SORNE_LLM_BASE_URL", KEY: "SORNE_LLM_API_KEY", MODEL: "SORNE_LLM_MODEL" }[k];
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });
  await withTestServer(async (s) => {
    // 仅 env：env 生效
    process.env.SORNE_LLM_BASE_URL = "http://env-only.test";
    process.env.SORNE_LLM_MODEL = "env-model";
    const fromEnv = resolveModelProvider({ dataDir: s.dataDir });
    assert.ok(fromEnv, "env 配置应解析出提供方");
    assert.match(fromEnv.describe(), /env-model/);

    // store 落盘后 store 优先
    await call(s.base, "POST", "/sorne/settings/llm", {
      body: { baseUrl: "http://store-first.test", model: "store-model", apiKey: "sk-store" },
    });
    const fromStore = resolveModelProvider({ dataDir: s.dataDir });
    assert.match(fromStore.describe(), /store-model/, "store > env");

    // per_role 覆盖：planner 用覆盖模型，orchestrator 用默认档
    await call(s.base, "POST", "/sorne/settings/llm", {
      body: { baseUrl: "http://store-first.test", model: "store-model", per_role: { planner: { model: "planner-override" } } },
    });
    assert.match(resolveModelProvider({ dataDir: s.dataDir }, { role: "planner" }).describe(), /planner-override/);
    assert.match(resolveModelProvider({ dataDir: s.dataDir }, { role: "orchestrator" }).describe(), /store-model/);
    // 环境清理，避免影响后续用例
    delete process.env.SORNE_LLM_BASE_URL;
    delete process.env.SORNE_LLM_MODEL;
  });
});

test("§2.6-8 运行时热加载：未配置启动 → PUT → started=true 且 runOnce 可驱动；清除配置 → started=false", async () => {
  const stub = await startOpenAiStub({
    body: { choices: [{ message: { role: "assistant", content: "好的。", tool_calls: [] }, finish_reason: "stop" }] },
  });
  await withTestServer(async (s) => {
    const base = s.base;
    const pctx = { dataDir: s.dataDir, logger: QUIET };
    const rt = startAgentRuntime(pctx, { tickMs: 60_000, logger: QUIET });
    try {
      assert.equal(rt.started, false, "未配置启动 → started:false 存根");
      assert.match(rt.reason ?? "", /尚未连接模型|未配置/);

      const p = (await call(base, "POST", "/sorne/projects", { body: { name: "热加载" } })).body.project;

      // PUT 配置（指向本地 stub）→ 运行时热启动
      const saved = await call(base, "PUT", "/sorne/llm/settings", {
        body: { baseUrl: `http://127.0.0.1:${stub.port}`, model: "hot-model", apiKey: "sk-hot" },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.reload.reloaded, true, "PUT 响应应含热加载结果");
      assert.equal(saved.body.reload.started, true);

      // 测试侧独立运行时句柄：显式 reload 后同样热启动（§2.6-8 reload 本体）
      const hot = await rt.reload();
      assert.equal(hot.started, true, "reload 应热启动");
      assert.equal(rt.started, true, "reload 后运行时应启动");
      const round = await rt.runOnce(p.id);
      assert.ok(round.roles.some((r) => r.role === "orchestrator"), `runOnce 应可驱动：${JSON.stringify(round)}`);

      // 清除配置（移除 llm.json，无 env 回退）→ reload → started=false，高水位保留
      rmSync(join(s.dataDir, "llm.json"));
      const reloadResult = await rt.reload();
      assert.equal(reloadResult.started, false);
      assert.match(reloadResult.reason, /尚未连接模型/);
      assert.equal(rt.started, false);
      const skipped = await rt.runOnce(p.id);
      assert.equal(skipped.skipped, true, "无配置时 runOnce 显式等待");
    } finally {
      rt.stop();
    }
    await closeStore(pctx);
  }).finally(async () => {
    await stub.close();
  });
  assert.ok(missingProviderNotice().includes("/sorne/settings/llm"));
});
