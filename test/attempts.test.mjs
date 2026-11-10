/**
 * C2 —— 执行运行时与工具网关测试（规范 §10.2 §17 §3.2；蓝图 §7 场景 17/18 主责）。
 *
 * 覆盖蓝图 §7 中 C2 主责场景：
 *   - #17 worker 租约过期后回报 → 可保存合法证据，不能抢改新 Attempt 状态，
 *     不再获工具执行权限；
 *   - #18 工具执行中崩溃 → 记录 unknown，检查后再重试。
 * 以及条件领取/心跳/fencing/生命周期/完成建议/子 agent 统一登记/前提与资源
 * 上限/事务原子性（真实 SQLite TRIGGER RAISE 注入）/真实重启恢复。
 *
 * 真实注入（§20.3 末段）：租约过期经真实库行（lease_expires_at 写为过去）与
 * 真实短 TTL 等待注入；重启经真实「关库关服→同目录重启→重签会话」；事务
 * 原子性经真实 SQLite TRIGGER RAISE(ABORT) 注入；不使用 mock 替代事务与恢复。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer），
 * 不留后台进程、不触碰 ~/.sorne。
 *
 * 注：intents 属同阶段 C1 端点域，本文件按 B1 先例以真实库行事种入（seedIntent），
 * 不 import C1 模块；资产/关系经 A1 真实端点建立。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { issueSession, revokeSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有工具（helpers.request 不支持会话头，helpers 为冻结文件） ── */

async function call(base, method, path, { body, session, rawBody } = {}) {
  const headers = { origin: base };
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-sorne-session"] = session.session_token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
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

/** 重启演练服务器：显式 dataDir，close() 只关服不删目录（模拟进程退出再拉起）。 */
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

/** 一次性服务器（带目录清理与句柄关闭）。 */
async function withServer(fn) {
  const dataDir = makeTempDir("sorne-c2-att-");
  const s = await bootServer(dataDir);
  try {
    return await fn({ ...s, dataDir });
  } finally {
    await s.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function createProject(base, name = "C2 执行运行时测试") {
  const res = await call(base, "POST", "/sorne/projects", { body: { name } });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function runtimeSession(projectId, actor = "runtime-1") {
  return issueSession({ project_id: projectId, actor, role: "runtime" });
}
function workerSession(projectId, actor = "w1") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}

/** 真实库行事种入意图（intents 端点属同阶段 C1；B1 先例）。 */
async function seedIntent(dataDir, projectId, overrides = {}) {
  const store = await getStore({ dataDir });
  return store.runSerial((db) => {
    const id = overrides.id ?? `I-${7000 + Math.floor(Math.random() * 2999)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO intents (id, project_id, goal_id, question, rationale, kind, target_asset_ids,
         basis_refs, prerequisite_refs, scope_revision, condition_requirements, success_criteria,
         deliverables, priority, budget, resume_conditions, status, state_version, plan_revision,
         created_at, created_by, created_seq, updated_seq)
       VALUES (?, ?, NULL, ?, '', ?, ?, '[]', ?, NULL, '[]', '', '[]', 5, ?, '[]', ?, 1, NULL, ?, 'seed', 1, 0)`,
    ).run(
      id,
      projectId,
      overrides.question ?? "确认登录相关入口",
      overrides.kind ?? "investigate",
      JSON.stringify(overrides.target_asset_ids ?? []),
      JSON.stringify(overrides.prerequisite_refs ?? []),
      JSON.stringify(overrides.budget ?? {}),
      overrides.status ?? "queued",
      now,
    );
    return id;
  });
}

async function dispatch(base, session, body) {
  return call(base, "POST", "/sorne/attempts", { body, session });
}

async function mustDispatch(base, session, body) {
  const res = await dispatch(base, session, body);
  assert.equal(res.status, 200, `派发失败：${JSON.stringify(res.body)}`);
  return res.body;
}

/** 经 A1 真实提交建立资产，返回正式编号。 */
async function createAsset(base, projectId, canonicalKey, assetType = "domain") {
  const w = workerSession(projectId, "seed-worker");
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: `seed-asset-${canonicalKey}-${Math.floor(Math.random() * 1e9)}`,
      operations: [
        {
          op: "register_asset",
          local_ref: "a",
          asset_type: assetType,
          canonicalization_version: "v1",
          canonical_key: canonicalKey,
        },
      ],
    },
    session: w,
  });
  assert.equal(res.status, 200, `资产建立失败：${JSON.stringify(res.body)}`);
  return res.body.ids.a;
}

/** 租约过期注入：真实库行把 lease_expires_at 写为过去（模拟时间流逝）。 */
async function expireLease(dataDir, attemptId) {
  const store = await getStore({ dataDir });
  await store.runSerial((db) => {
    db.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      attemptId,
    );
  });
}

async function rows(dataDir) {
  const store = await getStore({ dataDir });
  return store.db;
}

/* ── 1. 派发与条件领取 ────────────────────────────────────────────── */

test("派发与条件领取：幂等重发返回原 Attempt；部分唯一索引阻止同分配第二有效租约；fencing token 单调递增", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);

    const d1 = await mustDispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-DISPATCH-1",
      worker_id: "w1",
    });
    assert.match(d1.attempt.id, /^ATT-\d+$/);
    assert.equal(d1.attempt.status, "leased");
    assert.equal(d1.idempotent, false);
    assert.equal(typeof d1.fencing_token, "number");
    assert.ok(d1.attempt.lease.seconds_remaining > 0);

    // 完全相同的分配重发 → 幂等返回原 Attempt（§16.2）
    const again = await mustDispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-DISPATCH-1",
      worker_id: "w1",
    });
    assert.equal(again.idempotent, true);
    assert.equal(again.attempt.id, d1.attempt.id);

    // 同分配不同内容 → IDEMPOTENCY_KEY_REUSED，不覆盖
    const clash = await dispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-DISPATCH-1",
      worker_id: "w2",
    });
    assert.equal(clash.status, 422);
    assert.equal(clash.body.code, "IDEMPOTENCY_KEY_REUSED");

    // 暂缓释放租约后可再派发；恢复时撞部分唯一索引（另一有效租约在位）
    await call(s.base, "POST", `/sorne/attempts/${d1.attempt.id}/lifecycle`, {
      body: { action: "suspend", reason: "等待账户条件" },
      session: rt,
    });
    const d2 = await mustDispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-DISPATCH-1",
      worker_id: "w1",
    });
    assert.equal(d2.attempt.id !== d1.attempt.id, true);
    assert.ok(d2.fencing_token > d1.fencing_token, "fencing token 必须单调递增（§10.2）");

    const resumeClash = await call(s.base, "POST", `/sorne/attempts/${d1.attempt.id}/lifecycle`, {
      body: { action: "resume" },
      session: rt,
    });
    assert.equal(resumeClash.status, 422);
    assert.equal(resumeClash.body.code, "PRECONDITION_INVALID");
    assert.match(resumeClash.body.message, /部分唯一索引/);

    // 暂缓在位租约后恢复成功（索引不再冲突）
    await call(s.base, "POST", `/sorne/attempts/${d2.attempt.id}/lifecycle`, {
      body: { action: "suspend", reason: "让位恢复旧执行" },
      session: rt,
    });
    const resumed = await call(s.base, "POST", `/sorne/attempts/${d1.attempt.id}/lifecycle`, {
      body: { action: "resume", lease_ttl_ms: 60000 },
      session: rt,
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.attempt.status, "leased");

    // 越权：worker 不得派发（蓝图 §8.2 runtime 专属）
    const byWorker = await dispatch(s.base, workerSession(p.id), {
      intent_id: intent,
      worker_id: "w1",
    });
    assert.equal(byWorker.status, 403);
    assert.equal(byWorker.body.code, "TRUST_DENIED");

    // 引用不存在的意图 → INVALID_REFERENCE
    const bad = await dispatch(s.base, rt, { intent_id: "I-9999", worker_id: "w1" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "INVALID_REFERENCE");
  }));

/* ── 2. 心跳续租与过期阻止（§10.2） ──────────────────────────────── */

test("心跳续租延长租约；过期后 LEASE_EXPIRED、Attempt 转 interrupted、通知 Orchestrator 事件同事务落库", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const d = await mustDispatch(s.base, rt, {
      intent_id: intent,
      worker_id: "w1",
      lease_ttl_ms: 60000,
    });

    // 真实短租约等待：TTL 最小 1s，等待 1.05s 后过期
    const short = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w2", assignment_id: "ASM-SHORT", lease_ttl_ms: 1000 });
    await new Promise((r) => setTimeout(r, 1050));
    const lateBeat = await call(s.base, "POST", `/sorne/attempts/${short.attempt.id}/lifecycle`, {
      body: { action: "heartbeat", fencing_token: short.fencing_token },
      session: rt,
    });
    assert.equal(lateBeat.status, 422);
    assert.equal(lateBeat.body.code, "LEASE_EXPIRED");

    // 心跳续租（未过期的首个 Attempt）
    const beat = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/lifecycle`, {
      body: { action: "heartbeat", fencing_token: d.fencing_token, lease_ttl_ms: 600000 },
      session: rt,
    });
    assert.equal(beat.status, 200, JSON.stringify(beat.body));
    assert.ok(Date.parse(beat.body.renewed_until) > Date.parse(d.lease_expires_at));

    // 过期注入 + 心跳失败后：Attempt interrupted + 通知事件
    await expireLease(s.dataDir, d.attempt.id);
    const expiredBeat = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/lifecycle`, {
      body: { action: "heartbeat", fencing_token: d.fencing_token },
      session: rt,
    });
    assert.equal(expiredBeat.status, 422);
    assert.equal(expiredBeat.body.code, "LEASE_EXPIRED");

    const db = await rows(s.dataDir);
    const att = db.prepare("SELECT * FROM attempts WHERE id = ?").get(d.attempt.id);
    assert.equal(att.status, "interrupted");
    const ev = db
      .prepare(
        `SELECT * FROM outbox WHERE project_id = ? AND event_type = 'resource_state.changed'
           AND payload LIKE '%lease_expired%' ORDER BY commit_seq DESC`,
      )
      .get(p.id);
    assert.ok(ev, "缺少 lease_expired 通知事件（§10.2 通知 Orchestrator）");
    const payload = JSON.parse(ev.payload);
    assert.equal(payload.attempt_id, d.attempt.id);
    assert.equal(payload.decision_needed_by, "orchestrator");
    assert.match(payload.reason, /lease_expired/);
  }));

/* ── 3. §20.3 场景 17：worker 租约过期后回报 ─────────────────────── */

test("场景 17：租约过期后回报——合法证据留档（A1 提交面）、不改新 Attempt 状态、不再获工具权限", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-SC17",
      worker_id: "w1",
    });

    // 旧执行者的工具调用先行登记：项目未配置范围 → SCOPE_UNRESOLVED（缺范围不默认可操作，§17）
    const noScope = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/x" } },
      session: w,
    });
    assert.equal(noScope.status, 422);
    assert.equal(noScope.body.code, "SCOPE_UNRESOLVED");
    // 配置范围后重试
    const scope = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["a.test"], deny: [], pending: [] } },
    });
    assert.equal(scope.status, 200, JSON.stringify(scope.body));
    const reg2 = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/x" } },
      session: w,
    });
    assert.equal(reg2.status, 200, JSON.stringify(reg2.body));
    const started = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg2.body.tool_call.id, fencing_token: d.fencing_token, targets: ["https://a.test/x"] },
      session: w,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // 租约过期 + 重派（新 Attempt 接管）
    await expireLease(s.dataDir, d.attempt.id);
    const d2 = await mustDispatch(s.base, rt, {
      intent_id: intent,
      assignment_id: "ASM-SC17",
      worker_id: "w2",
    });
    assert.ok(d2.fencing_token > d.fencing_token);
    const att1 = (await rows(s.dataDir)).prepare("SELECT * FROM attempts WHERE id = ?").get(d.attempt.id);
    assert.equal(att1.status, "interrupted", "旧 Attempt 应已被清扫为 interrupted");

    // (a) 迟到的合法证据提交仍可保存（A1 /submissions 配合面：留档）
    const lateSubmit = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SC17-LATE-1",
        attempt_id: d.attempt.id,
        operations: [{ op: "append_observation", local_ref: "o", statement: "迟到观察：响应 500" }],
      },
      session: w,
    });
    assert.equal(lateSubmit.status, 200, JSON.stringify(lateSubmit.body));

    // (b) 迟到完成建议留档，不改变任何 Attempt 状态（新 Attempt 仍 leased）
    const lateDone = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "completion", note: "迟到完成建议" },
      session: w,
    });
    assert.equal(lateDone.status, 200, JSON.stringify(lateDone.body));
    assert.equal(lateDone.body.late, true);
    assert.equal(lateDone.body.attempt_status_after, "interrupted");
    assert.match(lateDone.body.note, /留档/);
    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT status FROM attempts WHERE id = ?").get(d2.attempt.id).status, "leased");
    const wr = db.prepare("SELECT * FROM worker_reports WHERE id = ?").get(lateDone.body.report_id);
    assert.ok(wr, "迟到汇报应留档到 worker_reports");
    assert.equal(JSON.parse(wr.content).late, true);

    // (c) 不再获工具权限：旧 token 登记与心跳均 LEASE_EXPIRED（含指向新 Attempt 的 fencing 拦截）
    const toolLate = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/y" } },
      session: w,
    });
    assert.equal(toolLate.status, 422);
    assert.equal(toolLate.body.code, "LEASE_EXPIRED");
    // fencing 拦截：新执行者持旧 token 指向新 Attempt → LEASE_EXPIRED（token 不匹配）
    const w2sess = workerSession(p.id, "w2");
    const hijack = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d2.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/y" } },
      session: w2sess,
    });
    assert.equal(hijack.status, 422);
    assert.equal(hijack.body.code, "LEASE_EXPIRED");
    assert.match(hijack.body.message, /fencing token 不匹配/);
    // 旧执行者（w1）也不得触碰新 Attempt（归属校验，蓝图 §8.2）
    const touchNew = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d2.attempt.id, fencing_token: d2.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/y" } },
      session: w,
    });
    assert.equal(touchNew.status, 403);
    assert.equal(touchNew.body.code, "TRUST_DENIED");

    // (d) 新执行者正常获得工具权限
    const w2 = workerSession(p.id, "w2");
    const okReg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d2.attempt.id, fencing_token: d2.fencing_token, tool_name: "http_probe", args: { url: "https://a.test/y" } },
      session: w2,
    });
    assert.equal(okReg.status, 200, JSON.stringify(okReg.body));

    // 历史保留：旧 Attempt 与其调用仍在库
    const list = await call(s.base, "GET", "/sorne/attempts", { session: rt });
    assert.equal(list.status, 200);
    assert.equal(list.body.attempts.length, 2);
  }));

/* ── 4. §20.3 场景 18：工具执行中崩溃 → unknown 先查再试 ─────────── */

test("场景 18：中断标 unknown；同身份重试被拒（PRECONDITION_INVALID）；resolve 需 check_note；resolve 后重试成功", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["b.test"], deny: [], pending: [] } },
    });
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const args = { url: "https://b.test/api" };

    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args },
      session: w,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const tc = reg.body.tool_call.id;
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: tc, fencing_token: d.fencing_token, targets: [args.url] },
      session: w,
    });

    // 进程中断，无法判断外部操作是否已完成 → unknown
    const unk = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "mark_unknown", attempt_id: d.attempt.id, tool_call_id: tc, reason: "进程崩溃，响应未收到" },
      session: w,
    });
    assert.equal(unk.status, 200, JSON.stringify(unk.body));
    assert.equal(unk.body.tool_call.status, "unknown");

    // 同身份重试被拒：先检查现状再决定重试（§10.2）
    const dup = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args },
      session: w,
    });
    assert.equal(dup.status, 422);
    assert.equal(dup.body.code, "PRECONDITION_INVALID");
    assert.match(dup.body.message, /unknown/);
    assert.match(dup.body.next_requirements[0], /resolve/);

    // resolve 缺 check_note → BAD_REQUEST
    const noNote = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "resolve", attempt_id: d.attempt.id, tool_call_id: tc, outcome: "succeeded" },
      session: w,
    });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.body.code, "BAD_REQUEST");

    // 核查现状（先查）后 resolve
    const resolved = await call(s.base, "POST", "/sorne/tool-calls", {
      body: {
        action: "resolve",
        attempt_id: d.attempt.id,
        tool_call_id: tc,
        outcome: "succeeded",
        check_note: "重放幂等查询确认接口未产生副作用，原操作已成功返回",
      },
      session: w,
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.tool_call.status, "succeeded");

    // resolve 后同身份重试放行（新 TC 编号，不视作恰好一次）
    const retry = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "http_probe", args },
      session: w,
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.notEqual(retry.body.tool_call.id, tc);
  }));

test("场景 18（重启注入）：真实关库关服重启后，过期租约的在途调用被标 unknown，逐项恢复后可继续", async () => {
  const dataDir = makeTempDir("sorne-c2-restart-");
  let srv = await bootServer(dataDir);
  const sessions = [];
  try {
    const p = await createProject(srv.base);
    const intent = await seedIntent(dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    sessions.push(rt, w);
    await call(srv.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["c.test"], deny: [], pending: [] } },
    });
    const d = await mustDispatch(srv.base, rt, { intent_id: intent, worker_id: "w1" });
    const reg = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "crawl", args: { url: "https://c.test/" } },
      session: w,
    });
    const reg2 = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "crawl2", args: { url: "https://c.test/2" } },
      session: w,
    });
    await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.fencing_token, targets: ["https://c.test/"] },
      session: w,
    });

    // 「进程崩溃」：租约到期写为过去（真实库行），随后整个进程关库关服
    await expireLease(dataDir, d.attempt.id);
    for (const sess of sessions) revokeSession(sess.session_token);
    await srv.close();
    await closeStore({ dataDir });

    // 同目录重启 + 重签会话
    srv = await bootServer(dataDir);
    const rt2 = runtimeSession(p.id);
    const w2 = workerSession(p.id, "w1");
    const list = await call(srv.base, "GET", "/sorne/attempts", { session: rt2 });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const swept = list.body.attempts.find((a) => a.id === d.attempt.id);
    assert.equal(swept.status, "interrupted", "重启后过期租约被标记为中断（§18.2 步骤 3）");
    assert.equal(swept.tool_calls.by_status.unknown, 1, "在途调用被标 unknown（§18.2 步骤 4：无法确定结果）");
    assert.equal(swept.tool_calls.by_status.cancelled, 1, "未启动调用被取消");
    assert.equal(swept.tool_calls.unknown[0].id, reg.body.tool_call.id);

    // 通知事件在重启后仍可追溯（Outbox 持久 + 同事务）
    const db = await rows(dataDir);
    const ev = db
      .prepare(`SELECT * FROM outbox WHERE project_id = ? AND payload LIKE '%lease_expired%'`)
      .get(p.id);
    assert.ok(ev, "重启后 lease_expired 通知事件仍在 Outbox");

    // 逐项恢复：核查后 resolve unknown（记录实际结果），再派发新执行
    const resolved = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: {
        action: "resolve",
        attempt_id: d.attempt.id,
        tool_call_id: reg.body.tool_call.id,
        outcome: "failed",
        check_note: "重启后核查：目标返回 503，原操作未成功",
      },
      session: w2,
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const d2 = await mustDispatch(srv.base, rt2, {
      intent_id: intent,
      assignment_id: `RE-${d.assignment_id}`,
      worker_id: "w1",
    });
    assert.ok(d2.fencing_token > d.fencing_token);
    const again = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d2.attempt.id, fencing_token: d2.fencing_token, tool_name: "crawl", args: { url: "https://c.test/" } },
      session: w2,
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  } finally {
    await srv.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 5. complete 落定、证据引用与幂等 ─────────────────────────────── */

test("complete 记录实际结果与证据引用；坏引用 INVALID_REFERENCE；重复落定幂等返回原终态", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["d.test"], deny: [], pending: [] } },
    });
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const start = async (tool) => {
      const reg = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: tool, args: { url: `https://d.test/${tool}` } },
        session: w,
      });
      assert.equal(reg.status, 200, JSON.stringify(reg.body));
      const st = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.fencing_token, targets: [`https://d.test/${tool}`] },
        session: w,
      });
      assert.equal(st.status, 200, JSON.stringify(st.body));
      return reg.body.tool_call.id;
    };
    const tc1 = await start("fetch1");
    const tc2 = await start("fetch2");

    // 坏证据引用
    const bad = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: tc1, outcome: "succeeded", evidence_refs: ["O-9999"] },
      session: w,
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "INVALID_REFERENCE");

    // 真实观察编号作为证据引用（经 A1 提交建立）
    const obs = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SC-C2-EV-1",
        attempt_id: d.attempt.id,
        operations: [{ op: "append_observation", local_ref: "o", statement: "200 OK" }],
      },
      session: w,
    });
    assert.equal(obs.status, 200);
    const obsId = obs.body.ids.o;

    const done = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: tc1, outcome: "succeeded", evidence_refs: [obsId], touched_targets: ["https://d.test/fetch1"] },
      session: w,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.tool_call.status, "succeeded");
    assert.deepEqual(done.body.tool_call.evidence_refs, [obsId]);
    assert.equal(done.body.touched_targets[0].verdict, "allowed");

    // 传输重试同落定 → 幂等返回原终态
    const again = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: tc1, outcome: "succeeded", evidence_refs: [obsId] },
      session: w,
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);

    // 改判被拒
    const flip = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: tc1, outcome: "failed" },
      session: w,
    });
    assert.equal(flip.status, 422);
    assert.equal(flip.body.code, "PRECONDITION_INVALID");

    // failed 落定带错误文本
    const fail = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: tc2, outcome: "failed", error: "ETIMEDOUT" },
      session: w,
    });
    assert.equal(fail.status, 200);
    assert.equal(fail.body.tool_call.status, "failed");
    assert.equal(fail.body.tool_call.error, "ETIMEDOUT");
  }));

/* ── 6. 完成建议与工具调用终态约束 ───────────────────────────────── */

test("完成建议：存在未终态调用时拒绝；全部终态后接受（Attempt completed）；意图不被自动关闭", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "local_analysis", args: {} },
      session: w,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));

    const early = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "completion", note: "完成" },
      session: w,
    });
    assert.equal(early.status, 422);
    assert.equal(early.body.code, "PRECONDITION_INVALID");
    assert.match(early.body.message, /未终态/);

    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "cancel", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, reason: "不再需要" },
      session: w,
    });
    const done = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "completion", note: "两个调用入口已确认", condition_gaps: ["登录后页面未覆盖"] },
      session: w,
      fencing_token: undefined,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.late, false);
    assert.equal(done.body.attempt_status_after, "completed");

    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intent).status, "queued", "完成建议不自动改意图状态（C1/AI 语义域）");
    const ev = db.prepare(`SELECT * FROM outbox WHERE project_id = ? AND payload LIKE '%attempt_completed%'`).get(p.id);
    assert.ok(ev, "缺少 attempt_completed 事件");
  }));

/* ── 7. 暂缓/恢复/取消与历史保留 ──────────────────────────────────── */

test("取消把 running→unknown、planned→cancelled 并保存原因；全部历史行保留不删除", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const mk = async (tool) => {
      const reg = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: tool, args: {} },
        session: w,
      });
      return reg.body.tool_call.id;
    };
    const tcRun = await mk("t-running");
    const tcPlan = await mk("t-planned");
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: tcRun, fencing_token: d.fencing_token },
      session: w,
    });

    const db = await rows(s.dataDir);
    db.prepare("UPDATE intents SET status = 'running' WHERE id = ?").run(intent);
    const cancelled = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/lifecycle`, {
      body: { action: "cancel", reason: " Orchestrator 决定换方法 ".trim() },
      session: rt,
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.attempt.status, "cancelled");
    assert.equal(cancelled.body.attempt.tool_calls.by_status.unknown, 1);
    assert.equal(cancelled.body.attempt.tool_calls.by_status.cancelled, 1);

    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intent).status, "queued");
    const ids = db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE id = ?").get(d.attempt.id).c;
    assert.equal(ids, 1, "历史行保留（§16.4/§20.3 场景 20：历史记录保留）");
    const tcs = db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE attempt_id = ?").get(d.attempt.id).c;
    assert.equal(tcs, 2, "工具调用历史保留");
    const note = db.prepare("SELECT recovery_note FROM attempts WHERE id = ?").get(d.attempt.id).recovery_note;
    assert.equal(JSON.parse(note).reason, "Orchestrator 决定换方法");
  }));

/* ── 8. 子 agent 统一登记与统一并发限制（§10.2） ──────────────────── */

test("子 agent 统一登记：同一 Attempt、统一并发上限（RESOURCE_LIMIT）、继承租约闸门", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    // 统一并发上限显式设为 2（resource_policy 覆盖默认 8）
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      db.prepare("UPDATE projects SET resource_policy = ? WHERE id = ?").run(
        JSON.stringify({ max_running_tool_calls_per_attempt: 2 }),
        p.id,
      );
    });
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });

    // 子 agent 登记为所属 Attempt 的调用（created_by=agent 身份）
    const spawn = async (agent, tool) => {
      const res = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: tool, args: {}, agent },
        session: w,
      });
      return res;
    };
    const r1 = await spawn("sub-agent-1", "sub_agent.spawn");
    const r2 = await spawn("sub-agent-2", "sub_agent.spawn");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200);
    assert.equal(r1.body.tool_call.agent, "sub-agent-1");
    for (const r of [r1, r2]) {
      const st = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "start", attempt_id: d.attempt.id, tool_call_id: r.body.tool_call.id, fencing_token: d.fencing_token },
        session: w,
      });
      assert.equal(st.status, 200, JSON.stringify(st.body));
    }

    // 统一并发限制：第三个子 agent 调用被 RESOURCE_LIMIT 拒绝（含子 agent，不分身份）
    const r3 = await spawn("sub-agent-3", "sub_agent.spawn");
    assert.equal(r3.status, 422);
    assert.equal(r3.body.code, "RESOURCE_LIMIT");
    assert.equal(r3.body.retryable, true);
    assert.match(r3.body.message, /统一并发/);

    // 继承租约闸门：租约过期后子 agent 的新调用同样 LEASE_EXPIRED
    await expireLease(s.dataDir, d.attempt.id);
    const late = await spawn("sub-agent-2", "sub_agent.spawn");
    assert.equal(late.status, 422);
    assert.equal(late.body.code, "LEASE_EXPIRED");
  }));

/* ── 9. 预算继承（intents.budget.max_tool_calls） ─────────────────── */

test("预算继承：intent.budget.max_tool_calls 耗尽后拒绝新调用（RESOURCE_LIMIT，不可重试）", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id, { budget: { max_tool_calls: 2 } });
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    for (let i = 0; i < 2; i++) {
      const reg = await call(s.base, "POST", "/sorne/tool-calls", {
        body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: `t${i}`, args: {} },
        session: w,
      });
      assert.equal(reg.status, 200, JSON.stringify(reg.body));
    }
    const third = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t3", args: {}, agent: "sub-agent-1" },
      session: w,
    });
    assert.equal(third.status, 422);
    assert.equal(third.body.code, "RESOURCE_LIMIT");
    assert.equal(third.body.retryable, false);
    assert.match(third.body.message, /预算/);
  }));

/* ── 10. 项目级资源上限（max_active_attempts） ───────────────────── */

test("项目资源上限：max_active_attempts=1 时第二个不同分配的派发被拒（RESOURCE_LIMIT，可重试）", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const i1 = await seedIntent(s.dataDir, p.id);
    const i2 = await seedIntent(s.dataDir, p.id);
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      db.prepare("UPDATE projects SET resource_policy = ? WHERE id = ?").run(
        JSON.stringify({ max_active_attempts: 1 }),
        p.id,
      );
    });
    const rt = runtimeSession(p.id);
    await mustDispatch(s.base, rt, { intent_id: i1, worker_id: "w1", assignment_id: "ASM-A" });
    const second = await dispatch(s.base, rt, { intent_id: i2, worker_id: "w2", assignment_id: "ASM-B" });
    assert.equal(second.status, 422);
    assert.equal(second.body.code, "RESOURCE_LIMIT");
    assert.equal(second.body.retryable, true);
  }));

/* ── 11. 前提校验（§9.2/§17：派发与动作前） ──────────────────────── */

test("前提校验：被推翻/待复核前提阻止派发与动作；requires_state 谓词生效；撤回边后不再阻止", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "seed-worker");
    // 建立三个真实判断对象（经 A1 提交）
    const mk = async (sid, ops) => {
      const res = await call(s.base, "POST", "/sorne/submissions", { body: { submission_id: sid, operations: ops }, session: w });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.ids;
    };
    const hypA = (await mk("pre-1", [{ op: "propose_hypothesis", local_ref: "h", statement: "判断 A" }])).h;
    const vulB = (await mk("pre-2", [{ op: "report_vulnerability", local_ref: "v", category: "xss" }])).v;
    const intent = await seedIntent(s.dataDir, p.id);
    const w1 = workerSession(p.id, "w1");
    const rel = async (sid, to, extra = {}) =>
      mk(sid, [{ op: "add_relation", from: intent, type: "requires", to, ...extra }]);

    // (a) requires 边指向 supported 假设（requires_state=status=supported）→ 放行
    await rel("pre-3", hypA, { requires_state: "status=supported" });
    {
      const store = await getStore({ dataDir: s.dataDir });
      await store.runSerial((db) => {
        db.prepare("UPDATE hypotheses SET status = 'supported' WHERE id = ?").run(hypA);
      });
    }
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });

    // (b) 动作前前提失效（真实库行推进假设状态为 rejected）→ 工具登记被 PRECONDITION_INVALID 阻止
    {
      const store = await getStore({ dataDir: s.dataDir });
      await store.runSerial((db) => {
        db.prepare("UPDATE hypotheses SET status = 'rejected' WHERE id = ?").run(hypA);
      });
    }
    const blocked = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t", args: {} },
      session: w1,
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.code, "PRECONDITION_INVALID");
    assert.match(blocked.body.message, /前提不满足/);

    // (c) 撤回该 requires 边（A1 retract_relation，需 expected_valid_from_seq）→ 不再阻止
    const db1 = await rows(s.dataDir);
    const edge = db1
      .prepare("SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND relation_type = 'requires'")
      .get(p.id, intent);
    await mk("pre-4", [{ op: "retract_relation", id: edge.id, expected_valid_from_seq: edge.valid_from_seq }]);
    const ok = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t", args: {} },
      session: w1,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // (d) confirmed + review=pending 的漏洞前提：不能无条件放行（§8.2）
    const intent2 = await seedIntent(s.dataDir, p.id);
    await mk("pre-5", [{ op: "add_relation", from: intent2, type: "requires", to: vulB }]);
    {
      const store = await getStore({ dataDir: s.dataDir });
      await store.runSerial((db) => {
        db.prepare("UPDATE vulnerabilities SET status = 'confirmed', review = 'pending' WHERE id = ?").run(vulB);
      });
    }
    const blocked2 = await dispatch(s.base, rt, { intent_id: intent2, worker_id: "w1" });
    assert.equal(blocked2.status, 422);
    assert.equal(blocked2.body.code, "PRECONDITION_INVALID");
    assert.match(blocked2.body.message, /pending/);

    // (e) prerequisite_refs 引用不存在对象 → INVALID_REFERENCE
    const intent3 = await seedIntent(s.dataDir, p.id, { prerequisite_refs: ["V-9999"] });
    const bad = await dispatch(s.base, rt, { intent_id: intent3, worker_id: "w1" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "INVALID_REFERENCE");
  }));

/* ── 12. 事务原子性注入（真实 SQLite TRIGGER RAISE） ─────────────── */

test("事务原子性注入：Outbox 写入点失败（真实 TRIGGER RAISE）→ 派发整体回滚，无半状态", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      db.exec(
        `CREATE TRIGGER inject_outbox_fail BEFORE INSERT ON outbox
         WHEN NEW.event_type = 'resource_state.changed'
         BEGIN SELECT RAISE(ABORT, '注入：Outbox 写入失败'); END`,
      );
    });
    const res = await dispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?").get(p.id).c, 0, "数据变化与事件必须同事务（§2 约束 10）：失败不留半状态");
    await store.runSerial((db2) => db2.exec("DROP TRIGGER inject_outbox_fail"));
    const ok = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    assert.equal(ok.attempt.status, "leased");
  }));

/* ── 13. #23 视图形状（C3 数据面） ───────────────────────────────── */

test("队列视图：by_status/unknown/running 明细、租约剩余时间、游标分页、user 角色不泄露 fencing_token", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const i1 = await seedIntent(s.dataDir, p.id);
    const i2 = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d1 = await mustDispatch(s.base, rt, { intent_id: i1, worker_id: "w1" });
    const d2 = await mustDispatch(s.base, rt, { intent_id: i2, worker_id: "w2" });
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d1.attempt.id, fencing_token: d1.fencing_token, tool_name: "t", args: {} },
      session: w,
    });
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d1.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d1.fencing_token },
      session: w,
    });
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "mark_unknown", attempt_id: d1.attempt.id, tool_call_id: reg.body.tool_call.id, reason: "中断" },
      session: w,
    });
    await call(s.base, "POST", `/sorne/attempts/${d1.attempt.id}/progress`, {
      body: { kind: "blocked", note: "缺少登录条件", condition_gaps: ["未登录会话"] },
      session: w,
    });

    const view = await call(s.base, "GET", "/sorne/attempts", { session: rt });
    assert.equal(view.status, 200);
    assert.equal(view.body.attempts.length, 2);
    const a1 = view.body.attempts.find((a) => a.id === d1.attempt.id);
    assert.equal(a1.tool_calls.by_status.unknown, 1);
    assert.equal(a1.tool_calls.unknown[0].tool_name, "t");
    assert.equal(a1.reports.unhandled, 1);
    assert.ok(typeof a1.lease.seconds_remaining === "number" && a1.lease.seconds_remaining > 0);
    assert.equal(typeof a1.fencing_token, "number", "runtime 可见 fencing token");

    // 分页（limit=1）
    const page1 = await call(s.base, "GET", "/sorne/attempts?limit=1", { session: rt });
    assert.equal(page1.body.attempts.length, 1);
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.next_after);
    const page2 = await call(s.base, `GET`, `/sorne/attempts?limit=1&after=${page1.body.next_after}`, { session: rt });
    assert.equal(page2.body.attempts.length, 1);
    assert.equal(page2.body.has_more, false);

    // user 角色只读可见，但不泄露 fencing_token；worker 视图只见本人 token
    const userView = await call(s.base, "GET", "/sorne/attempts", {
      session: issueSession({ project_id: p.id, actor: "u1", role: "user" }),
    });
    assert.equal(userView.status, 200);
    assert.ok(userView.body.attempts.every((a) => a.fencing_token === undefined), "user 不得见 fencing token");
    const wView = await call(s.base, "GET", "/sorne/attempts", { session: w });
    assert.equal(wView.status, 200);
    const own = wView.body.attempts.find((a) => a.id === d1.attempt.id);
    assert.equal(typeof own.fencing_token, "number");

    // 无会话回环读取按 user 面只读（B1 快照端点同 precedent）：project_id 取 query，不泄露 token
    const anon = await call(s.base, "GET", `/sorne/attempts?project_id=${p.id}`);
    assert.equal(anon.status, 200, JSON.stringify(anon.body));
    assert.ok(anon.body.attempts.every((a) => a.fencing_token === undefined));
    const anonNoProject = await call(s.base, "GET", "/sorne/attempts");
    assert.equal(anonNoProject.status, 400);

    // 跨项目访问拒绝
    const other = await createProject(s.base, "C2 其他项目");
    const cross = await call(s.base, `GET`, `/sorne/attempts?project_id=${other.id}`, { session: rt });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");
    assert.equal(d2.attempt.id !== d1.attempt.id, true);
  }));

/* ── 14. 用户停止的执行面立即生效（完整场景 20 见 scope.test） ─────── */

test("用户停止立即生效：新派发/新动作/心跳被阻止；在途调用可落定实际结果；历史与迟到汇报保留", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t", args: {} },
      session: w,
    });
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.fencing_token },
      session: w,
    });

    // 用户停止（A1 真实端点，用户面）
    const stop = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));

    // 新派发被阻止（PRECONDITION_INVALID，§16.4 立即生效，不等待 AI）
    const i2 = await seedIntent(s.dataDir, p.id);
    const nd = await dispatch(s.base, rt, { intent_id: i2, worker_id: "w2" });
    assert.equal(nd.status, 422);
    assert.equal(nd.body.code, "PRECONDITION_INVALID");
    assert.match(nd.body.message, /停止/);

    // 任一 C2 触点的清扫撤销执行权：Attempt interrupted + 在途调用 unknown
    const list = await call(s.base, "GET", "/sorne/attempts", { session: rt });
    const swept = list.body.attempts.find((a) => a.id === d.attempt.id);
    assert.equal(swept.status, "interrupted");
    assert.equal(swept.tool_calls.by_status.unknown, 1);

    // 心跳被拒；新工具动作被拒
    const beat = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/lifecycle`, {
      body: { action: "heartbeat", fencing_token: d.fencing_token },
      session: rt,
    });
    assert.equal(beat.status, 422);
    const tool = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t2", args: {} },
      session: w,
    });
    assert.equal(tool.status, 422);
    assert.equal(tool.body.code, "PRECONDITION_INVALID"); // 停止后的新动作按项目状态拒绝（§16.4）；租约域错误用于过期/失权场景
    assert.match(tool.body.message, /停止/);

    // 已发出操作记录实际结果（不假装撤回）：unknown 经核查 resolve
    const resolve = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "resolve", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, outcome: "cancelled", check_note: "运行时确认进程已被杀死，外部无副作用" },
      session: w,
    });
    assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
    assert.equal(resolve.body.tool_call.status, "cancelled");

    // 迟到汇报留档；历史全部保留
    const late = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "progress", note: "停止前已完成的部分" },
      session: w,
    });
    assert.equal(late.status, 200);
    assert.equal(late.body.late, true);
    const db = await rows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE id = ?").get(d.attempt.id).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE attempt_id = ?").get(d.attempt.id).c, 1);
  }));

/* ── 15. paused：阻止新动作、允许心跳与落定（§16.4） ─────────────── */

test("paused 项目：新派发与新工具动作 PRECONDITION_INVALID；心跳与在途落定仍允许", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const w = workerSession(p.id, "w1");
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const reg = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t", args: {} },
      session: w,
    });
    await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.fencing_token },
      session: w,
    });
    await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "pause" } });

    const i2 = await seedIntent(s.dataDir, p.id);
    const nd = await dispatch(s.base, rt, { intent_id: i2, worker_id: "w2" });
    assert.equal(nd.status, 422);
    assert.equal(nd.body.code, "PRECONDITION_INVALID");

    const tool = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t2", args: {} },
      session: w,
    });
    assert.equal(tool.status, 422);
    assert.equal(tool.body.code, "PRECONDITION_INVALID");

    const beat = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/lifecycle`, {
      body: { action: "heartbeat", fencing_token: d.fencing_token, lease_ttl_ms: 600000 },
      session: rt,
    });
    assert.equal(beat.status, 200, JSON.stringify(beat.body));

    const done = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "complete", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, outcome: "succeeded" },
      session: w,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.tool_call.status, "succeeded");
  }));

/* ── 16. worker 权限面 ───────────────────────────────────────────── */

test("worker 权限面：非本人 Attempt 的进展与工具调用被拒（TRUST_DENIED）", () =>
  withServer(async (s) => {
    const p = await createProject(s.base);
    const intent = await seedIntent(s.dataDir, p.id);
    const rt = runtimeSession(p.id);
    const d = await mustDispatch(s.base, rt, { intent_id: intent, worker_id: "w1" });
    const stranger = workerSession(p.id, "w9");
    const prog = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "progress", note: "x" },
      session: stranger,
    });
    assert.equal(prog.status, 403);
    assert.equal(prog.body.code, "TRUST_DENIED");
    const tool = await call(s.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, fencing_token: d.fencing_token, tool_name: "t", args: {} },
      session: stranger,
    });
    assert.equal(tool.status, 403);
    // 本人放行
    const w1 = workerSession(p.id, "w1");
    const ok = await call(s.base, "POST", `/sorne/attempts/${d.attempt.id}/progress`, {
      body: { kind: "progress", note: "进行中" },
      session: w1,
    });
    assert.equal(ok.status, 200);
  }));
