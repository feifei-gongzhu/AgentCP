/**
 * E1 —— 协调服务与决定持久化测试（蓝图端点 #31–#36）。
 *
 * 覆盖（规范 §20.3 场景映射，蓝图 §7）：
 *   - 场景 29（主责）：读完汇报但保存决定前中断 → 汇报仍待处理，恢复后继续协调；
 *   - 场景 30（主责）：多个动作部分执行后中断 → 逐项恢复已保存决定，不重复完成动作；
 *   - 场景 32（主责）：worker 受阻但其他任务有相关信息 → 可检索、交接并恢复，
 *     不强制固定重试次数；
 *   - 场景 21/22（配合面）：无变化时程序不空转；确认漏洞可立即产生后续方向的信息面。
 *
 * 测试硬性规则（蓝图 §1.2）：独立 mkdtemp 临时目录、随机端口、finally 收尾、
 * 不留后台进程、不触碰 ~/.sorne。重启/故障用真实注入：真实关库关服再拉起、
 * 真实 SQLite 行级夹具只构造生产可达的中断状态（决定已落库、动作效果已发生
 * 但状态未回写——即委托型动作「效果提交与状态回写之间崩溃」的窗口），
 * 不用 mock 代替真实事务。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { dispatchAttempt } from "../lib/store/attempts.mjs";
import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有 HTTP 工具（helpers 为冻结文件；A1 同法） ───────────── */

async function call(base, method, path, { body, session, rawBody, contentType } = {}) {
  const headers = { origin: base };
  if (rawBody !== undefined) {
    headers["content-type"] = contentType || "application/octet-stream";
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
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

/** 重启演练服务器：显式 dataDir，close() 不删目录（模拟进程退出再拉起）。 */
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
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dataDir,
    async close() {
      await new Promise((r) => server.close(r));
      await closeStore({ dataDir });
    },
  };
}

/** withServer：真实服务器 + 临时目录；finally 关服删目录。 */
async function withServer(fn, { keepDir = false } = {}) {
  const dir = makeTempDir("sorne-orch-");
  const s = await bootServer(dir);
  try {
    return await fn(s);
  } finally {
    await s.close();
    if (!keepDir) {
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */

let subCounter = 0;
const nextSubId = (p) => `${p}-${String((subCounter += 1)).padStart(4, "0")}`;

async function createProject(base, { name = "协调测试项目", withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: {
      name,
      // 注：A1 已知缺陷——第二个带初始范围的项目会撞 scope_revisions 跨项目主键
      // （C1 竣工偏差 6 实证）；无需范围的项目按无范围创建规避（D1 先例）。
      ...(withScope
        ? { scope_rules: { allow: ["*.test", "10.0.0.0/8"], deny: [], pending: [] } }
        : {}),
    },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

const sess = (project_id, actor, role) => issueSession({ project_id, actor, role });
const plannerSession = (p, a = "planner-1") => sess(p, a, "planner");
const orchestratorSession = (p, a = "orch-1") => sess(p, a, "orchestrator");
const runtimeSession = (p, a = "runtime-1") => sess(p, a, "runtime");
const workerSessionOf = (p, a) => sess(p, a, "worker");

/** 经真实 #20 建立意图，返回 [intentId...]。 */
async function createIntents(base, projectId, items, { revision = "r1" } = {}) {
  const res = await call(base, "POST", "/sorne/plan-revisions", {
    body: {
      submission_id: nextSubId("PLAN"),
      plan_revision: revision,
      intents: items.map((it, i) => ({
        op: "create",
        local_ref: `i${i + 1}`,
        rationale: "协调测试夹具意图",
        success_criteria: "得到该问题的明确回答或缺口说明",
        ...it,
      })),
    },
    session: plannerSession(projectId),
  });
  assert.equal(res.status, 200, `建立意图失败：${JSON.stringify(res.body)}`);
  return items.map((_, i) => res.body.ids[`i${i + 1}`]);
}

/** 经真实 #22 派发（runtime 会话）。 */
async function dispatch(base, projectId, { intentId, workerId = "w1", assignmentId, leaseTtlMs }) {
  const res = await call(base, "POST", "/sorne/attempts", {
    body: {
      intent_id: intentId,
      worker_id: workerId,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(leaseTtlMs ? { lease_ttl_ms: leaseTtlMs } : {}),
    },
    session: runtimeSession(projectId),
  });
  assert.equal(res.status, 200, `派发失败：${JSON.stringify(res.body)}`);
  return res.body;
}

/** worker 经真实 #25 汇报（progress/blocked/completion）。 */
async function report(base, projectId, attemptId, workerId, kind, { note, conditionGaps } = {}) {
  const res = await call(base, "POST", `/sorne/attempts/${attemptId}/progress`, {
    body: { kind, ...(note ? { note } : {}), ...(conditionGaps ? { condition_gaps: conditionGaps } : {}) },
    session: workerSessionOf(projectId, workerId),
  });
  assert.equal(res.status, 200, `汇报失败：${JSON.stringify(res.body)}`);
  return res.body.report_id;
}

/** worker 经真实 #10 追加观察，返回观察编号。 */
async function observation(base, projectId, statement, workerId = "w2") {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: nextSubId("SUB-OBS"),
      operations: [{ op: "append_observation", local_ref: "o", statement }],
    },
    session: workerSessionOf(projectId, workerId),
  });
  assert.equal(res.status, 200, `追加观察失败：${JSON.stringify(res.body)}`);
  return res.body.ids.o;
}

async function overview(base, projectId, { session, query = "" } = {}) {
  const res = await call(
    base,
    "GET",
    `/sorne/orchestrator/overview?project_id=${projectId}${query}`,
    session ? { session } : {},
  );
  return res;
}

async function outboxCount(dataDir, projectId) {
  const store = await getStore({ dataDir });
  try {
    return store.db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?")
      .get(projectId).c;
  } finally {
    await closeStore({ dataDir });
  }
}

/** 行级夹具：构造「决定已落库、动作 pending、（可选）效果已发生」的中断状态。
 * 这正是委托型动作在生产中「效果事务已提交、状态回写前崩溃」的窗口态；
 * 决定/动作行按 recordDecision 的落库形状直写（C1/D2 夹具直写先例）。 */
async function fixtureInterruptedDecision(
  dataDir,
  projectId,
  { decisionId, actions }, // actions: [{id, action_kind, idempotency_key, payload}]
) {
  const store = await getStore({ dataDir });
  try {
    await store.runSerial((db) => {
      const now = new Date().toISOString();
      const seq = db
        .prepare("SELECT MAX(created_seq) AS m FROM orchestration_decisions WHERE project_id = ?")
        .get(projectId).m || 0;
      db.prepare(
        `INSERT INTO orchestration_decisions (id, project_id, input_report_ids, input_event_refs,
           rationale, tool_result, created_at, created_by, created_seq)
         VALUES (?, ?, '[]', '[]', ?, '', ?, 'orch-1', ?)`,
      ).run(decisionId, projectId, "夹具：模拟中断窗口", now, seq + 1);
      for (const a of actions) {
        db.prepare(
          `INSERT INTO orchestration_actions (id, project_id, decision_id, action_kind, idempotency_key,
             payload, status, result, created_at, created_by, created_seq, updated_seq)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, 'orch-1', ?, ?)`,
        ).run(a.id, projectId, decisionId, a.action_kind, a.idempotency_key, JSON.stringify(a.payload), now, seq + 1, seq + 1);
      }
    });
  } finally {
    await closeStore({ dataDir });
  }
}

/* ═══════════════════════════════════════════════════════════════════ */

test("概览：空项目面板结构完整、全中文注记、无未处理项、读取不产生自动决定（不空转，§16.1/§16.4；场景 21 E1 配合面）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const before = await outboxCount(s.dataDir, project.id);

    const res = await overview(s.base, project.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    // §18.6 面板六要素 + §3.3 概览要素齐备
    for (const key of [
      "project", "active_plan", "intents", "pending_reports", "important_findings",
      "pending_items", "constraints", "execution", "supply", "wake_signals",
      "key_changes", "panel_notes",
    ]) {
      assert.ok(b[key] !== undefined, `面板缺少 ${key}`);
    }
    assert.equal(b.pending_reports.total, 0);
    assert.equal(b.pending_items.interrupted_actions.total, 0);
    assert.equal(b.supply.verification_backlog.pending_jobs, 0);
    assert.ok(Array.isArray(b.panel_notes) && b.panel_notes.length >= 4);
    assert.match(b.panel_notes.join("\n"), /delivered.*不算已处理|仅送入上下文/);
    // 程序不空转：读取未产生任何决定/事件
    const after = await outboxCount(s.dataDir, project.id);
    assert.equal(after, before, "空面板读取不应产生新事件（无变化不无限重复任务）");
    const store = await getStore({ dataDir: s.dataDir });
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS c FROM orchestration_decisions WHERE project_id = ?").get(project.id).c,
        0,
        "程序不得自动创建协调决定",
      );
    } finally {
      await closeStore({ dataDir: s.dataDir });
    }
  });
});

test("概览：project_id 必填、跨项目会话 403、无会话回环按 user 面只读可访问", async () => {
  await withServer(async (s) => {
    const a = await createProject(s.base, { name: "项目A" });
    const b = await createProject(s.base, { name: "项目B", withScope: false });
    const missing = await call(s.base, "GET", "/sorne/orchestrator/overview");
    assert.equal(missing.status, 400);

    const cross = await overview(s.base, b.id, { session: orchestratorSession(a.id) });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");

    const anon = await overview(s.base, a.id);
    assert.equal(anon.status, 200);
    assert.equal(anon.body.viewer.role, "user");

    const orch = await overview(s.base, a.id, { session: orchestratorSession(a.id) });
    assert.equal(orch.status, 200);
    assert.equal(orch.body.viewer.role, "orchestrator");
  });
});

test("概览：真实链路（计划→派发→受阻汇报）后面板条目来自真实数据；delivered 与处理分存（§18.5）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "登录后的调用面是否受限？", kind: "investigate", rationale: "入口已见" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const reportId = await report(s.base, project.id, att.attempt.id, "w1", "blocked", {
      note: "缺少登录后的调用信息",
      conditionGaps: ["已登录会话"],
    });

    const res = await overview(s.base, project.id, { session: orchestratorSession(project.id) });
    assert.equal(res.status, 200);
    const b = res.body;
    // 未处理汇报：真实编号 + 条件缺口 + delivered≠处理 并存
    assert.equal(b.pending_reports.total, 1);
    const item = b.pending_reports.items.find((r) => r.id === reportId);
    assert.ok(item, "受阻汇报应出现在未处理列表");
    assert.equal(item.kind, "blocked");
    assert.equal(item.execution_status, "leased");
    assert.deepEqual(item.condition_gaps, ["已登录会话"]);
    assert.equal(item.delivery_status, "delivered");
    assert.equal(item.handling_status, "pending");
    // 意图面：活跃意图与最近 Attempt
    assert.equal(b.intents.active.length, 1);
    assert.equal(b.intents.active[0].latest_attempt.id, att.attempt.id);
    // 执行面：活跃 Attempt 与租约剩余时间
    assert.equal(b.execution.active_attempts.length, 1);
    assert.ok(typeof b.execution.active_attempts[0].lease_remaining_ms === "number");
    // 关键变化：真实 Outbox 事件（计划接收/派发/受阻）
    const types = b.key_changes.items.map((e) => e.event_type);
    assert.ok(types.includes("plan.received"), `关键变化应含 plan.received：${types.join(",")}`);
    assert.ok(types.includes("resource_state.changed"));
    // §16.3 供给块：等待与资源用量
    assert.equal(b.supply.waiting.pending_reports, 1);
    assert.ok(b.supply.waiting.oldest_pending_report_age_ms !== null);
    assert.equal(b.supply.resource_usage.active_attempts, 1);
  });
});

test("概览：重要发现状态以库为准（真实 suspected 漏洞如实展示，不提升状态，§18.4/§8.2）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: nextSubId("SUB-VUL"),
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "sql-injection" }],
      },
      session: workerSessionOf(project.id, "w1"),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const vulnId = res.body.ids.v;

    const ov = await overview(s.base, project.id);
    const found = ov.body.important_findings.vulnerabilities.find((v) => v.id === vulnId);
    assert.ok(found, "新漏洞应出现在重要发现");
    assert.equal(found.status, "suspected");
    assert.equal(found.review, "clear");
    assert.match(ov.body.important_findings.note, /以库为准/);
  });
});

test("决定持久化与幂等：同 decision_id 同内容重发返回当前状态并补齐动作；同 ID 不同内容/动作键冲突拒绝（§3.3）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "旁证是否可得？", kind: "collect" },
    ]);
    const body = (rationale) => ({
      decision_id: "DEC-RETRY-1",
      rationale,
      actions: [
        { action_kind: "assign_execution", idempotency_key: "K-ASSIGN-1", payload: { intent_id: intentId, worker_id: "w9" } },
      ],
    });
    const first = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: body("需要补采"),
      session: orchestratorSession(project.id),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.actions[0].status, "executed");
    const attemptId = first.body.actions[0].result.attempt_id;

    // 传输重试：同 ID 同内容 → 当前状态（idempotent），不重复创建
    const retry = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: body("需要补采"),
      session: orchestratorSession(project.id),
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);
    assert.equal(retry.body.actions[0].result.attempt_id, attemptId);
    const store = await getStore({ dataDir: s.dataDir });
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND assignment_id = ?").get(project.id, "K-ASSIGN-1").c,
        1,
        "重试不得重复创建分配",
      );
    } finally {
      await closeStore({ dataDir: s.dataDir });
    }

    // 同 ID 不同内容 → IDEMPOTENCY_KEY_REUSED，不覆盖
    const conflict = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: body("换了理由"),
      session: orchestratorSession(project.id),
    });
    assert.equal(conflict.status, 422);
    assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");

    // 新决定复用已存在的动作幂等键 → 拒绝
    const keyClash = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "另一个决定",
        actions: [
          { action_kind: "assign_execution", idempotency_key: "K-ASSIGN-1", payload: { intent_id: intentId, worker_id: "w8" } },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(keyClash.status, 422);
    assert.equal(keyClash.body.code, "IDEMPOTENCY_KEY_REUSED");
  });
});

test("决定动作失败不阻断其余动作，结果随决定保存（§3.3 工具返回受阻原因）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId, intent2] = await createIntents(s.base, project.id, [
      { question: "主方向", kind: "collect" },
      { question: "待派发方向", kind: "collect" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    // 记录期校验放行（意图存在）、执行期注定失败：暂停项目后新派发被程序阻止（§16.4）
    const paused = await call(s.base, "POST", `/sorne/projects/${project.id}/lifecycle`, {
      body: { action: "pause" },
    });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));

    const res = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "部分动作会受阻：暂停期间派发被程序拒绝，追问不受执行限制影响",
        actions: [
          { action_kind: "assign_execution", idempotency_key: "K-BAD", payload: { intent_id: intent2, worker_id: "w2" } },
          { action_kind: "followup", idempotency_key: "K-FU", payload: { attempt_id: att.attempt.id, question: "现状如何？" } },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [bad, fu] = res.body.actions;
    assert.equal(bad.status, "failed");
    assert.equal(bad.result.error.code, "PRECONDITION_INVALID");
    assert.match(bad.result.error.message, /禁止新派发/);
    assert.deepEqual(bad.result.error.next_requirements, ["项目恢复 active 后重新派发"]);
    assert.equal(fu.status, "executed");
    assert.equal(res.body.tool_result.executed, 1);
    assert.equal(res.body.tool_result.failed, 1);
  });
});

test("回执门控（§18.5.6）：无持久化决定时 accepted 被拒；决定含 handle_report 后 handled", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "阻塞验证", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const reportId = await report(s.base, project.id, att.attempt.id, "w1", "blocked", { note: "缺凭据" });

    // 未持久化决定 → accepted 拒绝（仅 delivered 不算处理）
    const early = await call(s.base, "POST", "/sorne/report-receipts", {
      body: { report_id: reportId, receipt_kind: "accepted" },
      session: orchestratorSession(project.id),
    });
    assert.equal(early.status, 422);
    assert.equal(early.body.code, "PRECONDITION_INVALID");

    // 决定 + handle_report 动作 → 回执落库、汇报 handled
    const dec = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        input_report_ids: [reportId],
        rationale: "接受受阻事实，转交补查",
        actions: [
          { action_kind: "handle_report", idempotency_key: "K-HR", payload: { report_id: reportId, receipt_kind: "accepted" } },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    assert.equal(dec.body.actions[0].status, "executed");
    assert.equal(dec.body.actions[0].result.handling_status, "handled");

    // #33 带决定关联 → 幂等补一张回执（同一事实的多张回执可追溯）
    const receipt = await call(s.base, "POST", "/sorne/report-receipts", {
      body: { report_id: reportId, receipt_kind: "coordinated", decision_id: dec.body.id, note: "补录回执" },
      session: orchestratorSession(project.id),
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.equal(receipt.body.report.handling_status, "handled");
  });
});

test("needs_clarification 关联追问；deferred 必须携带暂缓原因（§3.3/§18.5）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "矛盾澄清", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const reportId = await report(s.base, project.id, att.attempt.id, "w1", "progress", { note: "半程" });

    const fu = await call(s.base, "POST", `/sorne/attempts/${att.attempt.id}/followups`, {
      body: { question: "哪一步出现了矛盾？", report_id: reportId },
      session: orchestratorSession(project.id),
    });
    assert.equal(fu.status, 200, JSON.stringify(fu.body));
    assert.ok(fu.body.followup_ref);

    const nc = await call(s.base, "POST", "/sorne/report-receipts", {
      body: { report_id: reportId, receipt_kind: "needs_clarification", followup_ref: fu.body.followup_ref },
      session: orchestratorSession(project.id),
    });
    assert.equal(nc.status, 200);
    assert.equal(nc.body.report.handling_status, "needs_clarification");
    assert.equal(nc.body.receipt.followup_ref, fu.body.followup_ref);

    const noNote = await call(s.base, "POST", "/sorne/report-receipts", {
      body: { report_id: reportId, receipt_kind: "deferred" },
      session: orchestratorSession(project.id),
    });
    assert.equal(noNote.status, 400);
    const deferred = await call(s.base, "POST", "/sorne/report-receipts", {
      body: {
        report_id: reportId,
        receipt_kind: "deferred",
        note: "等待用户补充授权账户",
        resume_conditions: ["用户提供测试账户"],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(deferred.status, 200);
    assert.equal(deferred.body.report.handling_status, "deferred");
  });
});

test("set_execution_limits：并行上限经决定设置并立即对派发生效（§16.3 AI 设并行限制）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [i1, i2] = await createIntents(s.base, project.id, [
      { question: "方向一", kind: "collect" },
      { question: "方向二", kind: "collect" },
    ]);
    const dec = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "集中资源先攻一个方向",
        actions: [
          { action_kind: "set_execution_limits", idempotency_key: "K-LIMIT", payload: { max_active_attempts: 1 } },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    assert.equal(dec.body.actions[0].result.max_active_attempts, 1);

    const ov = await overview(s.base, project.id);
    assert.equal(ov.body.constraints.max_active_attempts, 1);
    assert.equal(ov.body.supply.resource_usage.max_active_attempts, 1);

    await dispatch(s.base, project.id, { intentId: i1, workerId: "w1" });
    const second = await call(s.base, "POST", "/sorne/attempts", {
      body: { intent_id: i2, worker_id: "w2" },
      session: runtimeSession(project.id),
    });
    assert.equal(second.status, 422);
    assert.equal(second.body.code, "RESOURCE_LIMIT");
  });
});

test("场景 29（主责）：读完汇报但保存决定前中断 → 真实重启后汇报仍待处理；决定+回执后 handled 且跨重启保持", async () => {
  const dir = makeTempDir("sorne-orch-s29-");
  let s = await bootServer(dir);
  try {
    const project = await createProject(s.base);
    const projectId = project.id;
    const [intentId] = await createIntents(s.base, projectId, [
      { question: "中断演练", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, projectId, { intentId, workerId: "w1" });
    const reportId = await report(s.base, projectId, att.attempt.id, "w1", "blocked", { note: "缺前置" });

    // 「读」= 送入上下文（delivered）；保存决定前进程中断：真实关库关服再拉起
    await s.close();
    s = await bootServer(dir);

    const ov1 = await overview(s.base, projectId, { session: orchestratorSession(projectId) });
    assert.equal(ov1.status, 200);
    assert.equal(ov1.body.pending_reports.total, 1, "重启后汇报仍待处理（场景 29）");
    assert.equal(ov1.body.pending_reports.items[0].id, reportId);
    assert.equal(ov1.body.pending_reports.items[0].handling_status, "pending");

    // 决定（引用该汇报）+ 回执 → handled
    const dec = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        input_report_ids: [reportId],
        rationale: "恢复后继续协调：接受并转交",
        actions: [
          { action_kind: "handle_report", idempotency_key: "K-S29", payload: { report_id: reportId, receipt_kind: "accepted" } },
        ],
      },
      session: orchestratorSession(projectId),
    });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));

    // 再次重启：handled 状态持久
    await s.close();
    s = await bootServer(dir);
    const ov2 = await overview(s.base, projectId);
    assert.equal(ov2.body.pending_reports.total, 0);
    const store = await getStore({ dataDir: dir });
    try {
      const row = store.db
        .prepare("SELECT handling_status FROM worker_reports WHERE id = ?")
        .get(reportId);
      assert.equal(row.handling_status, "handled");
    } finally {
      await closeStore({ dataDir: dir });
    }
  } finally {
    await s.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("场景 30（主责）：多动作部分执行后中断 → 重启逐项核对：效果已完成的动作标记 reconciled 不重放，未完成的补齐", async () => {
  const dir = makeTempDir("sorne-orch-s30-");
  let s = await bootServer(dir);
  try {
    const project = await createProject(s.base);
    const projectId = project.id;
    const [intentId] = await createIntents(s.base, projectId, [
      { question: "逐项核对演练", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, projectId, { intentId, workerId: "w1" });

    /* 构造生产可达的中断态（委托型动作的崩溃窗口）：
       决定与两个 pending 动作已落库（= recordDecision 的落库产物，行级夹具），
       其中 assign 动作的效果已由真实 dispatchAttempt 提交（assignment=幂等键），
       但动作状态回写前崩溃 → 动作仍 pending 而 Attempt 已存在。 */
    await s.close(); // 关服后经库内夹具直写（避免与服务器句柄竞争）
    await fixtureInterruptedDecision(dir, projectId, {
      decisionId: "OD-FIX-S30",
      actions: [
        {
          id: "OA-FIX-S30-A1",
          action_kind: "assign_execution",
          idempotency_key: "K-S30-ASSIGN",
          payload: { intent_id: intentId, worker_id: "w5" },
        },
        {
          id: "OA-FIX-S30-A2",
          action_kind: "followup",
          idempotency_key: "K-S30-FU",
          payload: { attempt_id: att.attempt.id, question: "重启后追问：现状如何？" },
        },
      ],
    });
    // 真实效果：assign 句柄 K-S30-ASSIGN 已有 Attempt（效果事务已提交）
    const store = await getStore({ dataDir: dir });
    const effected = await dispatchAttempt(
      { dataDir: dir, logger: QUIET },
      {
        session: { project_id: projectId, actor: "orch-1", role: "runtime" },
        intentId,
        assignmentId: "K-S30-ASSIGN",
        workerId: "w5",
      },
    );
    await closeStore({ dataDir: dir });
    const effectedAttemptId = effected.attempt.id;

    // 重启拉起；读取概览触发逐项核对
    s = await bootServer(dir);
    const eventsBefore = await outboxCount(dir, projectId);
    const ov = await overview(s.base, projectId, { session: orchestratorSession(projectId) });
    assert.equal(ov.status, 200, JSON.stringify(ov.body));

    const rec = ov.body.reconcile;
    const entry = rec.decisions.find((d) => d.decision_id === "OD-FIX-S30");
    assert.ok(entry, `核对应处理中断决定：${JSON.stringify(rec)}`);
    const a1 = entry.actions.find((a) => a.id === "OA-FIX-S30-A1");
    const a2 = entry.actions.find((a) => a.id === "OA-FIX-S30-A2");
    assert.equal(a1.status, "executed");
    assert.equal(a1.reconciled, true, "效果已完成的动作应标记 reconciled（核对完成，不重放）");
    assert.equal(a2.status, "executed");
    assert.equal(a2.reconciled, false, "未完成的动作应真实补齐执行");

    // 不重复完成动作：assign 句柄下仍只有那一个 Attempt；追问事件只投递一次
    const store2 = await getStore({ dataDir: dir });
    try {
      const attempts = store2.db
        .prepare("SELECT id FROM attempts WHERE project_id = ? AND assignment_id = ?")
        .all(projectId, "K-S30-ASSIGN");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].id, effectedAttemptId);
      const actionRow = store2.db
        .prepare("SELECT status, result FROM orchestration_actions WHERE id = 'OA-FIX-S30-A1'")
        .get();
      assert.equal(actionRow.status, "executed");
      assert.ok(JSON.parse(actionRow.result).reconciled);
      assert.ok(JSON.parse(actionRow.result).evidence.attempt_id === effectedAttemptId);
      const fuEvents = store2.db
        .prepare("SELECT payload FROM outbox WHERE project_id = ? AND event_type = 'orchestration.decision_recorded'")
        .all(projectId)
        .filter((r) => JSON.parse(r.payload).action_id === "OA-FIX-S30-A2");
      assert.equal(fuEvents.length, 1, "追问动作只应投递一次");
      assert.ok(
        store2.db.prepare("SELECT COUNT(*) AS c FROM orchestration_actions WHERE id = 'OA-FIX-S30-A1' AND updated_seq > 0").get().c >= 1,
      );
    } finally {
      await closeStore({ dataDir: dir });
    }
    void eventsBefore;
  } finally {
    await s.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("场景 30 补充：决定落库后尚未执行任何动作即中断 → 重启后全部动作恰执行一次", async () => {
  const dir = makeTempDir("sorne-orch-s30b-");
  let s = await bootServer(dir);
  try {
    const project = await createProject(s.base);
    const projectId = project.id;
    const [intentId] = await createIntents(s.base, projectId, [
      { question: "全量补齐演练", kind: "collect" },
    ]);
    await s.close();
    await fixtureInterruptedDecision(dir, projectId, {
      decisionId: "OD-FIX-S30B",
      actions: [
        {
          id: "OA-FIX-S30B-A1",
          action_kind: "assign_execution",
          idempotency_key: "K-S30B-ASSIGN",
          payload: { intent_id: intentId, worker_id: "w7" },
        },
        {
          id: "OA-FIX-S30B-A2",
          action_kind: "record_strategy",
          idempotency_key: "K-S30B-STRAT",
          payload: { strategy: "switch_method", reason: "原方法两次未果，换带凭据路径", resume_conditions: [] },
        },
      ],
    });
    s = await bootServer(dir);
    const ov = await overview(s.base, projectId);
    const entry = ov.body.reconcile.decisions.find((d) => d.decision_id === "OD-FIX-S30B");
    assert.ok(entry);
    assert.ok(entry.actions.every((a) => a.status === "executed"));
    const store = await getStore({ dataDir: dir });
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ? AND assignment_id = 'K-S30B-ASSIGN'").get(projectId).c,
        1,
        "补齐执行恰创建一个分配",
      );
    } finally {
      await closeStore({ dataDir: dir });
    }
  } finally {
    await s.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("场景 32（主责）：worker 受阻且他任务有相关信息 → 供给检索信息、决定交接与恢复，程序无固定重试", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    // 任务 A：受阻（缺已登录会话条件）
    const [intentA] = await createIntents(s.base, project.id, [
      { question: "登录后的调用面是否受限？", kind: "investigate" },
    ]);
    const attA = await dispatch(s.base, project.id, { intentId: intentA, workerId: "w1" });
    const reportA = await report(s.base, project.id, attA.attempt.id, "w1", "blocked", {
      note: "缺少已登录会话下的调用信息",
      conditionGaps: ["已登录会话"],
    });
    // 任务 B：已持有相关信息（真实持久观察）
    const obsId = await observation(s.base, project.id, "另一任务已记录：测试账户 cust1 可复用登录态", "w2");
    // 同一意图第二次尝试 → 供给面的重复尝试清单
    const attA2 = await dispatch(s.base, project.id, { intentId: intentA, workerId: "w1", assignmentId: "ASM-RETRY-1" });
    assert.ok(attA2.attempt.id);

    const ov = await overview(s.base, project.id, { session: orchestratorSession(project.id) });
    // 程序供给：条件缺口、重复尝试、等待时长（检索材料，非自动决策）
    const pendingA = ov.body.pending_reports.items.find((r) => r.id === reportA);
    assert.deepEqual(pendingA.condition_gaps, ["已登录会话"]);
    const repeated = ov.body.supply.repeated_attempts.items.find((r) => r.intent_id === intentA);
    assert.ok(repeated, "重复尝试清单应含受阻意图");
    assert.equal(repeated.attempt_count, 2);
    assert.match(ov.body.supply.repeated_attempts.note, /不写死重试策略/);

    // Orchestrator 决定：交接（补充上下文）+ 追问 + 换方法重派（新分配带凭据路径）
    const dec = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        input_report_ids: [reportA],
        rationale: "任务 B 已有可复用登录态信息：交给 A 追问确认，并换带凭据路径重派；不盲目重试原方法",
        actions: [
          { action_kind: "attach_context", idempotency_key: "K-S32-CTX", payload: { attempt_id: attA.attempt.id, record_refs: [obsId], purpose: "任务 B 的登录态观察，供 A 复用条件" } },
          { action_kind: "followup", idempotency_key: "K-S32-FU", payload: { attempt_id: attA.attempt.id, question: "该登录态是否适用于你的目标入口？", report_id: reportA } },
          { action_kind: "assign_execution", idempotency_key: "K-S32-REASSIGN", payload: { intent_id: intentA, worker_id: "w1", handoff_summary: "换方法：携带 cust1 登录态重试，复用任务 B 观察" } },
          { action_kind: "handle_report", idempotency_key: "K-S32-HR", payload: { report_id: reportA, receipt_kind: "coordinated" } },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    assert.ok(dec.body.actions.every((a) => a.status === "executed"), JSON.stringify(dec.body.actions));
    const reassigned = dec.body.actions.find((a) => a.action_kind === "assign_execution").result.attempt_id;
    assert.ok(reassigned);

    // 程序侧无固定重试：没有决定就没有新分配（供给只读，不自动重派）
    const before = await (async () => {
      const store = await getStore({ dataDir: s.dataDir });
      try {
        return store.db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?").get(project.id).c;
      } finally {
        await closeStore({ dataDir: s.dataDir });
      }
    })();
    await overview(s.base, project.id);
    const after = await (async () => {
      const store = await getStore({ dataDir: s.dataDir });
      try {
        return store.db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?").get(project.id).c;
      } finally {
        await closeStore({ dataDir: s.dataDir });
      }
    })();
    assert.equal(after, before, "读取概览不得触发自动重派（程序无固定重试）");
  });
});

test("追问与补充上下文：引用校验 + 事件投递到任务关注面（§3.3）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "上下文交接", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const obsId = await observation(s.base, project.id, "可复用的入口观察", "w2");

    const badRef = await call(s.base, "POST", `/sorne/attempts/${att.attempt.id}/context`, {
      body: { record_refs: ["O-NOPE-9999"], purpose: "不存在引用" },
      session: orchestratorSession(project.id),
    });
    assert.equal(badRef.status, 422);
    assert.equal(badRef.body.code, "INVALID_REFERENCE");

    const badAttempt = await call(s.base, "POST", "/sorne/attempts/ATT-NOPE-9999/followups", {
      body: { question: "谁？" },
      session: orchestratorSession(project.id),
    });
    assert.equal(badAttempt.status, 422);
    assert.equal(badAttempt.body.code, "INVALID_REFERENCE");

    const fu = await call(s.base, "POST", `/sorne/attempts/${att.attempt.id}/followups`, {
      body: { question: "入口观察是否适用于你的目标？" },
      session: orchestratorSession(project.id),
    });
    assert.equal(fu.status, 200, JSON.stringify(fu.body));
    assert.equal(fu.body.action.status, "executed");

    const ctx = await call(s.base, "POST", `/sorne/attempts/${att.attempt.id}/context`, {
      body: { record_refs: [obsId], purpose: "复用入口观察" },
      session: orchestratorSession(project.id),
    });
    assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.action.status, "executed");

    const store = await getStore({ dataDir: s.dataDir });
    try {
      const events = store.db
        .prepare("SELECT subject_ids, payload FROM outbox WHERE project_id = ? AND event_type = 'orchestration.decision_recorded'")
        .all(project.id)
        .map((r) => ({ subjects: JSON.parse(r.subject_ids), payload: JSON.parse(r.payload) }));
      const ctxEvent = events.find((e) => e.payload.kind === "context_attached");
      assert.ok(ctxEvent, "补充上下文应投递事件");
      assert.ok(ctxEvent.subjects.includes(att.attempt.id));
      assert.ok(ctxEvent.subjects.includes(obsId));
      const fuEvent = events.find((e) => e.payload.kind === "followup");
      assert.ok(fuEvent, "追问应投递事件");
      assert.ok(fuEvent.subjects.includes(att.attempt.id));
      // 事实状态不被上下文动作改变（§3.3 补充上下文不改事实状态）
      const obsRow = store.db.prepare("SELECT statement FROM observations WHERE id = ?").get(obsId);
      assert.equal(obsRow.statement, "可复用的入口观察");
    } finally {
      await closeStore({ dataDir: s.dataDir });
    }
  });
});

test("单规划在途（§16.1）：#36 建立 in_flight run 并附供给块；在途拒绝第二请求；planner 提交后再请求可行", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const orch = orchestratorSession(project.id);
    const first = await call(s.base, "POST", "/sorne/plan-requests", {
      body: { question: "受阻方向如何重排？", record_refs: [], urgency: "high" },
      session: orch,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const planRunId = first.body.plan_run.plan_run_id;
    assert.ok(planRunId);
    assert.ok(first.body.supply && first.body.supply.resource_usage !== undefined, "plan-requests 应附 §16.3 供给块");

    const second = await call(s.base, "POST", "/sorne/plan-requests", {
      body: { question: "再来一次" },
      session: orch,
    });
    assert.equal(second.status, 422);
    assert.equal(second.body.code, "PRECONDITION_INVALID");
    assert.equal(second.body.detail.in_flight_plan_run_id, planRunId);

    // planner 以该 run 提交计划（真实 #20），run 转 received；此后可再请求
    const plan = await call(s.base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: nextSubId("PLAN"),
        plan_run_id: planRunId,
        plan_revision: "r2",
        intents: [
          {
            op: "create",
            local_ref: "n1",
            question: "重排后的方向",
            kind: "revisit",
            rationale: "受阻后重排",
            success_criteria: "得到重排方向的明确回答",
          },
        ],
      },
      session: plannerSession(project.id),
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));

    const third = await call(s.base, "POST", "/sorne/plan-requests", {
      body: { question: "新一轮" },
      session: orch,
    });
    assert.equal(third.status, 200);
    assert.notEqual(third.body.plan_run.plan_run_id, planRunId);
  });
});

test("陈旧 in_flight 规划 run 的核对清扫（§16.1 传输恢复：标记 rejected，不盲目重做）", async () => {
  const dir = makeTempDir("sorne-orch-stale-");
  let s = await bootServer(dir);
  try {
    const project = await createProject(s.base);
    const projectId = project.id;
    const first = await call(s.base, "POST", "/sorne/plan-requests", {
      body: { question: "会丢失的规划调用" },
      session: orchestratorSession(projectId),
    });
    assert.equal(first.status, 200);
    const runId = first.body.plan_run.plan_run_id;

    await s.close();
    const store = await getStore({ dataDir: dir });
    await store.runSerial((db) => {
      db.prepare("UPDATE plan_runs SET created_at = ? WHERE id = ?").run(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        runId,
      );
    });
    await closeStore({ dataDir: dir });

    s = await bootServer(dir);
    const ov = await overview(s.base, projectId);
    assert.ok(
      ov.body.reconcile.stale_plan_runs_rejected.includes(runId),
      `陈旧 run 应被标记 rejected：${JSON.stringify(ov.body.reconcile)}`,
    );
    const again = await call(s.base, "POST", "/sorne/plan-requests", {
      body: { question: "清扫后可重新请求" },
      session: orchestratorSession(projectId),
    });
    assert.equal(again.status, 200);
  } finally {
    await s.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("反复失败的策略决定：record_strategy 持久化继续/追问/换方法/暂缓/重规划及理由、恢复条件（§16.3）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const res = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "同条件已失败两次，评估后决定换方法",
        actions: [
          {
            action_kind: "record_strategy",
            idempotency_key: "K-STRAT",
            payload: {
              strategy: "switch_method",
              reason: "无凭据路径两次 403，切换带凭据方法",
              resume_conditions: ["获得测试账户"],
            },
          },
        ],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const action = res.body.actions[0];
    assert.equal(action.status, "executed");
    assert.equal(action.result.strategy, "switch_method");
    assert.deepEqual(action.result.resume_conditions, ["获得测试账户"]);

    const bad = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "非法策略词",
        actions: [{ action_kind: "record_strategy", idempotency_key: "K-STRAT-BAD", payload: { strategy: "retry_3_times", reason: "x" } }],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(bad.status, 400);
  });
});

test("验证积压供给：真实验证任务进入 backlog 与等待时长（§16.3/§20.2 观察面）", async () => {
  await withServer(async (s) => {
    registerVerificationPolicy({
      id: "policy-orch-test",
      version: "v1",
      required_checks: ["reproduce"],
      description: "E1 测试策略",
    });
    const project = await createProject(s.base);
    // 真实原始证据：A2 #11/#12 固定 Blob 并建立采集（verifier 可读的原始证据索引）
    const content = "HTTP/1.1 200 OK\r\nX-Echo: <script>1</script>";
    const sha = createHash("sha256").update(content).digest("hex");
    const up = await call(
      s.base,
      "POST",
      `/sorne/evidence/blobs?project_id=${encodeURIComponent(project.id)}&representation=raw_body&source_kind=tool_gateway`,
      { rawBody: content },
    );
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const cap = await call(s.base, "POST", "/sorne/captures", {
      body: {
        project_id: project.id,
        tool_call_id: "TC-E1-1",
        request_url_exact: "https://target.example.test/api/echo",
        method: "GET",
        response_body_blob: up.body.blob_id,
        condition_snapshot_id: "COND-未登录",
        integrity_status: "verified",
      },
    });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    // 建立可验证判断（真实 suspected 漏洞）
    const res = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: nextSubId("SUB-VUL"),
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "xss" }],
      },
      session: workerSessionOf(project.id, "w1"),
    });
    const vulnId = res.body.ids.v;
    // orchestrator 经 #27 发起独立验证（真实 D1；原始证据索引 + 条件 + 策略版本）
    const job = await call(s.base, "POST", "/sorne/verification-requests", {
      body: {
        subject_id: vulnId,
        policy_id: "policy-orch-test",
        policy_version: "v1",
        conditions: ["未登录状态下的反射位置"],
        raw_evidence_refs: [cap.body.capture_id],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(job.status, 200, JSON.stringify(job.body));

    const ov = await overview(s.base, project.id);
    assert.equal(ov.body.supply.verification_backlog.pending_jobs, 1);
    assert.ok(ov.body.supply.verification_backlog.oldest_pending_waiting_ms !== null);
    // 确认漏洞可立即产生后续方向（§16.3）：面板提供确认漏洞信息 + 前提等待说明
    assert.match(ov.body.important_findings.note, /后续方向|前提有效/);
  });
});

test("未处理汇报携带 base_report 链路线索与基线处理状态（§18.6 base_report 相对变化）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "基线链路", kind: "investigate" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const baseId = await report(s.base, project.id, att.attempt.id, "w1", "progress", { note: "基线" });
    const followId = await report(s.base, project.id, att.attempt.id, "w1", "progress", { note: "增量" });
    // E2 尚未施工（并行中）；base_report 链路以行级夹具直写（C1/D2 直写先例）
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      db.prepare("UPDATE worker_reports SET base_report_id = ? WHERE id = ?").run(baseId, followId);
    });
    await closeStore({ dataDir: s.dataDir });

    const ov = await overview(s.base, project.id);
    const item = ov.body.pending_reports.items.find((r) => r.id === followId);
    assert.equal(item.base_report_id, baseId);
    assert.equal(item.base_report_handling_status, "pending");
    assert.match(ov.body.pending_reports.note, /base_report/);
  });
});

test("角色面：#32–#36 仅 orchestrator 会话可调用（蓝图 §8.2）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "角色面", kind: "collect" },
    ]);
    const att = await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    const cases = [
      ["POST", "/sorne/orchestration-decisions", { rationale: "x", actions: [] }],
      ["POST", "/sorne/report-receipts", { report_id: "WR-1", receipt_kind: "deferred", note: "x" }],
      ["POST", `/sorne/attempts/${att.attempt.id}/followups`, { question: "x" }],
      ["POST", `/sorne/attempts/${att.attempt.id}/context`, { record_refs: ["R-1"], purpose: "x" }],
      ["POST", "/sorne/plan-requests", { question: "x" }],
    ];
    for (const [method, path, body] of cases) {
      const noSession = await call(s.base, method, path, { body });
      assert.equal(noSession.status, 403, `${path} 无会话应 403`);
      for (const session of [plannerSession(project.id), workerSessionOf(project.id, "w1"), runtimeSession(project.id)]) {
        const denied = await call(s.base, method, path, { body, session });
        assert.equal(denied.status, 403, `${path} 角色 ${session.role} 应 403`);
        assert.equal(denied.body.code, "TRUST_DENIED");
      }
      const ok = await call(s.base, method, path, { body, session: orchestratorSession(project.id) });
      assert.notEqual(ok.status, 403, `${path} orchestrator 不应被 403（得到 ${ok.status}）`);
    }
  });
});

test("决定引用校验：input_report_ids / input_event_refs 指向不存在对象被拒（§11.2）", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const badReport = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "引用不存在的汇报",
        input_report_ids: ["WR-NOPE-9999"],
        actions: [{ action_kind: "record_strategy", idempotency_key: "K-REF-1", payload: { strategy: "continue", reason: "x" } }],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(badReport.status, 422);
    assert.equal(badReport.body.code, "INVALID_REFERENCE");

    const badEvent = await call(s.base, "POST", "/sorne/orchestration-decisions", {
      body: {
        rationale: "引用不存在的事件",
        input_event_refs: ["EVT-NOPE-999999"],
        actions: [{ action_kind: "record_strategy", idempotency_key: "K-REF-2", payload: { strategy: "continue", reason: "x" } }],
      },
      session: orchestratorSession(project.id),
    });
    assert.equal(badEvent.status, 422);
    assert.equal(badEvent.body.code, "INVALID_REFERENCE");
  });
});

test("等待条件变化不空转（§16.4，场景 21 E1 配合面）：waiting_for_change 项目读取概览不产生新决定/事件/分配", async () => {
  await withServer(async (s) => {
    const project = await createProject(s.base);
    const [intentId] = await createIntents(s.base, project.id, [
      { question: "等待演练", kind: "investigate" },
    ]);
    await dispatch(s.base, project.id, { intentId, workerId: "w1" });
    // 用户转入等待状态（真实 A1 生命周期）
    const wait = await call(s.base, "POST", `/sorne/projects/${project.id}/lifecycle`, {
      body: { action: "wait" },
    });
    assert.equal(wait.status, 200, JSON.stringify(wait.body));

    const before = await outboxCount(s.dataDir, project.id);
    const ov = await overview(s.base, project.id);
    assert.equal(ov.status, 200);
    assert.equal(ov.body.project.status, "waiting_for_change");
    assert.match(ov.body.constraints.note, /等待条件变化|新派发被程序阻止/);
    const after = await outboxCount(s.dataDir, project.id);
    assert.equal(after, before, "等待状态读取不得产生新事件（不无限重复相同任务）");
  });
});
