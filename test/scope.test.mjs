/**
 * C2 —— 范围与执行条件测试（规范 §17；蓝图 §7 场景 20 主责：用户停止或范围收缩）。
 *
 * 覆盖：
 *   - §20.3 场景 20：用户停止或范围收缩 → 后续工具动作被程序阻止，历史记录保留；
 *   - 范围版本化：allow/deny/pending 三区、明确拒绝优先、未配置/未列出/待判断
 *     均不得默认可操作（SCOPE_UNRESOLVED / SCOPE_DENIED）；
 *   - 派发时与动作前（register/start）逐目标校验；重定向/新目标逐跳过闸；
 *   - 已发出操作经 complete 记录实际结果并附 touched_targets 事后判定（不假装撤回）；
 *   - source_type=official 等自报来源不能绕过授权；
 *   - requires_state=scope_status 谓词与范围判定联动；
 *   - assets.scope_status 在派发时评估回写。
 *
 * 真实注入：范围收缩经 A1 真实端点（POST /scope-revisions）落新版本；用户停止经
 * A1 真实端点（POST /projects/:id/lifecycle）落库；租约过期经真实库行写入；
 * 事务与事件经真实 SQLite；不使用 mock。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { matchScopeRule, parseTarget } from "../lib/store/scope.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

async function call(base, method, path, { body, session } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-sorne-session"] = session.session_token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function bootServer(dataDir) {
  const prev = process.env.SORNE_DATA_DIR;
  process.env.SORNE_DATA_DIR = dataDir;
  let route;
  try {
    const registered = [];
    apply({
      webServer: { register: (o) => (registered.push(o), () => {}) },
      logger: QUIET,
      effect: (fn) => fn(),
    });
    route = registered[registered.length - 1];
  } finally {
    if (prev === undefined) delete process.env.SORNE_DATA_DIR;
    else process.env.SORNE_DATA_DIR = prev;
  }
  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function withServer(fn) {
  const dataDir = makeTempDir("sorne-c2-scope-");
  const s = await bootServer(dataDir);
  try {
    return await fn({ ...s, dataDir });
  } finally {
    await s.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function createProject(base, name = "C2 范围测试") {
  const res = await call(base, "POST", "/sorne/projects", { body: { name } });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

async function setScope(base, projectId, rules, summary = "") {
  const res = await call(base, "POST", "/sorne/scope-revisions", {
    body: { project_id: projectId, rules, summary },
  });
  assert.equal(res.status, 200, `范围版本失败：${JSON.stringify(res.body)}`);
  return res.body;
}

async function seedIntent(dataDir, projectId, overrides = {}) {
  const store = await getStore({ dataDir });
  return store.runSerial((db) => {
    const id = overrides.id ?? `I-${8000 + Math.floor(Math.random() * 1999)}`;
    db.prepare(
      `INSERT INTO intents (id, project_id, question, kind, target_asset_ids, basis_refs,
         prerequisite_refs, condition_requirements, deliverables, priority, budget,
         resume_conditions, status, state_version, created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, 'q', 'investigate', ?, '[]', ?, '[]', '[]', 5, ?, '[]', ?, 1, ?, 'seed', 1, 0)`,
    ).run(
      id,
      projectId,
      JSON.stringify(overrides.target_asset_ids ?? []),
      JSON.stringify(overrides.prerequisite_refs ?? []),
      JSON.stringify(overrides.budget ?? {}),
      overrides.status ?? "queued",
      new Date().toISOString(),
    );
    return id;
  });
}

async function createAsset(base, projectId, canonicalKey, assetType = "domain") {
  const w = issueSession({ project_id: projectId, actor: "seed-worker", role: "worker" });
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: `sc-asset-${canonicalKey}-${Math.floor(Math.random() * 1e9)}`,
      operations: [
        { op: "register_asset", local_ref: "a", asset_type: assetType, canonicalization_version: "v1", canonical_key: canonicalKey },
      ],
    },
    session: w,
  });
  assert.equal(res.status, 200, `资产建立失败：${JSON.stringify(res.body)}`);
  return res.body.ids.a;
}

async function dispatch(base, rt, body) {
  const res = await call(base, "POST", "/sorne/attempts", { body, session: rt });
  return res;
}

async function rows(dataDir) {
  const store = await getStore({ dataDir });
  return store.db;
}

/* ── 0. 纯匹配语义（parseTarget / matchScopeRule） ────────────────── */

test("范围条目匹配语义：主机/通配/URL 条目、端口与路径前缀、拒绝优先数据面", () => {
  const url = parseTarget("https://Test.Com:8443/api/x");
  assert.equal(url.kind, "url");
  assert.equal(url.host, "test.com");
  assert.equal(url.port, 8443);
  assert.equal(parseTarget("https://a.test")?.port, 443);
  assert.equal(parseTarget("http://a.test")?.port, 80);
  assert.equal(parseTarget("test.com").kind, "host");
  assert.equal(parseTarget("not a target"), null);

  // 主机条目匹配任意 scheme/端口
  assert.equal(matchScopeRule("test.com", url), true);
  assert.equal(matchScopeRule("other.com", url), false);
  // 通配：子域命中、裸域不命中
  assert.equal(matchScopeRule("*.test.com", parseTarget("https://a.b.test.com/")), true);
  assert.equal(matchScopeRule("*.test.com", parseTarget("https://test.com/")), false);
  // URL 条目：scheme/端口/路径前缀约束
  assert.equal(matchScopeRule("https://test.com:8443/api", url), true);
  assert.equal(matchScopeRule("https://test.com:8443/other", url), false);
  assert.equal(matchScopeRule("http://test.com:8443/api", url), false); // scheme 不同
  assert.equal(matchScopeRule("https://test.com/api", parseTarget("https://test.com/api/x?q=1")), true);
  assert.equal(matchScopeRule("https://test.com/", parseTarget("https://test.com/any")), true);
  // URL 条目不匹配裸主机目标（无法核实 scheme/端口 → 判不匹配，交由 pending）
  assert.equal(matchScopeRule("https://test.com/", parseTarget("test.com")), false);
  // 对象条目：未给出字段为通配
  assert.equal(matchScopeRule({ host: "test.com", scheme: "https" }, url), true);
  assert.equal(matchScopeRule({ host: "test.com", port: 443 }, url), false);
  assert.equal(matchScopeRule({ host: "*.test.com", path_prefix: "/api" }, parseTarget("https://a.test.com:8443/api/x")), true);
  // 畸形条目不匹配（对象缺 host）
  assert.equal(matchScopeRule({ scheme: "https" }, url), false);
});

/* ── 0b. P0-5 跨 host 不匹配与路径通配（DeepSeek 评审 §7a 回归闸） ── */

test("P0-5：URL 条目跨 host 一律不匹配（deny/pending/allow 三态；评审实测样本进向量）", () => {
  // deny 规则跨 host 不得命中（评审实测：https://app.example.test/admin 规则
  // 曾放行 https://evil.other.test/admin → 跨 host deny 误拒修复判据）
  const evil = parseTarget("https://evil.other.test/admin");
  assert.equal(matchScopeRule("https://app.example.test/admin", evil), false);
  // pending 规则跨 host 不得误标（评审实测样本）
  const cross = parseTarget("https://app.example.test/api/echo");
  assert.equal(matchScopeRule("https://legacy.example.test/", cross), false);
  // allow 规则跨 host 不得放行（评审实测样本）
  assert.equal(matchScopeRule("https://payments.example.test/", parseTarget("https://anything.test/path")), false);
  // 同 host 同路径仍匹配（既有语义保持）
  assert.equal(matchScopeRule("https://app.example.test/admin", parseTarget("https://app.example.test/admin")), true);
  // 主机通配 *.base 不作用于 URL 条目（子域通配仅作用于裸主机/对象规则）
  assert.equal(matchScopeRule("https://*.example.test/admin", parseTarget("https://a.example.test/admin")), false);
  // 对象条目与裸主机条目的跨 host 语义不变
  assert.equal(matchScopeRule({ host: "app.example.test" }, parseTarget("https://evil.other.test/admin")), false);
  assert.equal(matchScopeRule("app.example.test", parseTarget("https://evil.other.test/admin")), false);
  // 端到端三态：跨 host deny 仍拒同 host、pending 不误标、allow 不放行
  const rules = {
    deny: ["https://app.example.test/admin"],
    pending: ["https://legacy.example.test/"],
    allow: ["https://payments.example.test/"],
  };
  assert.equal(matchScopeRule(rules.deny[0], parseTarget("https://app.example.test/admin/x")), true);
  assert.equal(matchScopeRule(rules.pending[0], parseTarget("https://legacy.example.test/")), true);
  assert.equal(matchScopeRule(rules.allow[0], parseTarget("https://payments.example.test/pay")), true);
});

test("P0-5：路径通配符按前缀通配（/v1/* 匹配 /v1、/v1/ 与 /v1/ 下任意路径）", () => {
  const rule = "https://api.example.test/v1/*";
  // 评审 §7a：修复前 * 是字面量，/v1/ 下任何路径都匹配不到
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v1/users")), true);
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v1/")), true);
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v1")), true);
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v1/users/42?x=1")), true);
  // 前缀边界：不吞相邻前缀
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v10/users")), false);
  assert.equal(matchScopeRule(rule, parseTarget("https://api.example.test/v2/users")), false);
  // 根通配：该主机任意路径
  assert.equal(matchScopeRule("https://api.example.test/*", parseTarget("https://api.example.test/anything/deep")), true);
  // 通配仍受 host/scheme/端口约束
  assert.equal(matchScopeRule(rule, parseTarget("https://other.example.test/v1/users")), false);
  assert.equal(matchScopeRule(rule, parseTarget("http://api.example.test/v1/users")), false);
  // 非通配路径的既有前缀语义不变（/v1 不吞 /v1x）
  assert.equal(matchScopeRule("https://api.example.test/v1", parseTarget("https://api.example.test/v1x")), false);
  assert.equal(matchScopeRule("https://api.example.test/v1", parseTarget("https://api.example.test/v1/x")), true);
});

/* ── 1. 未配置范围不得默认可操作（§17） ───────────────────────────── */

test("未配置范围：带目标的派发与工具动作均 SCOPE_UNRESOLVED（缺少目标范围不默认任意目标可操作）", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const asset = await createAsset(s.base, p.id, "unscoped.test");
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id, { target_asset_ids: [asset] });

    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(d.status, 422);
    assert.equal(d.body.code, "SCOPE_UNRESOLVED");
    assert.match(d.body.message, /范围未判定/);

    // 无目标意图可派发，但目标工具动作仍被拒
    const plain = await seedIntent(s.dataDir, p.id);
    const d2 = await dispatch(s.base, rt, { intent_id: plain, worker_id: "w1" });
    assert.equal(d2.status, 200, JSON.stringify(d2.body));
    const tool = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d2.body.attempt.id, fencing_token: d2.body.fencing_token, tool_name: "probe", args: { url: "https://unscoped.test/" } },
      session: w,
    });
    assert.equal(tool.status, 422);
    assert.equal(tool.body.code, "SCOPE_UNRESOLVED");
  }));

/* ── 2. 三区与拒绝优先（§17） ─────────────────────────────────────── */

test("范围三区：明确拒绝优先于允许；未列出与待判断均 SCOPE_UNRESOLVED；assets.scope_status 回写", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const ok = await createAsset(s.base, p.id, "ok.test");
    const bad = await createAsset(s.base, p.id, "admin.ok.test");
    const pend = await createAsset(s.base, p.id, "pend.ok.test");
    const unlisted = await createAsset(s.base, p.id, "unlisted.test");
    await setScope(s.base, p.id, {
      allow: ["ok.test", "*.ok.test"],
      deny: ["admin.ok.test"],
      pending: ["pend.ok.test"],
    });
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });

    // 拒绝优先：admin.ok.test 同时命中 allow(*.ok.test) 与 deny → SCOPE_DENIED
    const badIntent = await seedIntent(s.dataDir, p.id, { target_asset_ids: [bad] });
    const d1 = await dispatch(s.base, rt, { intent_id: badIntent, worker_id: "w1" });
    assert.equal(d1.status, 422);
    assert.equal(d1.body.code, "SCOPE_DENIED");

    // 待判断（显式 pending）→ SCOPE_UNRESOLVED
    const pendIntent = await seedIntent(s.dataDir, p.id, { target_asset_ids: [pend] });
    const d2 = await dispatch(s.base, rt, { intent_id: pendIntent, worker_id: "w1" });
    assert.equal(d2.status, 422);
    assert.equal(d2.body.code, "SCOPE_UNRESOLVED");
    assert.equal(d2.body.detail.reason, "explicit_pending");

    // 未列出 → SCOPE_UNRESOLVED
    const unIntent = await seedIntent(s.dataDir, p.id, { target_asset_ids: [unlisted] });
    const d3 = await dispatch(s.base, rt, { intent_id: unIntent, worker_id: "w1" });
    assert.equal(d3.status, 422);
    assert.equal(d3.body.code, "SCOPE_UNRESOLVED");
    assert.equal(d3.body.detail.reason, "unlisted");

    // 允许目标可派发，且 assets.scope_status 按判定回写
    const okIntent = await seedIntent(s.dataDir, p.id, { target_asset_ids: [ok] });
    const d4 = await dispatch(s.base, rt, { intent_id: okIntent, worker_id: "w1" });
    assert.equal(d4.status, 200, JSON.stringify(d4.body));
    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT scope_status FROM assets WHERE id = ?").get(ok).scope_status, "allowed");
    assert.equal(db.prepare("SELECT scope_status FROM assets WHERE id = ?").get(bad).scope_status, "denied");
    assert.equal(db.prepare("SELECT scope_status FROM assets WHERE id = ?").get(pend).scope_status, "pending");
  }));

/* ── 3. §20.3 场景 20：用户停止或范围收缩 ────────────────────────── */

test("场景 20：范围收缩与用户停止——后续工具动作被程序阻止，历史记录保留，已发出操作记录实际结果", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, { allow: ["target.test"], deny: [], pending: [] }, "v1 允许 target.test");
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(d.status, 200, JSON.stringify(d.body.body ?? d.body));

    // 收缩前：对 target.test 的动作放行（登记+启动）
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "http_probe", args: { url: "https://target.test/x" } },
      session: w,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const startOk = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.body.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.body.fencing_token, targets: ["https://target.test/x"] },
      session: w,
    });
    assert.equal(startOk.status, 200, JSON.stringify(startOk.body));
    assert.equal(startOk.body.gate.targets_recheck, "redeclared");

    // ── 范围收缩（真实新版本经 A1 端点落库）：立即影响新动作 ──
    await setScope(s.base, p.id, { allow: ["api.target.test"], deny: ["target.test"] }, "v2 收缩：拒绝 target.test");

    const shrunk = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "http_probe", args: { url: "https://target.test/y" } },
      session: w,
    });
    assert.equal(shrunk.status, 422);
    assert.equal(shrunk.body.code, "SCOPE_DENIED");
    assert.match(shrunk.body.message, /明确拒绝/);

    // 收缩后登记的另一调用（start 时再次逐跳校验，范围版本为 v2）→ start 被拒
    const reg2 = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "http_probe", args: { url: "https://target.test/z" } },
      session: w,
    });
    assert.equal(reg2.status, 422, "登记阶段即被拒（登记与动作前都校验，§17）");
    assert.equal(reg2.body.code, "SCOPE_DENIED");

    // 仍允许范围内的目标可继续
    const regOk = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "http_probe", args: { url: "https://api.target.test/z" } },
      session: w,
    });
    assert.equal(regOk.status, 200, JSON.stringify(regOk.body));

    // 已发出操作不假装撤回：收缩前启动的调用照常落定，附 touched_targets 事后判定与警告
    const done = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.body.attempt.id, tool_call_id: reg.body.tool_call.id, outcome: "succeeded", touched_targets: ["https://target.test/x"] },
      session: w,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.tool_call.status, "succeeded");
    assert.equal(done.body.touched_targets[0].verdict, "denied");
    assert.ok(done.body.warnings.some((x) => x.includes("target.test")), "事后判定未产生警告");
    const db0 = await rows(s.dataDir);
    const viol = db0.prepare(`SELECT * FROM outbox WHERE payload LIKE '%scope_violation_observed%'`).get();
    assert.ok(viol, "缺少 scope_violation_observed 事件");

    // ── 用户停止（真实端点）：立即生效 ──
    const stop = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));

    const after = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "http_probe", args: { url: "https://api.target.test/w" } },
      session: w,
    });
    assert.equal(after.status, 422);
    assert.equal(after.body.code, "PRECONDITION_INVALID");
    assert.match(after.body.message, /停止/);

    const newIntent = await seedIntent(s.dataDir, p.id);
    const nd = await dispatch(s.base, rt, { intent_id: newIntent, worker_id: "w2" });
    assert.equal(nd.status, 422);
    assert.equal(nd.body.code, "PRECONDITION_INVALID");

    // 历史记录保留：范围版本、Attempt、工具调用与事件全部在库
    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scope_revisions WHERE project_id = ?").get(p.id).c, 2); // v1+v2（项目创建未带初始范围）
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE id = ?").get(d.body.attempt.id).c, 1);
    assert.ok(db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE attempt_id = ?").get(d.body.attempt.id).c >= 2);
    assert.ok(db.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?`).get(p.id).c >= 2);
  }));

/* ── 4. 逐跳校验（§17 重定向/新目标） ────────────────────────────── */

test("逐跳校验：多目标动作任一拒绝即整体拒绝；重定向目标作为新调用过闸（不能只检查最初 URL）", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, { allow: ["hop.test"], deny: ["evil.test"], pending: [] });
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(d.status, 200, JSON.stringify(d.body));

    // 多目标（含工具将内部展开的重定向目标）：任一 deny → 整个动作拒绝
    const multi = await call(s.base, "POST", "/sorne/tool-calls", {
      body: {
        action: "register",
        attempt_id: d.body.attempt.id,
        fencing_token: d.body.fencing_token,
        tool_name: "crawler",
        args: { urls: ["https://hop.test/a", "https://evil.test/redirect-target"] },
      },
      session: w,
    });
    assert.equal(multi.status, 422);
    assert.equal(multi.body.code, "SCOPE_DENIED");
    assert.equal(multi.body.detail.target, "https://evil.test/redirect-target");

    // 首跳放行；重定向到拒绝目标后，对新目标的新调用被拒（逐跳）
    const first = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "crawler", args: { url: "https://hop.test/a" } },
      session: w,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const follow = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "crawler", args: { url: "https://evil.test/redirect-target" } },
      session: w,
    });
    assert.equal(follow.status, 422);
    assert.equal(follow.body.code, "SCOPE_DENIED");
  }));

/* ── 5. register 与 start 之间的收缩在 start 被拦（范围变化立即影响新动作） ── */

test("登记与启动之间的范围收缩：start 的逐跳复检拒绝（新动作），登记目标集重申契约生效", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, { allow: ["shrink.test"], deny: [], pending: [] });
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "t", args: { url: "https://shrink.test/a" } },
      session: w,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    await setScope(s.base, p.id, { allow: [], deny: ["shrink.test"], pending: [] }, "v2 收缩");
    const start = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.body.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.body.fencing_token, targets: reg.body.declared_targets },
      session: w,
    });
    assert.equal(start.status, 422);
    assert.equal(start.body.code, "SCOPE_DENIED");
    // 未重申目标时不做目标复检（契约说明），但 planned 调用可正常取消
    const start2 = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.body.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.body.fencing_token },
      session: w,
    });
    assert.equal(start2.status, 200, JSON.stringify(start2.body));
    assert.equal(start2.body.gate.targets_recheck, "not_redeclared");
  }));

/* ── 6. 自报来源不能绕过授权（§17） ──────────────────────────────── */

test("自报 source_type=official 不能绕过授权：拒绝目标仍拒绝；范围条目对象的自报字段不参与判定", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, { allow: [], deny: ["claim.test"], pending: [] });
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const tool = await call(s.base, "POST", "/sorne/tool-calls", {
      body: {
        action: "register",
        attempt_id: d.body.attempt.id,
        fencing_token: d.body.fencing_token,
        tool_name: "fetch",
        args: { url: "https://claim.test/x", source_type: "official", authorized_by: "model" },
      },
      session: w,
    });
    assert.equal(tool.status, 422);
    assert.equal(tool.body.code, "SCOPE_DENIED");
  }));

/* ── 7. requires_state=scope_status 谓词与范围联动（§9.2/§17） ────── */

test("requires_state=scope_status 谓词：范围收缩使前提失效 → 派发被 PRECONDITION_INVALID 阻止", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, { allow: ["pre.test"], deny: [], pending: [] });
    const asset = await createAsset(s.base, p.id, "pre.test");
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "seed-worker", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const rel = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "sc-pre-req-1",
        operations: [{ op: "add_relation", from: intent, type: "requires", to: asset, requires_state: "scope_status=allowed" }],
      },
      session: w,
    });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));

    const d1 = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(d1.status, 200, JSON.stringify(d1.body));

    // 收缩：pre.test 被拒 → 谓词失效 → 新派发被阻止（程序立即关闭执行门槛，§9.2）
    await setScope(s.base, p.id, { allow: [], deny: ["pre.test"], pending: [] }, "收缩");
    const d2 = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w2", assignment_id: "ASM-AFTER-SHRINK" });
    assert.equal(d2.status, 422);
    assert.equal(d2.body.code, "PRECONDITION_INVALID");
    assert.match(d2.body.message, /scope_status=allowed/);
  }));

/* ── 8. URL 形态条目的端口/路径约束在网关面生效 ──────────────────── */

test("URL 形态条目：scheme/端口/路径前缀约束在工具网关逐目标生效", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    await setScope(s.base, p.id, {
      allow: ["https://svc.test:8443/api"],
      deny: [],
      pending: [],
    });
    const rt = issueSession({ project_id: p.id, actor: "rt", role: "runtime" });
    const w = issueSession({ project_id: p.id, actor: "w1", role: "worker" });
    const intent = await seedIntent(s.dataDir, p.id);
    const d = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const tryUrl = async (url) =>
      call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "register", attempt_id: d.body.attempt.id, fencing_token: d.body.fencing_token, tool_name: "t", args: { url } },
        session: w,
      });
    // 命中：scheme+端口+路径前缀
    assert.equal((await tryUrl("https://svc.test:8443/api/v1")).status, 200);
    // 端口不符（默认 443）→ 待判断
    const wrongPort = await tryUrl("https://svc.test/api/v1");
    assert.equal(wrongPort.status, 422);
    assert.equal(wrongPort.body.code, "SCOPE_UNRESOLVED");
    // 路径越界 → 待判断
    const wrongPath = await tryUrl("https://svc.test:8443/other");
    assert.equal(wrongPath.status, 422);
    assert.equal(wrongPath.body.code, "SCOPE_UNRESOLVED");
    // scheme 不符 → 待判断
    const wrongScheme = await tryUrl("http://svc.test:8443/api");
    assert.equal(wrongScheme.status, 422);
    assert.equal(wrongScheme.body.code, "SCOPE_UNRESOLVED");
  }));
