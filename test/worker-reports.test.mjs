/**
 * E2 —— Worker 分层汇报服务测试（规范 §18.3 §18.4 §18.5；蓝图 §7 场景 26/27/28/31 主责）。
 *
 * 覆盖蓝图 §7 中 E2 主责场景：
 *   - #26 worker 汇报遗漏本次新增漏洞 → 覆盖检查退回或要求列明（§18.4）；
 *     变体：待验证假设 / 状态撤回 / 阻塞（C2 #25 blocked 行）/ unknown 工具调用；
 *   - #27 摘要把疑似漏洞写为已确认 → 状态以库为准，阻止升级并要求修正（§18.4 末段）；
 *   - #28 一批重要发现超出摘要预算 → 显式分组分页，全部可查，不静默截断（§18.3 末段）；
 *   - #31 新汇报依赖已不在上下文的旧汇报 → 按 base_report 读取基线（§18.6）。
 * 另覆盖：三层读取（§18.3 表）、source_manifest/commit_boundary 时效（§18.3）、
 * 幂等与重复投递不重复落库/发事件（§18.5 末段）、引用有效性（§18.4）、
 * completion 不改意图/尝试状态（§18.3）、鉴权面（蓝图 §8.2）、事件同事务（§2 约束 10）、
 * C2 #25 进展行共存读取、boundary 后增量时效提示。
 *
 * 真实注入（§20.3 末段）：事务原子性经真实 SQLite TRIGGER RAISE(ABORT) 注入；
 * 重启经真实「关库关服→同目录重启→重签会话」。不使用 mock 替代事务与恢复。
 * 业务数据全部经真实端点建立：A1 #4/#10（项目/统一提交）、C1 #20（意图）、
 * C2 #22/#25/#26（Attempt/进展/工具调用）；唯一例外：撤回态 Fact 行经夹具直写
 * （facts 表当前无业务写入方能产生 retracted/superseded 终态，D2 夹具直写先例，
 * 见用例内注释）。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（bootServer）、finally 关服关库删目录，
 * 不留后台进程、不触碰 ~/.sorne。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 服务器与夹具（D1 同法） ───────────────────────────────────────── */

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
    apply({ webServer: { register: (o) => (registered.push(o), () => {}) }, logger: QUIET, effect: (fn) => fn() });
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
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function withServer(fn) {
  const dataDir = makeTempDir("sorne-e2-rep-");
  const s = await bootServer(dataDir);
  try {
    return await fn({ ...s, dataDir });
  } finally {
    await s.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 重启演练：关服 + 关库（不删目录）→ 同目录重启（模拟进程退出再拉起）。 */
async function withRestartServer(fn) {
  const dataDir = makeTempDir("sorne-e2-restart-");
  const s1 = await bootServer(dataDir);
  try {
    const phase1 = await fn({ ...s1, dataDir, phase: 1 });
    await s1.close();
    await closeStore({ dataDir });
    const s2 = await bootServer(dataDir);
    try {
      const phase2 = await fn({ ...s2, dataDir, phase: 2 });
      return [phase1, phase2];
    } finally {
      await s2.close();
      await closeStore({ dataDir });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

let counter = 0;
const sid = (p) => `${p}-${Date.now()}-${counter++}`;

async function createProject(base, name = "E2 分层汇报测试", { withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: { name, ...(withScope ? { scope_rules: { allow: ["*.example.test"], deny: [], pending: [] } } : {}) },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

const workerSession = (projectId, actor = "w-1") =>
  issueSession({ project_id: projectId, actor, role: "worker" });
const plannerSession = (projectId, actor = "p-1") =>
  issueSession({ project_id: projectId, actor, role: "planner" });
const runtimeSession = (projectId, actor = "rt-1") =>
  issueSession({ project_id: projectId, actor, role: "runtime" });
const orchestratorSession = (projectId, actor = "o-1") =>
  issueSession({ project_id: projectId, actor, role: "orchestrator" });
const verifierSession = (projectId, actor = "v-1") =>
  issueSession({ project_id: projectId, actor, role: "verifier" });

/** 经 C1 #20 建立意图（真实计划接收管线）。 */
async function createIntent(base, projectId, question = "确认登录相关入口？") {
  const res = await call(base, "POST", "/sorne/plan-revisions", {
    body: {
      submission_id: sid("E2PLAN"),
      plan_revision: `r-${counter}`,
      intents: [{ op: "create", local_ref: "i", question, kind: "investigate", success_criteria: "给出回答或明确缺口" }],
    },
    session: plannerSession(projectId),
  });
  assert.equal(res.status, 200, `建立意图失败：${JSON.stringify(res.body)}`);
  return res.body.ids.i;
}

/** 经 C2 #22 派发 Attempt（runtime 会话；worker_id 与 worker 会话 actor 一致）。 */
async function createAttempt(base, projectId, intentId, workerActor = "w-1") {
  const res = await call(base, "POST", "/sorne/attempts", {
    body: { intent_id: intentId, worker_id: workerActor },
    session: runtimeSession(projectId),
  });
  assert.equal(res.status, 200, `派发失败：${JSON.stringify(res.body)}`);
  return { attemptId: res.body.attempt.id, fencingToken: res.body.fencing_token };
}

/** 经 A1 #10 由 worker 提交真实发现（漏洞 + 观察 + 假设），返回正式 ID。 */
async function seedFindings(base, worker, { withVuln = true, withHypothesis = true, withObservation = true } = {}) {
  const operations = [
    { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: `target-${counter}.example.test` },
  ];
  if (withVuln) {
    operations.push({ op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "sql-injection", conditions: ["未登录身份"], location: "/api/login" });
  }
  if (withObservation) {
    operations.push({ op: "append_observation", local_ref: "o", statement: "登录接口对单引号返回 500", conditions: ["未登录身份"] });
  }
  if (withHypothesis) {
    operations.push({ op: "propose_hypothesis", local_ref: "h", statement: "输入可能影响后端查询", conditions: ["未登录身份"] });
  }
  if (withVuln && withObservation) {
    operations.push({ op: "add_relation", from: "o", type: "supports", to: "v" });
  }
  const res = await call(base, "POST", "/sorne/submissions", {
    body: { submission_id: sid("E2FIND"), attempt_id: null, operations },
    session: worker,
  });
  assert.equal(res.status, 200, `提交发现失败：${JSON.stringify(res.body)}`);
  return res.body.ids;
}

/** 真实工具调用到 unknown（C2 #26：register → start → mark_unknown）。 */
async function seedUnknownToolCall(base, worker, attemptId, fencingToken) {
  const reg = await call(base, "POST", "/sorne/tool-calls", {
    body: { action: "register", attempt_id: attemptId, tool_name: "http.fetch", fencing_token: fencingToken, args: { url: "https://target.example.test/api/login" } },
    session: worker,
  });
  assert.equal(reg.status, 200, `工具登记失败：${JSON.stringify(reg.body)}`);
  const tcId = reg.body.tool_call.id;
  const start = await call(base, "POST", "/sorne/tool-calls", {
    body: { action: "start", attempt_id: attemptId, tool_call_id: tcId, fencing_token: fencingToken },
    session: worker,
  });
  assert.equal(start.status, 200, `工具启动失败：${JSON.stringify(start.body)}`);
  const unk = await call(base, "POST", "/sorne/tool-calls", {
    body: { action: "mark_unknown", attempt_id: attemptId, tool_call_id: tcId, fencing_token: fencingToken, reason: "进程中断，无法判断外部操作是否已完成" },
    session: worker,
  });
  assert.equal(unk.status, 200, `标记 unknown 失败：${JSON.stringify(unk.body)}`);
  return tcId;
}

/** 基础汇报载荷（可覆盖）。 */
function reportBody(attemptId, overrides = {}) {
  return {
    submission_id: sid("E2REP"),
    attempt_id: attemptId,
    kind: "handoff",
    actual_outcome: "查看页面及关联 JS，确认两个调用入口",
    important_findings: [],
    material_conditions: [{ note: "观察来自未登录状态，不能推广到其他身份" }],
    contradictions: [],
    significant_attempts: [],
    unresolved_questions: [],
    blockers: [],
    proposed_next_actions: ["补充登录后身份条件下的信息"],
    ...overrides,
  };
}

async function countRows(dataDir, sql, ...args) {
  const store = await getStore({ dataDir });
  return store.db.prepare(sql).get(...args).c;
}

/* ── 场景 26：覆盖检查退回或要求列明 ─────────────────────────────── */

test("场景26主路径：汇报遗漏本次新增漏洞 → 覆盖检查退回；补列交接卡或显式清单后放行", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const vulnId = ids.v;
    const hyId = ids.h;

    // 遗漏 → 退回（不落任何行、不发事件、不留幂等占位）
    const missBody = reportBody(attemptId, { important_findings: [] });
    const missing = await call(base, "POST", "/sorne/worker-reports", { body: missBody, session: worker });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.code, "PRECONDITION_INVALID");
    assert.ok(missing.body.detail.missing.some((g) => g.type === "new_vulnerability" && g.record_id === vulnId),
      `missing 应含新漏洞 ${vulnId}：${JSON.stringify(missing.body.detail.missing)}`);
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", project.id), 0);
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM submissions WHERE project_id = ? AND id = ?", project.id, missBody.submission_id), 0);

    // 路径一：列入交接卡（状态以库为准）
    const fixed = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [
          { record_id: vulnId, type: "Vulnerability", current_status: "suspected", short_statement: "已建立疑似漏洞记录，等待独立验证" },
          { record_id: hyId, type: "Hypothesis", current_status: "open", short_statement: "待验证假设" },
        ],
      }),
      session: worker,
    });
    assert.equal(fixed.status, 200, `补列后被拒：${JSON.stringify(fixed.body)}`);
    assert.equal(fixed.body.coverage_checked, true);
    assert.match(fixed.body.report_id, /^WR-/);

    // 路径二：显式分类清单（漏洞与待验证线索分别列明，read_pointer 指向读取入口）
    const intent2 = await createIntent(base, project.id, "第二意图？");
    const att2 = await createAttempt(base, project.id, intent2);
    const ids2 = await seedFindings(base, worker);
    const omitted = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(att2.attemptId, {
        omitted_sections: [
          { type: "vulnerabilities", count: 1, read_pointer: `/sorne/records/${ids2.v}?project_id=${project.id}` },
          { type: "pending_leads", count: 1, read_pointer: `/sorne/records/${ids2.h}?project_id=${project.id}` },
        ],
      }),
      session: worker,
    });
    assert.equal(omitted.status, 200, `显式清单路径被拒：${JSON.stringify(omitted.body)}`);
    assert.ok(omitted.body.manifest_counts.judgement_records >= 2);
  }));

test("场景26变体：待验证假设遗漏 → 退回；unresolved/关键发现引用后放行", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker); // h: open 假设
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId),
      session: worker,
    });
    assert.equal(res.status, 422);
    const kinds = res.body.detail.missing.map((g) => g.type);
    assert.ok(kinds.includes("pending_hypothesis"), `应要求列明待验证假设：${JSON.stringify(kinds)}`);
    assert.ok(res.body.detail.missing.some((g) => g.record_id === ids.h));
    const fixed = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [{ record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞已建档" }],
        unresolved_questions: [{ ref: ids.h, question: "另一接口的访问限制可能异常，尚未验证" }],
      }),
      session: worker,
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  }));

test("场景26变体：unknown 工具调用遗漏 → 退回；significant_attempts 引用后放行（真实 #26 管线）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId, fencingToken } = await createAttempt(base, project.id, intentId);
    const tcId = await seedUnknownToolCall(base, worker, attemptId, fencingToken);
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId),
      session: worker,
    });
    assert.equal(res.status, 422);
    assert.ok(
      res.body.detail.missing.some((g) => g.type === "unknown_tool_call" && g.record_id === tcId),
      `missing 应含 unknown 调用 ${tcId}：${JSON.stringify(res.body.detail.missing)}`,
    );
    const fixed = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        significant_attempts: [{ tool_call_id: tcId, summary: "进程中断，结果未知；须先核查现状再决定重试，不视作恰好一次" }],
        unresolved_questions: [{ ref: tcId, question: "该调用外部效果是否已发生？" }],
      }),
      session: worker,
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.manifest_counts.unknown_tool_calls, 1);
  }));

test("场景26变体：C2 #25 blocked 进展行遗漏 → 退回；blockers 引用后放行；kind=blocked 汇报自身承载阻塞语义", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const blocked = await call(base, "POST", `/sorne/attempts/${attemptId}/progress`, {
      body: { kind: "blocked", note: "缺少登录后的调用信息" },
      session: worker,
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    const blockedReportId = blocked.body.report_id;

    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId),
      session: worker,
    });
    assert.equal(res.status, 422);
    assert.ok(
      res.body.detail.missing.some((g) => g.type === "blocker" && g.record_id === blockedReportId),
      `missing 应含阻塞行 ${blockedReportId}：${JSON.stringify(res.body.detail.missing)}`,
    );
    const fixed = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { blockers: [{ ref: blockedReportId, reason: "缺少登录后的调用信息", needed_decision: "补充身份条件或调整意图" }] }),
      session: worker,
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));

    // kind=blocked 且 blockers 非空 → 本汇报即阻塞汇报（语义映射见竣工记录）
    const intent2 = await createIntent(base, project.id, "受阻意图？");
    const att2 = await createAttempt(base, project.id, intent2);
    const b2 = await call(base, "POST", `/sorne/attempts/${att2.attemptId}/progress`, {
      body: { kind: "blocked", note: "网络不可达" },
      session: worker,
    });
    assert.equal(b2.status, 200);
    const asBlocked = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(att2.attemptId, {
        kind: "blocked",
        blockers: [{ reason: "网络不可达", needed_decision: "等待网络条件或暂缓" }],
      }),
      session: worker,
    });
    assert.equal(asBlocked.status, 200, JSON.stringify(asBlocked.body));
  }));

test("场景26变体：状态撤回（retracted fact 与 retracts 边）遗漏 → 退回；contradictions 列出后放行", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const store = await getStore({ dataDir });
    // 先经真实 #10 推进 commit_seq（使夹具行的 created_seq 能落在 attempt 之后的
    // 已分配窗口内），再夹具直写撤回态事实与撤回边：facts 表当前无业务写入方
    // 能产生 retracted/superseded 终态（D2 record_fact 只建 verified；受控修正
    // 流程未落地，D2 夹具直写先例）
    const advance = await call(base, "POST", "/sorne/submissions", {
      body: { submission_id: sid("E2ADV"), operations: [{ op: "append_observation", local_ref: "pad", statement: "占位观察（推进提交边界）", conditions: [] }] },
      session: worker,
    });
    assert.equal(advance.status, 200, JSON.stringify(advance.body));
    const boundary = store.db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project.id).n - 1;
    const factId = `F-${project.id}-9001`;
    store.runSerial((db) => {
      db.prepare(
        `INSERT INTO facts (id, project_id, statement, conditions, status, verification_refs, created_at, created_by, created_seq, updated_seq, state_version, claim_revision, evidence_revision, assessment_epoch)
         VALUES (?, ?, '旧版本指纹判断', '[]', 'retracted', '[]', ?, 'w-1', ?, 0, 1, 1, 1, 1)`,
      ).run(factId, project.id, new Date().toISOString(), boundary);
      db.prepare(
        `INSERT INTO relations (id, project_id, from_id, to_id, relation_type, conditions, requires_state, source, valid_from_seq, created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, 'retracts', '', '', 'fixture', 0, ?, 'w-1', ?)`,
      ).run(`R-${project.id}-9001`, project.id, factId, factId, new Date().toISOString(), boundary);
    });
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId),
      session: worker,
    });
    assert.equal(res.status, 422);
    const retractions = res.body.detail.missing.filter((g) => g.type === "retraction");
    assert.ok(retractions.length >= 2, `应要求列明撤回事实与撤回边：${JSON.stringify(res.body.detail.missing)}`);
    const fixed = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        contradictions: [{ record_id: factId, statement: "旧版本指纹判断已被撤回，不再作为依据" }],
        prerequisite_changes: [{ ref: `R-${project.id}-9001`, change: "撤回边", impact: "依赖该判断的方向需重评估" }],
      }),
      session: worker,
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  }));

/* ── 场景 27：状态以库为准 ───────────────────────────────────────── */

test("场景27：摘要把疑似漏洞写成已确认 → 提交被拒并要求修正；读取面状态取库当前值", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);

    const upgraded = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [{ record_id: ids.v, type: "Vulnerability", current_status: "confirmed", short_statement: "（错误升级）已确认 SQL 注入" }],
      }),
      session: worker,
    });
    assert.equal(upgraded.status, 422);
    assert.equal(upgraded.body.code, "STALE_STATE");
    assert.equal(upgraded.body.detail.db_status, "suspected");
    assert.equal(upgraded.body.detail.declared_status, "confirmed");
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", project.id), 0);

    const honest = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞已建档，等待独立验证" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "输入可能影响后端查询" },
        ],
      }),
      session: worker,
    });
    assert.equal(honest.status, 200, JSON.stringify(honest.body));
    const reportId = honest.body.report_id;

    // 读取面：状态以数据库当前值为准（提交后库状态演进由验证流程驱动，此处直改
    // 库模拟演进——facts/vuln 状态推进归 D1/D2 状态机，E2 只读取）
    const store = await getStore({ dataDir });
    store.runSerial((db) => {
      db.prepare("UPDATE vulnerabilities SET status = 'confirmed', confirmed_version = '{\"via\":\"fixture-evolution\"}' WHERE id = ?").run(ids.v);
    });
    const key = await call(base, "GET", `/sorne/worker-reports/${reportId}?layer=key_records`, { session: orchestratorSession(project.id) });
    assert.equal(key.status, 200);
    const finding = key.body.key_records.important_findings.find((f) => f.record_id === ids.v);
    assert.equal(finding.db.status, "confirmed");
    assert.equal(finding.current_status, "suspected");
    assert.match(finding.status_note, /数据库为准/);
    const card = await call(base, "GET", `/sorne/worker-reports/${reportId}`, { session: orchestratorSession(project.id) });
    assert.equal(card.status, 200);
    const line = card.body.handoff_card.groups.flatMap((g) => g.lines).find((l) => l.includes(ids.v));
    assert.ok(line.includes("confirmed"), `交接卡渲染应使用库当前状态：${line}`);
    assert.ok(!line.includes("状态 suspected"), "渲染不得沿用提交时声明状态");
  }));

test("类型声明与编号不符 → BAD_REQUEST（§18.3 必须注明对象类型且与持久记录一致）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker, { withVuln: true, withHypothesis: false });
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [{ record_id: ids.v, type: "Observation", current_status: "suspected", short_statement: "类型标错" }],
      }),
      session: worker,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "BAD_REQUEST");
    assert.equal(res.body.detail.db_type, "Vulnerability");
  }));

/* ── 场景 28：交接卡预算（分组分页，不静默截断） ─────────────────── */

test("场景28：一批重要发现超出摘要预算 → 显式分组分页、全部可查、不删不确定性", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    // 一批待验证假设（30 条，hypotheses 有状态列；真实 #10 管线，一个信封多操作）
    const hypOps = [];
    for (let i = 1; i <= 30; i++) {
      hypOps.push({ op: "propose_hypothesis", local_ref: `h${i}`, statement: `假设 ${i}：入口-${i} 的访问限制可能异常`, conditions: ["未登录身份"] });
    }
    const sub = await call(base, "POST", "/sorne/submissions", {
      body: { submission_id: sid("E2BATCH"), operations: hypOps },
      session: worker,
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const findings = hypOps.map((op, i) => ({
      record_id: sub.body.ids[op.local_ref],
      type: "Hypothesis",
      current_status: "open",
      short_statement: `假设 ${i + 1} 待验证：入口-${i + 1} 访问限制可能异常`,
    }));
    const submit = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: findings,
        material_conditions: [
          { note: "全部观察来自未登录状态，不能推广到其他身份" },
          { note: "两次请求因网络超时失败，不能据此认定接口不存在" },
        ],
        contradictions: [{ note: "样本 5 与样本 7 的指纹结论相互矛盾，尚未裁定" }],
      }),
      session: worker,
    });
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    const reportId = submit.body.report_id;
    const orchestrator = orchestratorSession(project.id);

    // 预算压缩（500 = 允许下限）触发分页：分组分页，逐页取尽
    let page = 1;
    const allLines = [];
    let last = null;
    for (let guard = 0; guard < 60; guard++) {
      const res = await call(base, "GET", `/sorne/worker-reports/${reportId}?page=${page}&budget=500`, { session: orchestrator });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const card = res.body.handoff_card;
      allLines.push(...card.groups.flatMap((g) => g.lines));
      last = res.body;
      if (!card.has_more) break;
      assert.ok(card.omitted_from_this_page.length >= 1, "未包含完的页必须带显式 omitted 清单与 read_pointer");
      assert.ok(card.omitted_from_this_page[0].count >= 1);
      assert.match(card.omitted_from_this_page[0].read_pointer, /layer=handoff_card&page=\d+/);
      page = card.next_page;
    }
    assert.equal(last.handoff_card.has_more, false);
    // 全部可查：30 条假设每条完整语句都出现在某页（不静默截断）
    for (let i = 1; i <= 30; i++) {
      const needle = `假设 ${i} 待验证：入口-${i} 访问限制可能异常`;
      assert.ok(allLines.some((l) => l.includes(needle)), `第 ${i} 条发现被静默截断`);
    }
    // 不删不确定性：条件与矛盾必须完整出现在全部页的并集中
    assert.ok(allLines.some((l) => l.includes("不能推广到其他身份")));
    assert.ok(allLines.some((l) => l.includes("不能据此认定接口不存在")));
    assert.ok(allLines.some((l) => l.includes("尚未裁定")));

    // 预算可配置：调大预算后单页容纳更多内容
    const big = await call(base, "GET", `/sorne/worker-reports/${reportId}?budget=20000`, { session: orchestrator });
    assert.equal(big.status, 200);
    assert.ok(big.body.handoff_card.total_pages <= last.handoff_card.total_pages);
    assert.ok(big.body.handoff_card.used_chars > last.handoff_card.used_chars);
    const badBudget = await call(base, "GET", `/sorne/worker-reports/${reportId}?budget=10`, { session: orchestrator });
    assert.equal(badBudget.status, 400);
  }));

/* ── 场景 31：base_report 基线 ───────────────────────────────────── */

test("场景31：新汇报依赖已不在上下文的旧汇报 → base_report 校验、相对变化与基线全文可读", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const first = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        kind: "progress",
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞建档" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "待验证假设" },
        ],
      }),
      session: worker,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const ids2 = await seedFindings(base, worker);
    const second = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        base_report_id: first.body.report_id,
        important_findings: [
          { record_id: ids2.v, type: "Vulnerability", current_status: "suspected", short_statement: "新一批疑似漏洞" },
          { record_id: ids2.h, type: "Hypothesis", current_status: "open", short_statement: "新一批待验证假设" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "沿用待验证假设" },
        ],
      }),
      session: worker,
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    // §18.6 增量语义：被基线覆盖的第一批漏洞（ids.v）不列入本汇报也不被重复要求
    // ——带 base 的汇报覆盖窗口收缩到基线 boundary（v1 归因规则）；unknown/blocked
    // 等持续未决状态不收缩（§18.4 必须保留清单），由其他用例覆盖。

    const view = await call(base, "GET", `/sorne/worker-reports/${second.body.report_id}?layer=key_records&include_base=1`, {
      session: orchestratorSession(project.id),
    });
    assert.equal(view.status, 200);
    assert.equal(view.body.relative_to_base.base_report_id, first.body.report_id);
    assert.ok(view.body.relative_to_base.new_record_ids.includes(ids2.v));
    assert.ok(!view.body.relative_to_base.new_record_ids.includes(ids.h));
    assert.ok(view.body.relative_to_base.dropped_record_ids.includes(ids.v));
    assert.equal(view.body.base_report.report_id, first.body.report_id);
    assert.equal(view.body.base_report.handling_status, "pending");
    assert.ok(view.body.base_report.important_findings.some((f) => f.record_id === ids.v));
    assert.match(view.body.relative_to_base.base_read_pointer, /layer=key_records/);

    // 基线编号幽灵 → INVALID_REFERENCE
    const ghost = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { base_report_id: "WR-XXXX-9999", important_findings: [{ record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "x" }] }),
      session: worker,
    });
    assert.equal(ghost.status, 422);
    assert.equal(ghost.body.code, "INVALID_REFERENCE");
  }));

/* ── 幂等与事件（§18.5 末段；§2 约束 10） ────────────────────────── */

test("重复投递：同 submission_id 原样重交 → 原回执；不重复落库、不重复发事件、不重复产生调度效果", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const body = reportBody(attemptId, {
      important_findings: [
        { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞" },
        { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "待验证" },
      ],
    });
    const first = await call(base, "POST", "/sorne/worker-reports", { body, session: worker });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const retry = await call(base, "POST", "/sorne/worker-reports", { body, session: worker });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.report_id, first.body.report_id);
    assert.equal(retry.body.commit_seq, first.body.commit_seq);
    assert.equal(retry.body.idempotent, true);
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", project.id), 1);
    assert.equal(
      await countRows(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'worker_report.submitted'", project.id),
      1,
      "同一汇报重复投递不得重复发 worker_report.submitted 事件",
    );
    const attemptsBefore = await countRows(dataDir, "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?", project.id);
    await call(base, "POST", "/sorne/worker-reports", { body, session: worker });
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?", project.id), attemptsBefore, "重复投递不得重复创建执行分配");

    const reused = await call(base, "POST", "/sorne/worker-reports", {
      body: { ...body, actual_outcome: "改了内容" },
      session: worker,
    });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.code, "IDEMPOTENCY_KEY_REUSED");
  }));

test("事件同事务：提交成功 → worker_report.submitted 落 Outbox（payload 含 covered_record_ids 供按记录去重）", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId, fencingToken } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const tcId = await seedUnknownToolCall(base, worker, attemptId, fencingToken);
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "待验证" },
        ],
        significant_attempts: [{ tool_call_id: tcId, summary: "结果未知，需先核查" }],
        unresolved_questions: [{ ref: tcId, question: "外部效果是否发生？" }],
      }),
      session: worker,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const store = await getStore({ dataDir });
    const events = store.db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'worker_report.submitted'")
      .all(project.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].commit_seq, res.body.commit_seq);
    const payload = JSON.parse(events[0].payload);
    assert.ok(payload.covered_record_ids.includes(ids.v));
    assert.ok(payload.covered_record_ids.includes(tcId), "unknown 调用编号进 payload，消费端按记录 ID 去重通知效果（§18.5 末段）");
    assert.equal(payload.source_manifest_id, res.body.source_manifest_id);
    assert.equal(payload.kind, "handoff");
  }));

/* ── 引用有效性与时效（§18.4/§18.3） ─────────────────────────────── */

test("引用有效性：幽灵 record_id / evidence_refs → INVALID_REFERENCE", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ghostFinding = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [{ record_id: "V-9999", type: "Vulnerability", current_status: "suspected", short_statement: "幽灵" }],
      }),
      session: worker,
    });
    assert.equal(ghostFinding.status, 422);
    assert.equal(ghostFinding.body.code, "INVALID_REFERENCE");
    const ghostEvidence = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { evidence_refs: ["CAP-9999"] }),
      session: worker,
    });
    assert.equal(ghostEvidence.status, 422);
    assert.equal(ghostEvidence.body.code, "INVALID_REFERENCE");
  }));

test("时效：boundary 声明未来 → 400；老 boundary + 其后已有新记录 → 放行并附增量提示", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const future = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { source_commit_boundary: 999999 }),
      session: worker,
    });
    assert.equal(future.status, 400);
    assert.equal(future.body.code, "BAD_REQUEST");

    // 老边界（发现提交之前）→ 汇报有效 + 增量提示
    const store = await getStore({ dataDir });
    const boundaryThen = store.db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project.id).n - 1;
    assert.ok(boundaryThen >= 1);
    const ids = await seedFindings(base, worker);
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        source_commit_boundary: boundaryThen,
        omitted_sections: [
          { type: "vulnerabilities", count: 1, read_pointer: `/sorne/records/${ids.v}?project_id=${project.id}` },
          { type: "pending_leads", count: 1, read_pointer: `/sorne/records/${ids.h}?project_id=${project.id}` },
        ],
      }),
      session: worker,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.newer_records_since_boundary >= 1, "老边界之后的记录数应在回执提示");
    assert.ok(res.body.warnings.some((w) => /增量通知覆盖/.test(w)));
    const view = await call(base, "GET", `/sorne/worker-reports/${res.body.report_id}`, { session: orchestratorSession(project.id) });
    assert.equal(view.body.boundary.source_commit_boundary, boundaryThen);
    assert.ok(typeof view.body.boundary.latest_commit_seq === "number");
  }));

/* ── 三层读取（§18.3 表）与 completion 边界 ──────────────────────── */

test("三层读取：handoff_card 默认 / key_records 展开 / full_basis 完整依据与读取入口", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId, fencingToken } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const tcId = await seedUnknownToolCall(base, worker, attemptId, fencingToken);
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        kind: "handoff",
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞等待验证" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "待验证假设" },
        ],
        significant_attempts: [{ tool_call_id: tcId, summary: "unknown 调用" }],
        unresolved_questions: [{ ref: tcId, question: "外部效果？" }],
        evidence_refs: [ids.o ?? ids.v],
      }),
      session: worker,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const reportId = res.body.report_id;
    const orch = orchestratorSession(project.id);

    const card = await call(base, "GET", `/sorne/worker-reports/${reportId}`, { session: orch });
    assert.equal(card.body.layer, "handoff_card");
    assert.ok(card.body.handoff_card.groups.some((g) => g.type === "important_findings"));
    assert.match(card.body.handoff_card.ai_note, /建议/);

    const key = await call(base, "GET", `/sorne/worker-reports/${reportId}?layer=key_records`, { session: orch });
    assert.equal(key.status, 200);
    assert.equal(key.body.key_records.important_findings.length, 2);
    assert.ok(key.body.key_records.proposed_next_actions.every((a) => a.ai_advice === true), "AI 建议单独标注（§18.4）");
    assert.match(key.body.key_records.expand_pointer, /full_basis/);

    const full = await call(base, "GET", `/sorne/worker-reports/${reportId}?layer=full_basis`, { session: orch });
    assert.equal(full.status, 200);
    const manifest = full.body.full_basis.manifest;
    assert.equal(manifest.id, res.body.source_manifest_id);
    assert.ok(manifest.judgement_records.some((j) => j.id === ids.v));
    assert.ok(manifest.tool_calls.some((t) => t.id === tcId && t.status === "unknown"));
    const vulnEntry = manifest.judgement_records.find((j) => j.id === ids.v);
    assert.match(vulnEntry.read_pointer, /\/sorne\/records\//);
    const badLayer = await call(base, "GET", `/sorne/worker-reports/${reportId}?layer=nope`, { session: orch });
    assert.equal(badLayer.status, 400);
  }));

test("completion 仅表示本次执行完成汇报：不改意图与尝试状态（§18.3；完成判定归 C1/C2）", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const res = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { kind: "completion", actual_outcome: "两个入口确认完毕" }),
      session: worker,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const store = await getStore({ dataDir });
    const intent = store.db.prepare("SELECT status FROM intents WHERE id = ?").get(intentId);
    const attempt = store.db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId);
    assert.equal(intent.status, "proposed", "汇报不得改意图状态");
    assert.notEqual(attempt.status, "completed", "Attempt 终结归 C2 #25 完成建议，E2 汇报不重复触发");
    assert.equal(res.body.kind, "completion");
  }));

test("C2 #25 进展行共存：GET 可读且显式标注为执行进展记录（非分层汇报）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const prog = await call(base, "POST", `/sorne/attempts/${attemptId}/progress`, {
      body: { kind: "progress", note: "已确认两个入口" },
      session: worker,
    });
    assert.equal(prog.status, 200);
    const view = await call(base, "GET", `/sorne/worker-reports/${prog.body.report_id}?project_id=${project.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.source, "attempt_progress");
    assert.match(view.body.note, /执行进展记录/);
  }));

/* ── 事务原子性注入（§20.3 末段：真实 SQLite TRIGGER） ───────────── */

test("事务原子性注入（真实 SQLite TRIGGER RAISE）：汇报写入点失败 → 整体回滚，无半状态", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const store = await getStore({ dataDir });
    await store.runSerial((db) => {
      db.exec(
        "CREATE TRIGGER inject_reports_fail BEFORE INSERT ON worker_reports BEGIN SELECT RAISE(ABORT, '注入：汇报写入失败'); END",
      );
    });
    const submissionId = reportBody(attemptId).submission_id;
    try {
      const res = await call(base, "POST", "/sorne/worker-reports", {
        body: reportBody(attemptId, {
          important_findings: [
            { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "x" },
            { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "y" },
          ],
        }),
        session: worker,
      });
      assert.equal(res.status, 500);
      assert.match(res.body.message, /注入/);
      assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", project.id), 0);
      assert.equal(
        await countRows(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'worker_report.submitted'", project.id),
        0,
      );
      assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM submissions WHERE project_id = ? AND id = ?", project.id, submissionId), 0, "失败提交不得留下幂等占位（回滚后同 ID 可重交）");
    } finally {
      await store.runSerial((db) => db.exec("DROP TRIGGER inject_reports_fail"));
    }
    // 触发器移除后，同一 submission_id 重交成功（原子回滚未污染幂等域）
    const again = await call(base, "POST", "/sorne/worker-reports", {
      body: {
        submission_id: submissionId,
        attempt_id: attemptId,
        kind: "handoff",
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "x" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "y" },
        ],
      },
      session: worker,
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  }));

/* ── 重启注入（§20.3 末段：真实关库关服→同目录重启） ─────────────── */

test("重启注入：汇报与幂等状态持久 → 重启后可读、重交回原回执", () => {
  let saved = null;
  return withRestartServer(async ({ base, dataDir, phase }) => {
    if (phase === 1) {
      const project = await createProject(base);
      const worker = workerSession(project.id);
      const intentId = await createIntent(base, project.id);
      const { attemptId } = await createAttempt(base, project.id, intentId);
      const ids = await seedFindings(base, worker);
      const body = reportBody(attemptId, {
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "疑似漏洞" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "待验证" },
        ],
      });
      const res = await call(base, "POST", "/sorne/worker-reports", { body, session: worker });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      saved = { projectId: project.id, reportId: res.body.report_id, receipt: res.body, body };
      return;
    }
    const { projectId, reportId, receipt, body } = saved;
    // 会话为进程内注册表：重启后由运行时重签（蓝图 §14 风险 3 / A1 竣工偏差 7）
    const worker = workerSession(projectId);
    const orch = orchestratorSession(projectId);
    const view = await call(base, "GET", `/sorne/worker-reports/${reportId}?layer=key_records`, { session: orch });
    assert.equal(view.status, 200, "重启后汇报仍可读（持久对象独立于会话，§1）");
    assert.equal(view.body.report_id, reportId);
    assert.equal(view.body.handling_status, "pending");
    const retry = await call(base, "POST", "/sorne/worker-reports", { body, session: worker });
    assert.equal(retry.status, 200, "重启后同 submission_id 重交返回原回执（幂等状态持久）");
    assert.equal(retry.body.report_id, reportId);
    assert.equal(retry.body.commit_seq, receipt.commit_seq);
    assert.equal(retry.body.result_hash, receipt.result_hash);
    const count = await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", projectId);
    assert.equal(count, 1, "重启后重复投递仍不重复落库");
  });
});

/* ── 鉴权与访问域（蓝图 §8.2；§11.2） ────────────────────────────── */

test("鉴权：POST 需 worker 会话（无会话/其他角色 → 403）；worker 只能汇报本人 Attempt；GET 跨项目不泄露", () =>
  withServer(async ({ base }) => {
    const projectA = await createProject(base, "项目A");
    // 注：B 项目不带初始范围（A1 createProject 的 SR 编号为项目内序列，同库第二个
    // 带范围项目触发跨项目主键冲突——A1 既有缺陷，C1/D1 夹具同法规避）。
    const projectB = await createProject(base, "项目B", { withScope: false });
    const intentA = await createIntent(base, projectA.id);
    const attA = await createAttempt(base, projectA.id, intentA);

    const noSession = await call(base, "POST", "/sorne/worker-reports", { body: reportBody(attA.attemptId) });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.body.code, "TRUST_DENIED");
    for (const s of [orchestratorSession(projectA.id), verifierSession(projectA.id), runtimeSession(projectA.id), plannerSession(projectA.id)]) {
      const res = await call(base, "POST", "/sorne/worker-reports", { body: reportBody(attA.attemptId), session: s });
      assert.equal(res.status, 403, `角色 ${s.role} 应被拒`);
      assert.equal(res.body.code, "TRUST_DENIED");
    }
    // 非本人 Attempt（worker_id=w-1，用 w-other）
    const other = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attA.attemptId),
      session: workerSession(projectA.id, "w-other"),
    });
    assert.equal(other.status, 403);
    // 跨项目 attempt
    const cross = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attA.attemptId),
      session: workerSession(projectB.id),
    });
    assert.equal(cross.status, 422);
    assert.equal(cross.body.code, "INVALID_REFERENCE", "跨项目 Attempt 定位失败，不泄露他项目对象");

    // 正常提交后：GET 面鉴权
    const worker = workerSession(projectA.id);
    const ids = await seedFindings(base, worker);
    const ok = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attA.attemptId, {
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "v" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "h" },
        ],
      }),
      session: worker,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const crossRead = await call(base, "GET", `/sorne/worker-reports/${ok.body.report_id}`, {
      session: orchestratorSession(projectB.id),
    });
    assert.equal(crossRead.status, 404, "跨项目读取 404 不泄露存在性");
    const noProject = await call(base, "GET", `/sorne/worker-reports/${ok.body.report_id}`);
    assert.equal(noProject.status, 400);
    const wrongProject = await call(base, "GET", `/sorne/worker-reports/${ok.body.report_id}?project_id=${projectB.id}`);
    assert.equal(wrongProject.status, 404);
    const userRead = await call(base, "GET", `/sorne/worker-reports/${ok.body.report_id}?project_id=${projectA.id}`);
    assert.equal(userRead.status, 200, "无会话回环按 user 面只读");
  }));

test("replaces_report_id：幽灵 → INVALID_REFERENCE；合法修正保留旧汇报历史", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const intentId = await createIntent(base, project.id);
    const { attemptId } = await createAttempt(base, project.id, intentId);
    const ids = await seedFindings(base, worker);
    const first = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "初版" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "h" },
        ],
      }),
      session: worker,
    });
    assert.equal(first.status, 200);
    const ghost = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, { replaces_report_id: "WR-GHOST-0001" }),
      session: worker,
    });
    assert.equal(ghost.status, 422);
    assert.equal(ghost.body.code, "INVALID_REFERENCE");
    const revised = await call(base, "POST", "/sorne/worker-reports", {
      body: reportBody(attemptId, {
        replaces_report_id: first.body.report_id,
        important_findings: [
          { record_id: ids.v, type: "Vulnerability", current_status: "suspected", short_statement: "修正版：补充条件限制" },
          { record_id: ids.h, type: "Hypothesis", current_status: "open", short_statement: "h" },
        ],
      }),
      session: worker,
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(await countRows(dataDir, "SELECT COUNT(*) AS c FROM worker_reports WHERE project_id = ?", project.id), 2, "修正不删除旧汇报（保留历史）");
    const old = await call(base, "GET", `/sorne/worker-reports/${first.body.report_id}?project_id=${project.id}`);
    assert.equal(old.status, 200);
  }));
