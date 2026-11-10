/**
 * C1 —— 意图与计划接收测试（规范 §10.1 §16.2 §11.2 #20/#21）。
 *
 * 覆盖：
 *   - §10.1 Intent 合同全字段、九态状态机 + intent_state_history 历史、
 *     完成建议的必要产物与状态条件检查（一句「完成」不关项目）；
 *   - §16.2 计划接收：对象存在/范围有效/前提版本有效/依赖死锁
 *     （DEPENDENCY_CYCLE）四类检查、幂等接收（原回执/IDEMPOTENCY_KEY_REUSED）、
 *     前提失效只挂起或拒绝受影响部分（§20.3 场景 10 语义锚点：无关新增
 *     不使计划失效）、疑似语义重复只告警不强制合并；
 *   - 真实事务与重启故障注入（bootServer 复用 dataDir + closeStore 模拟
 *     进程退出再拉起），不用 mock 代替真实行为。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer），
 * 不留后台进程、不触碰 ~/.sorne。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";
import { openDatabase } from "../lib/db.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { transitionIntent, reviewCompletion } from "../lib/store/intents.mjs";
import { withTestServer } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有 HTTP 工具（支持会话头；helpers 为冻结文件） ────────── */

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

/** 重启演练专用服务器：显式 dataDir，关闭时不删目录（模拟进程退出再拉起）。 */
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

/* ── 夹具 ─────────────────────────────────────────────────────────── */

let subCounter = 0;
function nextSubId(prefix) {
  subCounter += 1;
  return `${prefix}-${String(subCounter).padStart(4, "0")}`;
}

async function createProject(base, { name = "意图测试项目", withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: {
      name,
      ...(withScope
        ? { scope_rules: { allow: ["*.test", "10.0.0.0/8"], deny: [], pending: [] } }
        : {}),
    },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function plannerSession(projectId, actor = "planner-1") {
  return issueSession({ project_id: projectId, actor, role: "planner" });
}
function workerSession(projectId, actor = "w1") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}

/** 经真实 POST /submissions 注册资产（worker 会话）。 */
async function registerAsset(base, projectId, canonicalKey, localRef = "a") {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: nextSubId("SUB-AST"),
      operations: [
        {
          op: "register_asset",
          local_ref: localRef,
          asset_type: "domain",
          canonicalization_version: "v1",
          canonical_key: canonicalKey,
        },
      ],
    },
    session: workerSession(projectId),
  });
  assert.equal(res.status, 200, `注册资产失败：${JSON.stringify(res.body)}`);
  return res.body.ids[localRef];
}

/** 经真实提交追加观察（可作为依据/证明记录）。 */
async function appendObservation(base, projectId, statement) {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: nextSubId("SUB-OBS"),
      operations: [{ op: "append_observation", local_ref: "o", statement }],
    },
    session: workerSession(projectId),
  });
  assert.equal(res.status, 200, `追加观察失败：${JSON.stringify(res.body)}`);
  return res.body.ids.o;
}

/** 建立 suspected 漏洞并把夹具状态置为 confirmed/state_version=3/review=clear。 */
async function confirmedVulnerability(base, projectId, { stateVersion = 3 } = {}) {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: nextSubId("SUB-VUL"),
      operations: [{ op: "report_vulnerability", local_ref: "v", category: "sql-injection" }],
    },
    session: workerSession(projectId),
  });
  assert.equal(res.status, 200, `建立漏洞失败：${JSON.stringify(res.body)}`);
  const vid = res.body.ids.v;
  const store = await getStore({ dataDir: dataDirOf(base) });
  await store.runSerial((db) => {
    db.prepare("UPDATE vulnerabilities SET status = 'confirmed', state_version = ?, review = 'clear' WHERE id = ?").run(
      stateVersion,
      vid,
    );
  });
  return vid;
}

/** 记录当前 dataDir（通过环境变量在 startTestServer/withTestServer 间传递）。 */
function dataDirOf() {
  return process.env.__SORNE_TEST_DATA_DIR__;
}

/** worker 向 V 追加一条 supports 关系（A1 逻辑会推进 evidence_revision，confirmed+clear → review=pending）。 */
async function addSupportingEvidence(base, projectId, vulnId, statement) {
  const obsId = await appendObservation(base, projectId, statement);
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: nextSubId("SUB-REL"),
      operations: [
        { op: "add_relation", local_ref: "r", from: obsId, type: "supports", to: vulnId },
      ],
    },
    session: workerSession(projectId),
  });
  assert.equal(res.status, 200, `追加支持证据失败：${JSON.stringify(res.body)}`);
  return obsId;
}

function planEnvelope(projectId, { revision, submissionId, intents, prerequisites, ...rest }) {
  return {
    submission_id: submissionId,
    plan_revision: revision,
    intents: intents ?? [],
    ...(prerequisites ? { prerequisites } : {}),
    ...rest,
  };
}

function createIntentItem(fields) {
  return { op: "create", ...fields };
}

async function submitPlan(base, projectId, envelope) {
  return call(base, "POST", "/sorne/plan-revisions", {
    body: envelope,
    session: plannerSession(projectId),
  });
}

/** withTestServer 包装：同时把 dataDir 暴露到环境变量供夹具直连库。 */
async function withServer(fn) {
  return withTestServer(async (s) => {
    const prev = process.env.__SORNE_TEST_DATA_DIR__;
    process.env.__SORNE_TEST_DATA_DIR__ = s.dataDir;
    try {
      return await fn(s);
    } finally {
      if (prev === undefined) delete process.env.__SORNE_TEST_DATA_DIR__;
      else process.env.__SORNE_TEST_DATA_DIR__ = prev;
      await closeStore({ dataDir: s.dataDir });
    }
  });
}

async function dbOf() {
  const store = await getStore({ dataDir: dataDirOf() });
  return store.db;
}

/* ── 0. 迁移 ──────────────────────────────────────────────────────── */

test("迁移 0003：intent_state_history 表与索引存在（0004 起版本随之推进）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sorne-c1-mig-"));
  const store = await openDatabase({ file: join(dir, "state", "sorne.sqlite") });
  try {
    assert.ok(store.schemaVersion >= 3, "0003 起应 ≥3（当前最新含 0004 全局实体序列）");
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes("intent_state_history"), "缺少 intent_state_history 表");
    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes("idx_intent_state_history_intent"));
    assert.equal(await store.migrate(), store.schemaVersion, "迁移应幂等");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 1. 计划接收基础合同（§10.1/§16.2） ───────────────────────────── */

test("计划接收：§10.1 合同全字段落库、plan.received 事件与语义边（targets/requires/derived_from）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const assetId = await registerAsset(s.base, project.id, "target.test");
    const basisObs = await appendObservation(s.base, project.id, "登录页存在 /api/login 入口");
    const prereqObs = await appendObservation(s.base, project.id, "已确认会话有效");
    // goals 无 API，按夹具直插（状态机与历史不受影响）
    const db = await dbOf();
    const store = await getStore({ dataDir: dataDirOf() });
    await store.runSerial((d) => {
      d.prepare(
        "INSERT INTO goals (id, project_id, statement, created_at, created_by, created_seq) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("G-0001", project.id, "梳理登录面", new Date().toISOString(), "fixture", 1);
    });

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SUB-0001",
      plan_revision: "r1",
      input_boundary: "12",
      intents: [
        createIntentItem({
          local_ref: "i1",
          question: "登录接口是否存在未校验的账户条件？",
          rationale: "入口已见，身份条件未覆盖",
          kind: "investigate",
          goal_id: "G-0001",
          target_asset_ids: [assetId],
          basis_refs: [basisObs],
          prerequisite_refs: [prereqObs],
          condition_requirements: [{ kind: "identity", description: "未登录态" }],
          success_criteria: "给出该问题的是/否回答及依据，或明确缺口",
          deliverables: ["入口清单", { key: "raw_capture", description: "原始抓包" }],
          priority: 5,
          budget: { tool_calls: 20 },
          resume_conditions: [],
          runnable_at: "2026-11-06T00:00:00.000Z",
        }),
      ],
      prerequisites: [{ ref: prereqObs, expected_state_version: undefined }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.received_status, "accepted");
    assert.equal(res.body.intents_created.length, 1);
    const intentId = res.body.ids.i1;
    assert.ok(intentId, "local_ref 应映射到正式 ID");
    const scope = db.prepare("SELECT current_scope_revision AS s FROM projects WHERE id = ?").get(project.id);

    const row = db.prepare("SELECT * FROM intents WHERE id = ?").get(intentId);
    assert.equal(row.question, "登录接口是否存在未校验的账户条件？");
    assert.equal(row.kind, "investigate");
    assert.equal(row.goal_id, "G-0001");
    assert.deepEqual(JSON.parse(row.target_asset_ids), [assetId]);
    assert.deepEqual(JSON.parse(row.basis_refs), [basisObs]);
    assert.deepEqual(JSON.parse(row.prerequisite_refs), [prereqObs]);
    assert.equal(row.scope_revision, scope.s, "计划未声明 → 项目当前范围版本（存范围行编号，与 projects.current_scope_revision 同形态）");
    assert.equal(row.priority, 5);
    assert.deepEqual(JSON.parse(row.budget), { tool_calls: 20 });
    assert.equal(row.status, "proposed");
    assert.equal(row.plan_revision, "r1");
    assert.equal(row.success_criteria, "给出该问题的是/否回答及依据，或明确缺口");
    assert.deepEqual(JSON.parse(row.deliverables), ["入口清单", { key: "raw_capture", description: "原始抓包" }]);

    // §9.1 语义边 + 新边事件 + 依赖变化事件（§15.5/§9.2）
    const edges = db
      .prepare("SELECT * FROM relations WHERE project_id = ? AND from_id = ?")
      .all(project.id, intentId)
      .map((r) => r.relation_type)
      .sort();
    assert.deepEqual(edges, ["derived_from", "requires", "targets"]);
    const events = db
      .prepare("SELECT event_type FROM outbox WHERE project_id = ? ORDER BY commit_seq, event_index")
      .all(project.id)
      .map((r) => r.event_type);
    assert.ok(events.includes("plan.received"));
    assert.ok(events.includes("relation.added"));
    assert.ok(events.includes("dependency.changed"), "requires 新边应产生依赖变化事件");
    // 历史：随创建直接进入 proposed
    const history = db
      .prepare("SELECT * FROM intent_state_history WHERE intent_id = ? ORDER BY commit_seq")
      .all(intentId);
    assert.equal(history.length, 1);
    assert.equal(history[0].from_status, null);
    assert.equal(history[0].to_status, "proposed");
    assert.match(history[0].via, /^plan:r1$/);
    // plan_revisions 行 + plan_run 状态
    const plan = db.prepare("SELECT * FROM plan_revisions WHERE project_id = ?").get(project.id);
    assert.equal(plan.received_status, "accepted");
    const run = db.prepare("SELECT * FROM plan_runs WHERE id = ?").get(res.body.plan_run_id);
    assert.equal(run.status, "received");
  }));

test("计划接收：引用不存在的对象 → INVALID_REFERENCE，整单原子回滚（无意图/无计划行/无新事件/无回执，commit_seq 不留消费）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const db = await dbOf();
    const beforeSeq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project.id).n;
    const outboxBefore = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?").get(project.id).c;

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SUB-BOOM",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "ok",
          question: "正常意图？",
          kind: "collect",
          success_criteria: "清点资产",
        }),
        createIntentItem({
          local_ref: "bad",
          question: "引用幽灵目标？",
          kind: "investigate",
          success_criteria: "回答问题",
          goal_id: "G-9999",
        }),
      ],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_REFERENCE");

    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ?").get(project.id).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM plan_revisions WHERE project_id = ?").get(project.id).c, 0);
    const outboxAfter = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?").get(project.id).c;
    assert.equal(outboxAfter, outboxBefore, "整单回滚不产生任何新事件");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE project_id = ? AND id = ?").get(project.id, "PLAN-SUB-BOOM").c,
      0,
      "整单回滚不应留下提交回执",
    );
    const afterSeq = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project.id).n;
    assert.equal(afterSeq, beforeSeq, "回滚不消耗 commit_seq");
  }));

test("计划接收：信封自报 project_id/actor/role 一律拒绝（§11.1）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SUB-SELF",
      plan_revision: "r1",
      project_id: project.id,
      intents: [],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "BAD_REQUEST");
  }));

/* ── 2. 幂等接收（§16.2 完全相同的提交按幂等规则处理；§14.2 稳定业务键） ── */

test("幂等接收：同一 submission_id 同内容重发返回原回执，不重复建意图或事件", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const envelope = {
      submission_id: "PLAN-IDEM-1",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "Q1？", kind: "collect", success_criteria: "清点" })],
    };
    const first = await submitPlan(s.base, project.id, envelope);
    assert.equal(first.status, 200);
    const second = await submitPlan(s.base, project.id, envelope);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body); // 原回执原样返回

    const db = await dbOf();
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ?").get(project.id).c, 1);
    const events = db
      .prepare("SELECT event_type FROM outbox WHERE project_id = ? AND event_type = 'plan.received'")
      .all(project.id);
    assert.equal(events.length, 1, "重复接收不得重复产生计划事件");
  }));

test("幂等接收：同一 submission_id 不同内容 → IDEMPOTENCY_KEY_REUSED，原提交不被覆盖", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const first = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-IDEM-2",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "原问题？", kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(first.status, 200);
    const clash = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-IDEM-2",
      plan_revision: "r2",
      intents: [createIntentItem({ local_ref: "i", question: "不同内容", kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(clash.status, 422);
    assert.equal(clash.body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.ok(clash.body.receipt && clash.body.receipt.submission_id === "PLAN-IDEM-2", "错误信封应带回原提交回执摘要");
    // 原内容仍可取得原回执
    const again = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-IDEM-2",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "原问题？", kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
  }));

test("幂等接收：同 run 同 revision 标签的新提交给出可读拒绝（UNIQUE 域防换壳重提）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const first = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-R1-A",
      plan_revision: "r1",
      intents: [],
    });
    assert.equal(first.status, 200);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-R1-B",
      plan_revision: "r1",
      plan_run_id: first.body.plan_run_id,
      intents: [],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.match(res.body.message, /plan_revision/);
  }));

/* ── 3. 范围有效（§16.2/§17） ─────────────────────────────────────── */

test("范围有效：项目未配置范围 → SCOPE_UNRESOLVED；配置后同一计划可接收且意图记录范围版本", () =>
  withServer(async (s) => {
    const project = await createProject(s.base, { withScope: false });
    const rejected = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SCOPE-1",
      plan_revision: "r1",
      intents: [createIntentItem({ question: "Q？", kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.code, "SCOPE_UNRESOLVED");
    assert.ok(Array.isArray(rejected.body.next_requirements) && rejected.body.next_requirements.length > 0);

    const scopeRes = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: project.id, rules: { allow: ["*.test"], deny: [], pending: [] }, summary: "补配范围" },
    });
    assert.equal(scopeRes.status, 200);

    const accepted = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SCOPE-2",
      plan_revision: "r1",
      intents: [createIntentItem({ question: "Q？", kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(accepted.status, 200);
    const db = await dbOf();
    const row = db.prepare("SELECT scope_revision FROM intents WHERE project_id = ?").get(project.id);
    const current = db.prepare("SELECT current_scope_revision AS s FROM projects WHERE id = ?").get(project.id);
    assert.equal(row.scope_revision, current.s);
  }));

test("范围有效：范围版本引用不存在 → INVALID_REFERENCE", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SCOPE-3",
      plan_revision: "r1",
      scope_revision: "99",
      intents: [],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_REFERENCE");
  }));

test("范围有效：目标资产被明确拒绝 → 仅该意图被拒（SCOPE_DENIED），其余意图照常接收（partial）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const deniedAsset = await registerAsset(s.base, project.id, "denied.test");
    const okAsset = await registerAsset(s.base, project.id, "allowed.test");
    const store = await getStore({ dataDir: dataDirOf() });
    await store.runSerial((db) => {
      db.prepare("UPDATE assets SET scope_status = 'denied' WHERE id = ?").run(deniedAsset);
    });

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SCOPE-4",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "bad",
          question: "打拒绝资产？",
          kind: "investigate",
          success_criteria: "回答",
          target_asset_ids: [deniedAsset],
        }),
        createIntentItem({
          local_ref: "ok",
          question: "正常资产？",
          kind: "collect",
          success_criteria: "清点",
          target_asset_ids: [okAsset],
        }),
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.received_status, "partial");
    assert.equal(res.body.rejected.length, 1);
    assert.equal(res.body.rejected[0].code, "SCOPE_DENIED");
    assert.equal(res.body.intents_created.length, 1);
    const db = await dbOf();
    const statuses = db
      .prepare("SELECT id FROM intents WHERE project_id = ? AND question = ?")
      .all(project.id, "打拒绝资产？");
    assert.equal(statuses.length, 0, "被拒意图不得落库为可执行意图");
  }));

/* ── 4. 前提版本有效（§16.2；§20.3 场景 10 语义锚点） ─────────────── */

test("前提失效只挂起受影响部分：blocked+理由+恢复条件+intent.blocked 事件；未受影响意图照常（partial）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const vuln = await confirmedVulnerability(s.base, project.id);
    // 规划期间前提失效：新支持证据到达 → A1 推进 evidence_revision，confirmed+clear → review=pending
    await addSupportingEvidence(s.base, project.id, vuln, "新增支持证据（应触发复核标记）");

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-PREREQ-1",
      plan_revision: "r1",
      prerequisites: [{ ref: vuln, expected_status: "confirmed", expected_review: "clear" }],
      intents: [
        createIntentItem({
          local_ref: "dep",
          question: "以漏洞成立为前提的深入？",
          kind: "investigate",
          success_criteria: "回答",
          prerequisite_refs: [vuln],
        }),
        createIntentItem({
          local_ref: "free",
          question: "不受该前提影响的清点？",
          kind: "collect",
          success_criteria: "清点",
        }),
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.received_status, "partial");
    assert.equal(res.body.suspended.length, 1);
    assert.match(res.body.suspended[0].reason, /review/);

    const db = await dbOf();
    const blockedId = res.body.ids.dep;
    const row = db.prepare("SELECT * FROM intents WHERE id = ?").get(blockedId);
    assert.equal(row.status, "blocked");
    const resume = JSON.parse(row.resume_conditions);
    assert.ok(
      resume.some((r) => r.kind === "prerequisite" && r.ref === vuln && r.description.includes("review")),
      "恢复条件应写明前提恢复要求",
    );
    const freeRow = db.prepare("SELECT status FROM intents WHERE id = ?").get(res.body.ids.free);
    assert.equal(freeRow.status, "proposed", "未受影响意图照常接收");
    const blockedEvent = db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'intent.blocked'")
      .get(project.id);
    assert.ok(blockedEvent, "挂起应产生 intent.blocked 事件");
    const history = db
      .prepare("SELECT * FROM intent_state_history WHERE intent_id = ? ORDER BY commit_seq")
      .all(blockedId);
    assert.equal(history.length, 1);
    assert.equal(history[0].to_status, "blocked");
    assert.equal(history[0].action, "suspend_on_reception");
  }));

test("无关新增不废计划（§16.2/§20.3 场景 10 语义）：全局新记录不使前提失效", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const vuln = await confirmedVulnerability(s.base, project.id);
    // 规划期间来了与前提无关的新记录：只追加观察，不触碰 V 的任何版本
    await appendObservation(s.base, project.id, "与前提无关的新观察");

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-PREREQ-2",
      plan_revision: "r1",
      prerequisites: [{ ref: vuln, expected_status: "confirmed", expected_state_version: 3 }],
      intents: [
        createIntentItem({
          local_ref: "dep",
          question: "以漏洞成立为前提的深入？",
          kind: "investigate",
          success_criteria: "回答",
          prerequisite_refs: [vuln],
        }),
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.received_status, "accepted", "无关新增不得使整个计划失效");
    assert.equal(res.body.suspended.length, 0);
    const db = await dbOf();
    const row = db.prepare("SELECT status FROM intents WHERE id = ?").get(res.body.ids.dep);
    assert.equal(row.status, "proposed");
  }));

test("前提失效策略 reject：受影响意图被拒并保留理由，其余照常", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const vuln = await confirmedVulnerability(s.base, project.id);
    await addSupportingEvidence(s.base, project.id, vuln, "复核标记证据");

    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-PREREQ-3",
      plan_revision: "r1",
      prerequisites: [{ ref: vuln, expected_review: "clear" }],
      intents: [
        createIntentItem({
          local_ref: "dep",
          question: "策略拒绝的意图？",
          kind: "investigate",
          success_criteria: "回答",
          prerequisite_refs: [vuln],
          on_prerequisite_invalid: "reject",
        }),
        createIntentItem({ local_ref: "free", question: "自由清点？", kind: "collect", success_criteria: "清点" }),
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.received_status, "partial");
    assert.equal(res.body.rejected[0].code, "PRECONDITION_INVALID");
    assert.match(res.body.rejected[0].reason, /失效/);
    const db = await dbOf();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND question = ?").get(project.id, "策略拒绝的意图？").c,
      0,
    );
  }));

test("前提声明引用不存在的对象 → INVALID_REFERENCE（硬失败）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-PREREQ-4",
      plan_revision: "r1",
      prerequisites: [{ ref: "V-9999", expected_status: "confirmed" }],
      intents: [],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_REFERENCE");
  }));

test("前提声明对无版本字段的对象声明期望 → BAD_REQUEST（可用字段明示）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const assetId = await registerAsset(s.base, project.id, "plain.test");
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-PREREQ-5",
      plan_revision: "r1",
      prerequisites: [{ ref: assetId, expected_status: "allowed" }],
      intents: [],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "BAD_REQUEST");
  }));

/* ── 5. 依赖死锁（§16.2/§9.2：DEPENDENCY_CYCLE） ──────────────────── */

test("依赖死锁：同计划内互为前提 → DEPENDENCY_CYCLE 整单回滚", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-1",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "a",
          question: "A？",
          kind: "collect",
          success_criteria: "回答",
          prerequisite_refs: ["b"],
        }),
        createIntentItem({
          local_ref: "b",
          question: "B？",
          kind: "collect",
          success_criteria: "回答",
          prerequisite_refs: ["a"],
        }),
      ],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "DEPENDENCY_CYCLE");
    assert.ok(Array.isArray(res.body.detail.cycle) && res.body.detail.cycle.length >= 2);
    const db = await dbOf();
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ?").get(project.id).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM plan_revisions WHERE project_id = ?").get(project.id).c, 0);
  }));

test("依赖死锁：跨计划修订闭合环路 → DEPENDENCY_CYCLE，被修订意图保持原状", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-2",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "ia", question: "IA？", kind: "collect", success_criteria: "回答" })],
    });
    assert.equal(p1.status, 200);
    const ia = p1.body.ids.ia;
    const p2 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-3",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "ib",
          question: "IB？",
          kind: "collect",
          success_criteria: "回答",
          prerequisite_refs: [ia],
        }),
      ],
    });
    assert.equal(p2.status, 200);
    const ib = p2.body.ids.ib;

    const db = await dbOf();
    const before = db.prepare("SELECT state_version, question FROM intents WHERE id = ?").get(ia);
    const cyc = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-4",
      plan_revision: "r1",
      intents: [
        {
          op: "revise",
          intent_id: ia,
          expected_state_version: before.state_version,
          prerequisite_refs: [ib],
        },
      ],
    });
    assert.equal(cyc.status, 422);
    assert.equal(cyc.body.code, "DEPENDENCY_CYCLE");
    const after = db.prepare("SELECT state_version, question, prerequisite_refs FROM intents WHERE id = ?").get(ia);
    assert.equal(after.state_version, before.state_version, "成环修订被拒，意图保持原状");
    assert.deepEqual(JSON.parse(after.prerequisite_refs), []);
  }));

test("依赖死锁：自引用前提（自身）同样成环拒绝", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-5",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "solo", question: "S？", kind: "collect", success_criteria: "回答" })],
    });
    const solo = p1.body.ids.solo;
    const db = await dbOf();
    const version = db.prepare("SELECT state_version FROM intents WHERE id = ?").get(solo).state_version;
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CYC-6",
      plan_revision: "r1",
      intents: [{ op: "revise", intent_id: solo, expected_state_version: version, prerequisite_refs: [solo] }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "DEPENDENCY_CYCLE");
  }));

/* ── 6. 疑似语义重复（§16.2：交 AI 判断，不强制合并） ──────────────── */

test("疑似重复：同问题同类型的未结意图再创建不强制合并，仅告警交 AI", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const question = "登录入口有哪些？";
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-DUP-1",
      plan_revision: "r1",
      intents: [createIntentItem({ question, kind: "collect", success_criteria: "清点" })],
    });
    assert.equal(p1.status, 200);
    const p2 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-DUP-2",
      plan_revision: "r1",
      intents: [createIntentItem({ question, kind: "collect", success_criteria: "清点（复核）" })],
    });
    assert.equal(p2.status, 200);
    assert.equal(p2.body.received_status, "accepted");
    assert.ok(
      p2.body.warnings.some((w) => w.includes("疑似重复") && w.includes("不强制合并")),
      "应告警疑似重复并明示交 AI 判断",
    );
    const db = await dbOf();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ? AND question = ?").get(project.id, question).c,
      2,
      "两个独立意图并存，不合并",
    );
  }));

/* ── 7. 修订（§11.3 修改型）与 requires 边同步 ─────────────────────── */

test("修订：expected_state_version 校验（STALE_STATE）+ 字段更新 + 计划来源 requires 边收缩（dependency.changed superseded）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const obs1 = await appendObservation(s.base, project.id, "前提一");
    const obs2 = await appendObservation(s.base, project.id, "前提二");
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-REV-1",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "i",
          question: "原问题？",
          kind: "investigate",
          success_criteria: "回答",
          prerequisite_refs: [obs1],
          priority: 1,
        }),
      ],
    });
    const intentId = p1.body.ids.i;
    const db = await dbOf();

    // 版本不匹配 → STALE_STATE
    const stale = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-REV-2",
      plan_revision: "r1",
      intents: [{ op: "revise", intent_id: intentId, expected_state_version: 999, priority: 2 }],
    });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "STALE_STATE");

    // 正确修订：换前提 + 升优先级
    const ok = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-REV-3",
      plan_revision: "r2",
      intents: [
        { op: "revise", intent_id: intentId, expected_state_version: 1, prerequisite_refs: [obs2], priority: 7 },
      ],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.intents_updated[0].state_version, 2);
    const row = db.prepare("SELECT * FROM intents WHERE id = ?").get(intentId);
    assert.equal(row.priority, 7);
    assert.deepEqual(JSON.parse(row.prerequisite_refs), [obs2]);
    assert.equal(row.plan_revision, "r2");
    // requires 边：旧前提的计划边被撤回，新前提建边
    const requires = db
      .prepare(
        "SELECT * FROM relations WHERE from_id = ? AND relation_type = 'requires' ORDER BY created_seq",
      )
      .all(intentId);
    assert.equal(requires.length, 2);
    assert.equal(requires[0].to_id, obs1);
    assert.ok(requires[0].retracted_at, "旧前提的计划来源 requires 边应随修订撤回");
    assert.equal(requires[1].to_id, obs2);
    assert.ok(!requires[1].retracted_at);
    const superseded = db
      .prepare("SELECT payload FROM outbox WHERE event_type = 'dependency.changed'")
      .all()
      .map((r) => JSON.parse(r.payload))
      .filter((p) => p.change === "superseded");
    assert.equal(superseded.length, 1, "旧前提撤回应产生 dependency.changed(superseded)");
  }));

test("修订：终态意图（resolved）不允许修订，提示创建新意图", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-REV-4",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "Q？", kind: "collect", success_criteria: "回答" })],
    });
    const intentId = p1.body.ids.i;
    await transitionIntent({ dataDir: dataDirOf() }, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent({ dataDir: dataDirOf() }, { projectId: project.id, actor: "rt", intentId, action: "start" });
    await transitionIntent({ dataDir: dataDirOf() }, { projectId: project.id, actor: "rt", intentId, action: "resolve", reason: "完成" });
    const db = await dbOf();
    const version = db.prepare("SELECT state_version FROM intents WHERE id = ?").get(intentId).state_version;
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-REV-5",
      plan_revision: "r1",
      intents: [{ op: "revise", intent_id: intentId, expected_state_version: version, priority: 9 }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "PRECONDITION_INVALID");
  }));

/* ── 8. 状态机 + 历史（§10.1） ────────────────────────────────────── */

test("状态机：proposed→queued→running→resolved 合法链路留全历史；非法迁移与 STALE_STATE 拒绝", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-SM-1",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "Q？", kind: "verify", success_criteria: "回答" })],
    });
    const intentId = p1.body.ids.i;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };

    // 非法：proposed → resolve（跳过执行）
    await assert.rejects(
      () => transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "resolve" }),
      (err) => err.code === "PRECONDITION_INVALID",
    );
    // 修改型校验：expected_state_version 不匹配 → STALE_STATE
    await assert.rejects(
      () => transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate", expectedStateVersion: 99 }),
      (err) => err.code === "STALE_STATE",
    );

    const q = await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    assert.equal(q.intent.status, "queued");
    const r = await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });
    assert.equal(r.intent.status, "running");
    const done = await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "resolve", reason: "问题已回答" });
    assert.equal(done.intent.status, "resolved");
    // resolved 之后再无出边
    await assert.rejects(
      () => transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" }),
      (err) => err.code === "PRECONDITION_INVALID",
    );

    const db = await dbOf();
    const history = db
      .prepare("SELECT * FROM intent_state_history WHERE intent_id = ? ORDER BY commit_seq, id")
      .all(intentId);
    assert.deepEqual(
      history.map((h) => [h.from_status, h.to_status]),
      [[null, "proposed"], ["proposed", "queued"], ["queued", "running"], ["running", "resolved"]],
    );
    // resolve 产生 intent.completed 事件（§14.1 意图完成，不含项目关闭语义）
    const completed = db
      .prepare("SELECT * FROM outbox WHERE event_type = 'intent.completed' AND project_id = ?")
      .get(project.id);
    assert.ok(completed);
  }));

/* ── 9. 完成建议（§10.1：必要产物 + 状态条件；一句完成不关项目） ────── */

test("完成建议：缺必要产物 → PRECONDITION_INVALID 列出缺口，意图保持 running", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const obs = await appendObservation(s.base, project.id, "可作产物的观察");
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-1",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "i",
          question: "入口清点？",
          kind: "collect",
          success_criteria: "给出清单",
          deliverables: ["入口清单", { key: "raw", description: "原始记录" }],
        }),
      ],
    });
    const intentId = p1.body.ids.i;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });

    // 一句「完成」、零证明 → 拒绝并列出缺口
    await assert.rejects(
      () => reviewCompletion(pctx, { projectId: project.id, actor: "w1", intentId, note: "做完了" }),
      (err) => {
        assert.equal(err.code, "PRECONDITION_INVALID");
        assert.ok(err.extra.detail.missing_deliverables.length === 2);
        assert.ok(err.extra.next_requirements.length === 2);
        return true;
      },
    );
    // 部分证明（只有第一项）仍拒绝
    await assert.rejects(
      () =>
        reviewCompletion(pctx, {
          projectId: project.id,
          actor: "w1",
          intentId,
          deliverablesProof: [{ index: 0, record_ids: [obs] }],
        }),
      (err) => err.code === "PRECONDITION_INVALID",
    );
    const db = await dbOf();
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId).status, "running");
  }));

test("完成建议：证明引用不存在的记录 → INVALID_REFERENCE（伪产物拒绝）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-2",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "i",
          question: "入口清点？",
          kind: "collect",
          success_criteria: "给出清单",
          deliverables: ["入口清单"],
        }),
      ],
    });
    const intentId = p1.body.ids.i;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });
    await assert.rejects(
      () =>
        reviewCompletion(pctx, {
          projectId: project.id,
          actor: "w1",
          intentId,
          deliverablesProof: [{ index: 0, record_ids: ["O-9999"] }],
        }),
      (err) => err.code === "INVALID_REFERENCE",
    );
  }));

test("完成建议：产物齐备且前提仍有效 → resolved + intent.completed；项目状态与其余意图不动（一句完成不关项目）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const obsA = await appendObservation(s.base, project.id, "产物一");
    const obsB = await appendObservation(s.base, project.id, "产物二");
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-3",
      plan_revision: "r1",
      intents: [
        createIntentItem({
          local_ref: "i",
          question: "入口清点？",
          kind: "collect",
          success_criteria: "给出清单",
          deliverables: ["入口清单", { key: "raw", description: "原始记录" }],
        }),
        createIntentItem({ local_ref: "other", question: "另一条并行意图？", kind: "revisit", success_criteria: "回答" }),
      ],
    });
    const intentId = p1.body.ids.i;
    const otherId = p1.body.ids.other;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });

    const result = await reviewCompletion(pctx, {
      projectId: project.id,
      actor: "w1",
      intentId,
      deliverablesProof: [
        { index: 0, record_ids: [obsA] },
        { key: "raw", record_ids: [obsB] },
      ],
      note: "清单与原始记录齐备",
    });
    assert.equal(result.decision, "resolved");
    const db = await dbOf();
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId).status, "resolved");
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(otherId).status, "proposed", "其余意图不动");
    const proj = db.prepare("SELECT status FROM projects WHERE id = ?").get(project.id);
    assert.equal(proj.status, "active", "一句完成不得改变项目运行状态（§1/§10.1）");
    const completed = db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'intent.completed'")
      .get(project.id);
    assert.ok(completed, "resolved 应产生 intent.completed 事件");
    // 后续计划仍可接收（项目不因意图完成而关闭）
    const p2 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-4",
      plan_revision: "r2",
      intents: [createIntentItem({ question: "后续方向？", kind: "investigate", success_criteria: "回答" })],
    });
    assert.equal(p2.status, 200);
  }));

test("完成建议：未声明交付物 → awaiting_review 交复核，不直接 resolved；复核后 resolve 生效", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-5",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "语义型问题？", kind: "investigate", success_criteria: "给出判断与依据" })],
    });
    const intentId = p1.body.ids.i;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });

    const result = await reviewCompletion(pctx, { projectId: project.id, actor: "w1", intentId, note: "完成了" });
    assert.equal(result.decision, "awaiting_review");
    const db = await dbOf();
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId).status, "awaiting_review");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'intent.completed'").get(project.id).c,
      0,
      "无交付物的完成不得产生完成事件",
    );
    // 复核通过后经 resolve 转换（§10.1 awaiting_review → resolved）
    const done = await transitionIntent(pctx, {
      projectId: project.id,
      actor: "verifier-1",
      intentId,
      action: "resolve",
      reason: "复核通过",
      via: "review",
    });
    assert.equal(done.intent.status, "resolved");
  }));

test("完成建议：执行期间前提失效（新证据→review=pending）→ 完成被拒并给出恢复条件（§9.2/§10.1 状态条件）", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const vuln = await confirmedVulnerability(s.base, project.id);
    const obs = await appendObservation(s.base, project.id, "产物观察");
    const p1 = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-CMP-6",
      plan_revision: "r1",
      prerequisites: [{ ref: vuln, expected_status: "confirmed", expected_review: "clear" }],
      intents: [
        createIntentItem({
          local_ref: "i",
          question: "以 V 成立为前提的利用验证？",
          kind: "verify",
          success_criteria: "给出验证结论",
          prerequisite_refs: [vuln],
          deliverables: ["验证记录"],
        }),
      ],
    });
    assert.equal(p1.body.received_status, "accepted");
    const intentId = p1.body.ids.i;
    const pctx = { dataDir: dataDirOf(), logger: QUIET };
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "activate" });
    await transitionIntent(pctx, { projectId: project.id, actor: "rt", intentId, action: "start" });

    // 执行期间新支持证据 → review=pending（A1 §8.4/§12.3 逻辑）
    await addSupportingEvidence(s.base, project.id, vuln, "执行期间的新证据");

    await assert.rejects(
      () =>
        reviewCompletion(pctx, {
          projectId: project.id,
          actor: "w1",
          intentId,
          deliverablesProof: [{ index: 0, record_ids: [obs] }],
        }),
      (err) => {
        assert.equal(err.code, "PRECONDITION_INVALID");
        assert.match(err.message, /前提已失效/);
        assert.ok(err.extra.next_requirements.length > 0);
        return true;
      },
    );
    const db = await dbOf();
    assert.equal(db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId).status, "running");
  }));

/* ── 10. GET /intents（#21：过滤/游标分页/历史） ───────────────────── */

test("GET /intents：状态与类型过滤、游标分页不静默截断、include_history", () =>
  withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await submitPlan(s.base, project.id, {
      submission_id: "PLAN-LIST-1",
      plan_revision: "r1",
      intents: [
        createIntentItem({ local_ref: "a", question: "A？", kind: "collect", success_criteria: "x", priority: 1 }),
        createIntentItem({ local_ref: "b", question: "B？", kind: "investigate", success_criteria: "x", priority: 3 }),
        createIntentItem({ local_ref: "c", question: "C？", kind: "collect", success_criteria: "x", priority: 5 }),
        createIntentItem({ local_ref: "d", question: "D？", kind: "verify", success_criteria: "x", priority: 2 }),
        createIntentItem({ local_ref: "e", question: "E？", kind: "revisit", success_criteria: "x", priority: 4 }),
      ],
    });
    assert.equal(res.status, 200);

    // 过滤：kind=collect
    const collect = await call(s.base, "GET", `/sorne/intents?project_id=${project.id}&kind=collect`);
    assert.equal(collect.status, 200);
    assert.equal(collect.body.intents.length, 2);
    // 非法过滤值 → BAD_REQUEST
    const bad = await call(s.base, "GET", `/sorne/intents?project_id=${project.id}&status=queued2`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "BAD_REQUEST");
    // 分页：limit=2 逐页取全
    const seen = [];
    let cursor = null;
    for (;;) {
      const path = `/sorne/intents?project_id=${project.id}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}&include_history=1`;
      const page = await call(s.base, "GET", path);
      assert.equal(page.status, 200);
      assert.ok(page.body.intents.length >= 1 && page.body.intents.length <= 2);
      for (const it of page.body.intents) {
        seen.push(it.id);
        assert.ok(Array.isArray(it.state_history) && it.state_history.length >= 1, "include_history 应带回状态历史");
      }
      if (!page.body.has_more) {
        assert.equal(page.body.next_cursor, null);
        break;
      }
      cursor = page.body.next_cursor;
      assert.ok(cursor);
    }
    assert.equal(seen.length, 5, "分页取全 5 条，不静默截断");
    assert.equal(new Set(seen).size, 5, "游标不重复不漏");
    // priority_min 过滤
    const hi = await call(s.base, "GET", `/sorne/intents?project_id=${project.id}&priority_min=3`);
    assert.equal(hi.body.intents.length, 3);
    // 状态过滤（proposed 5 条）
    const proposed = await call(s.base, "GET", `/sorne/intents?project_id=${project.id}&status=proposed`);
    assert.equal(proposed.body.intents.length, 5);
  }));

/* ── 11. 鉴权（蓝图 §8.2） ────────────────────────────────────────── */

test("鉴权：POST /plan-revisions 无会话或非 planner 会话 → 403；GET /intents 跨项目会话 → 403；缺 project_id → 400", () =>
  withServer(async (s) => {
    const projectA = await createProject(s.base, { name: "项目A" });
    // 注：projectB 不带初始范围（A1 createProject 的 scope_revisions.id 为项目内序列编号
    // 形态 "SR-000N"，同库第二个带范围项目会触发跨项目主键冲突——A1 既有缺陷，见竣工记录；
    // 本用例只需 B 项目存在，无需范围）。
    const projectB = await createProject(s.base, { name: "项目B", withScope: false });

    const noSession = await call(s.base, "POST", "/sorne/plan-revisions", {
      body: { submission_id: "X", plan_revision: "r1", intents: [] },
    });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.body.code, "TRUST_DENIED");

    const worker = await call(s.base, "POST", "/sorne/plan-revisions", {
      body: { submission_id: "X", plan_revision: "r1", intents: [] },
      session: workerSession(projectA.id),
    });
    assert.equal(worker.status, 403);
    assert.equal(worker.body.code, "TRUST_DENIED");

    const orchestrator = await call(s.base, "POST", "/sorne/plan-revisions", {
      body: { submission_id: "X", plan_revision: "r1", intents: [] },
      session: issueSession({ project_id: projectA.id, actor: "o1", role: "orchestrator" }),
    });
    assert.equal(orchestrator.status, 403);

    // 跨项目读：B 项目的 worker 会话读 A 项目 → 403
    const cross = await call(s.base, "GET", `/sorne/intents?project_id=${projectA.id}`, {
      session: workerSession(projectB.id),
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");

    // user 面无 project_id → 400
    const missing = await call(s.base, "GET", "/sorne/intents");
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "BAD_REQUEST");

    // planner 会话读自己绑定的项目（无 query）→ 200
    const viaSession = await call(s.base, "GET", "/sorne/intents", { session: plannerSession(projectA.id) });
    assert.equal(viaSession.status, 200);
    assert.equal(viaSession.body.project_id, projectA.id);
  }));

/* ── 12. 重启故障注入（数据库成功但 HTTP 回执丢失 → 同 submission_id 恢复） ── */

test("重启注入：接收成功后进程退出 → 重启后同 submission_id 恢复原回执，不重复建意图或事件", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sorne-c1-restart-"));
  try {
    // 第一段进程：接收计划成功即退出（响应视作丢失）
    const s1 = await bootServer(dataDir);
    const created1 = await call(s1.base, "POST", "/sorne/projects", {
      body: { name: "重启项目", scope_rules: { allow: ["*.test"], deny: [], pending: [] } },
    });
    const project = created1.body.project;
    const envelope = {
      submission_id: "PLAN-RESTART-1",
      plan_revision: "r1",
      intents: [createIntentItem({ local_ref: "i", question: "重启后还在吗？", kind: "collect", success_criteria: "回答" })],
    };
    const first = await call(s1.base, "POST", "/sorne/plan-revisions", {
      body: envelope,
      session: issueSession({ project_id: project.id, actor: "planner-1", role: "planner" }),
    });
    assert.equal(first.status, 200);
    await s1.close();
    await closeStore({ dataDir }); // 释放句柄 = 进程退出的存储面

    // 第二段进程：同 actor 新会话（进程内会话注册表已随进程消失）重发同一计划
    const s2 = await bootServer(dataDir);
    const second = await call(s2.base, "POST", "/sorne/plan-revisions", {
      body: envelope,
      session: issueSession({ project_id: project.id, actor: "planner-1", role: "planner" }),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body, "重启后应按幂等规则恢复原回执");
    await s2.close();
    await closeStore({ dataDir });

    // 校验库内唯一性
    const store = await getStore({ dataDir });
    const db = store.db;
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM intents WHERE project_id = ?").get(project.id).c, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'plan.received'").get(project.id).c,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE project_id = ? AND id = ?").get(project.id, "PLAN-RESTART-1").c,
      1,
    );
    await closeStore({ dataDir });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
