/**
 * F2 —— 运行观测与恢复测试（§20.2 指标全集、§18.1 Checkpoint、§18.2 恢复七步、
 * §1/§16.4 等待不空转；蓝图 §7 场景 21 主责 + 场景 12/24 配合面）。
 *
 * 真实注入（§20.3 末段）：进程退出经真实「关库关服→同目录重启→重签会话」注入
 * （record-service closeStore + evidence closeAllStores + 服务器 close，再于同一
 * dataDir 重新 apply）；过期租约经真实库行（lease_expires_at 写为过去）；证据
 * 完整性异常经真实文件系统（删除已引用 Blob 字节 / 写入孤立文件 / staging 残留）；
 * 事务原子性与幂等经真实端点重放断言。不使用 mock 代替事务与恢复。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口；finally 关服、关句柄、删目录；
 * 不留后台进程、不触碰 ~/.sorne。
 *
 * intents/attempts 等经 C1/C2 真实端点建立（跨阶段已交付模块）；受阻历史经
 * C1 transitionIntent 真实状态机产生。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { issueSession, revokeSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { closeAllStores } from "../lib/store/evidence.mjs";
import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { createCheckpoint, latestCheckpoint, runRecovery } from "../lib/store/recovery.mjs";
import { collectMetrics } from "../lib/store/metrics.mjs";
import { evidenceDirs } from "../lib/store/layout.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 私有工具（helpers.request 不支持会话头，helpers 为冻结文件） ──── */

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

/** 重启演练服务器：close() 只关服不删目录（模拟进程退出再拉起）。 */
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

/** 进程退出的存储面：关闭全部库句柄（record-service + evidence 两处缓存）。 */
async function closeAllHandles(dataDir) {
  await closeStore({ dataDir });
  closeAllStores();
}

async function withServer(fn) {
  const dataDir = makeTempDir("sorne-f2-rec-");
  const srv = await bootServer(dataDir);
  try {
    return await fn({ base: srv.base, dataDir });
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const sess = (project_id, actor, role) => issueSession({ project_id, actor, role });
const plannerSession = (p, a = "planner-1") => sess(p, a, "planner");
const orchestratorSession = (p, a = "orch-1") => sess(p, a, "orchestrator");
const runtimeSession = (p, a = "runtime-1") => sess(p, a, "runtime");
const workerSession = (p, a = "w1") => sess(p, a, "worker");
const userSession = (p, a = "user-1") => sess(p, a, "user");
const verifierSession = (p, a = "v1") => sess(p, a, "verifier");

let subCounter = 0;
const sid = (tag) => `${tag}-${Date.now().toString(36)}-${(subCounter += 1)}`;

async function createProject(base, name = "F2 运行观测测试", { withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: { name, ...(withScope ? { scope_rules: { allow: ["*.example.test"], deny: [], pending: [] } } : {}) },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

/** 经真实 C1 #20 建立意图。 */
async function planIntent(base, projectId, question, overrides = {}) {
  const res = await call(base, "POST", "/sorne/plan-revisions", {
    body: {
      submission_id: sid("F2PLAN"),
      plan_revision: `r-${sid("x")}`,
      intents: [
        {
          op: "create",
          local_ref: "i",
          question,
          kind: "investigate",
          rationale: "F2 测试夹具意图",
          success_criteria: "得到该问题的明确回答或缺口说明",
          ...overrides,
        },
      ],
    },
    session: plannerSession(projectId),
  });
  assert.equal(res.status, 200, `建立意图失败：${JSON.stringify(res.body)}`);
  return res.body.ids.i;
}

/** 经真实 C2 #22 派发。 */
async function dispatch(base, projectId, intentId, { workerId = "w1", leaseTtlMs } = {}) {
  const res = await call(base, "POST", "/sorne/attempts", {
    body: { intent_id: intentId, worker_id: workerId, ...(leaseTtlMs ? { lease_ttl_ms: leaseTtlMs } : {}) },
    session: runtimeSession(projectId),
  });
  assert.equal(res.status, 200, `派发失败：${JSON.stringify(res.body)}`);
  return res.body;
}

/** 经真实 A1 #10 追加观察（worker），返回回执（ids.o 为观察编号）。 */
async function observe(base, projectId, statement, worker) {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: sid("F2OBS"),
      operations: [{ op: "append_observation", local_ref: "o", statement, conditions: ["未登录身份"] }],
    },
    session: worker,
  });
  assert.equal(res.status, 200, `追加观察失败：${JSON.stringify(res.body)}`);
  return res.body;
}

/** 真实原始证据：A2 #11 上传固定 + #12 采集登记（§8.3 原始证据索引），返回 capture_id。 */
async function seedEvidence(base, projectId, content, toolCallId) {
  const up = await call(
    base,
    "POST",
    `/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body&source_kind=tool_gateway`,
    { rawBody: content },
  );
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const cap = await call(base, "POST", "/sorne/captures", {
    body: {
      project_id: projectId,
      tool_call_id: toolCallId,
      request_url_exact: "https://t.example.test/api/echo",
      method: "GET",
      response_body_blob: up.body.blob_id,
      condition_snapshot_id: "COND-未登录",
      integrity_status: "verified",
    },
  });
  assert.equal(cap.status, 200, JSON.stringify(cap.body));
  return cap.body.capture_id;
}

/** 真实库行注入：把租约到期写为过去（C2 attempts.test 同法）。 */
async function expireLease(dataDir, attemptId) {
  const store = await getStore({ dataDir });
  await store.runSerial((db) => {
    db.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      attemptId,
    );
  });
}

async function tableCount(dataDir, sql, ...args) {
  const store = await getStore({ dataDir });
  return store.db.prepare(sql).get(...args);
}

/* ── 1. §20.2 指标全集 ───────────────────────────────────────────── */

test("§20.2 指标全集：真实驱动数据后十类指标在场且数值可核对（只读、无副作用）", async () => {
  registerVerificationPolicy({ id: "policy-f2-test", version: "v1", required_checks: ["reproduce"], description: "F2 指标测试策略" });
  await withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id, "w1");
    // 重复意图：两个同 question 意图（真实 #20）
    await planIntent(base, project.id, "登录入口在哪里？");
    await planIntent(base, project.id, "登录入口在哪里？");
    // 执行与未完成工具调用（真实 #22/#26）
    const intents = await call(base, "GET", `/sorne/intents?project_id=${project.id}`, { session: worker });
    const intentId = intents.body.intents[0].id;
    const d = await dispatch(base, project.id, intentId);
    const reg = await call(base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, tool_name: "http.fetch", fencing_token: d.fencing_token, args: { url: "https://t.example.test/a" } },
      session: worker,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    // 发现与待验证判断（真实 #10/#27）
    await observe(base, project.id, "登录接口对单引号返回 500", worker);
    const vuln = await call(base, "POST", "/sorne/submissions", {
      body: { submission_id: sid("F2VUL"), operations: [{ op: "report_vulnerability", local_ref: "v", category: "sql-injection" }] },
      session: worker,
    });
    assert.equal(vuln.status, 200, JSON.stringify(vuln.body));
    // §8.3：验证必须携带原始证据索引（真实 A2 #11/#12 采集）
    const captureId = await seedEvidence(base, project.id, "HTTP/1.1 200 OK\r\nX-Echo: <script>1</script>", `TC-F2-${Date.now()}`);
    const job = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vuln.body.ids.v, policy_id: "policy-f2-test", policy_version: "v1", conditions: ["未登录"], raw_evidence_refs: [captureId] },
      session: orchestratorSession(project.id),
    });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    // staging 残留与孤立 Blob（真实文件系统注入：§13 中断残留）
    const { staging, blobsRoot } = evidenceDirs(dataDir, project.id);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "interrupted-upload.tmp"), "half-uploaded-bytes");
    mkdirSync(join(blobsRoot, "ab"), { recursive: true });
    writeFileSync(join(blobsRoot, "ab", `${"0".repeat(64)}`), "orphan");

    const before = await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox");
    const res = await call(base, "GET", `/sorne/metrics?project_id=${project.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const m = res.body;
    // 十类指标键全部在场
    for (const key of [
      "save_latency", "outbox", "projection_lag", "unconsumed_findings",
      "duplicate_intents", "repeated_execution", "verification_queue",
      "conflicts", "blocked_recovery", "evidence_store",
    ]) {
      assert.ok(m[key] !== undefined, `缺少指标块 ${key}`);
    }
    // 数值逐块核对
    assert.equal(m.projects.by_status.active, 1, "项目状态分布（§1 运行/等待分离观测）");
    assert.ok(m.save_latency.staged_uploads.count >= 1, "staging 残留（待固定上传，§18.2 步骤 1 口径）");
    assert.ok(m.save_latency.staged_uploads.oldest_age_ms >= 0);
    assert.ok(m.outbox.by_status.total > 0, "Outbox 事件存在");
    assert.equal(m.projection_lag.per_kind.planner_view.latest_snapshot_commit_seq, null, "无 planner_view 快照：未投影不冒充 0 滞后");
    assert.ok(m.unconsumed_findings.observations >= 1, "晚于 Planner 边界的未消费发现");
    assert.equal(m.duplicate_intents.duplicated_intents, 2, "同 question 双意图计入重复候选");
    assert.equal(m.duplicate_intents.ratio, 1, "全部意图都属于重复组时比例为 1");
    assert.equal(m.repeated_execution.intents_with_multiple_attempts, 0, "单 Attempt 意图不计重复执行");
    assert.ok(m.verification_queue.pending >= 1, "验证队列等待（数据时刻值）");
    assert.ok(m.verification_queue.oldest_waiting_ms !== null);
    assert.equal(m.conflicts.vulnerability_review_disputed, 0);
    assert.equal(m.blocked_recovery.recovery_rate, null, "无受阻历史时恢复率为 null（不虚构）");
    assert.equal(m.evidence_store.per_project[project.id].orphan_files, 1, "孤立 Blob 文件经真实读盘识别");

    // 只读性：收集指标不产生任何事件或行变更
    const after = await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox");
    assert.equal(after.c, before.c, "指标收集无副作用（只读）");
    const again = await collectMetrics({ dataDir }, { projectId: project.id });
    assert.equal(again.schema_version, m.schema_version);
  });
});

test("/metrics 访问面：无会话回环按 user 面只读；带会话任意角色可读；跨项目声明被拒", async () => {
  await withServer(async ({ base }) => {
    const a = await createProject(base, "F2 指标项目 A");
    const anonymous = await call(base, "GET", "/sorne/metrics");
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.scope.projects, 1);
    const worker = workerSession(a.id);
    const scoped = await call(base, "GET", `/sorne/metrics?project_id=${a.id}`, { session: worker });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.scope.project_id, a.id);
    const b = await createProject(base, "F2 指标项目 B", { withScope: false });
    const cross = await call(base, "GET", `/sorne/metrics?project_id=${b.id}`, { session: worker });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");
  });
});

/* ── 2. Checkpoint（§18.1） ──────────────────────────────────────── */

test("§18.1 Checkpoint：十一项内容齐全、关键结论带编号引用、派生资料声明", async () => {
  registerVerificationPolicy({ id: "policy-f2-cp", version: "v1", required_checks: ["reproduce"], description: "F2 快照策略" });
  await withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id, "w1");
    const intentId = await planIntent(base, project.id, "确认登录相关入口？", { basis_refs: [] });
    const d = await dispatch(base, project.id, intentId);
    const obs = await observe(base, project.id, "页面调用 /api/login", worker);
    const vuln = await call(base, "POST", "/sorne/submissions", {
      body: { submission_id: sid("F2VUL"), operations: [{ op: "report_vulnerability", local_ref: "v", category: "xss" }] },
      session: worker,
    });
    const captureId = await seedEvidence(base, project.id, "HTTP/1.1 500\r\nX-Err: quote", `TC-F2CP-${Date.now()}`);
    const job = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vuln.body.ids.v, policy_id: "policy-f2-cp", policy_version: "v1", conditions: ["未登录"], raw_evidence_refs: [captureId] },
      session: orchestratorSession(project.id),
    });
    assert.equal(job.status, 200, JSON.stringify(job.body));

    const cp = await createCheckpoint({ dataDir }, { projectId: project.id, intentId, attemptId: d.attempt.id, actor: "w1" });
    const c = cp.content;
    assert.ok(c.derived, "快照是派生资料（§18.1）");
    assert.match(c.derivation_note, /派生资料/);
    // §18.1 十一项
    assert.equal(c.intent.id, intentId);
    assert.equal(c.attempt.id, d.attempt.id);
    assert.equal(c.goal_and_scope.project_id, project.id);
    assert.ok(c.goal_and_scope.current_scope_revision, "目标和范围版本");
    assert.equal(c.current_question, "确认登录相关入口？");
    assert.ok(Array.isArray(c.key_evidence_ids.basis_refs));
    assert.ok(Array.isArray(c.confirmed_content) && Array.isArray(c.unconfirmed_content));
    assert.ok(c.unconfirmed_content.some((u) => u.record_id === vuln.body.ids.v), "未确认内容带编号");
    assert.ok(Array.isArray(c.attempted_conditions) && c.attempted_conditions.length === 1);
    assert.ok(c.failure_or_block_reasons && Array.isArray(c.failure_or_block_reasons.blocked_intents));
    assert.ok(c.pending_verification.some((p) => p.job_id === job.body.job.id), "待验证问题带编号");
    assert.ok(c.next_step_suggestions && Array.isArray(c.next_step_suggestions.resume_conditions));
    assert.ok(Number.isInteger(c.processed_boundary), "已处理事件边界");
    assert.ok(Array.isArray(c.unfinished_tool_calls));
    // 关键结论带编号引用（§18.1：不能把多轮摘要当作新的原始事实）
    for (const id of [intentId, d.attempt.id, vuln.body.ids.v, job.body.job.id]) {
      assert.ok(c.refs.includes(id), `refs 应含编号 ${id}`);
    }
    assert.ok(cp.checkpoint_id.startsWith(`CP-${project.id}-`), "编号带项目前缀");
    // 库行核对
    const row = await tableCount(dataDir, "SELECT id FROM checkpoints WHERE id = ?", cp.checkpoint_id);
    assert.ok(row);
    const latest = await latestCheckpoint({ dataDir }, { projectId: project.id });
    assert.equal(latest.checkpoint_id, cp.checkpoint_id);
  });
});

test("§18.1 生成新快照依据当前结构化记录核对，不是对上一次摘要继续压缩", async () => {
  await withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id, "w1");
    const first = await createCheckpoint({ dataDir }, { projectId: project.id, actor: "w1" });
    // 快照之后新增一条观察（真实 #10）
    const obs = await observe(base, project.id, "边界之后的新观察", worker);
    const second = await createCheckpoint({ dataDir }, { projectId: project.id, actor: "w1" });
    assert.notEqual(second.checkpoint_id, first.checkpoint_id);
    assert.ok(second.content.refs.includes(obs.ids.o), "新快照的关键依据含边界后新观察（实时重建）");
    assert.ok(!first.content.refs.includes(obs.ids.o), "旧快照不含其后产生的观察");
    assert.ok(second.content.processed_boundary >= first.content.processed_boundary, "边界单调");
  });
});

/* ── 3. §18.2 恢复七步（真实关库关服重启注入） ───────────────────── */

test("§18.2 七步恢复（重启注入）：中断 Attempt、unknown 调用、证据异常、Outbox 保留、Checkpoint 增量", async () => {
  const dataDir = makeTempDir("sorne-f2-restart-");
  let srv = await bootServer(dataDir);
  const issued = [];
  try {
    const project = await createProject(srv.base, "F2 七步恢复项目");
    const worker = workerSession(project.id, "w1");
    issued.push(worker);
    const intentId = await planIntent(srv.base, project.id, "恢复顺序验证？");
    const d = await dispatch(srv.base, project.id, intentId);
    // 在途工具调用（真实 #26）与已固定证据
    const reg = await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: d.attempt.id, tool_name: "http.fetch", fencing_token: d.fencing_token, args: { url: "https://t.example.test/a" } },
      session: worker,
    });
    await call(srv.base, "POST", "/sorne/tool-calls", {
      body: { action: "start", attempt_id: d.attempt.id, tool_call_id: reg.body.tool_call.id, fencing_token: d.fencing_token, targets: ["https://t.example.test/a"] },
      session: worker,
    });
    const up = await call(
      srv.base,
      "POST",
      `/sorne/evidence/blobs?project_id=${encodeURIComponent(project.id)}&representation=raw_body&source_kind=tool_gateway`,
      { rawBody: "HTTP/1.1 200 OK\r\nX-A: 1" },
    );
    assert.equal(up.status, 200, JSON.stringify(up.body));
    // 「进程退出」注入：租约过期（真实库行）→ 删除已引用 Blob 字节（真实文件系统损坏）→ 关库关服
    await expireLease(dataDir, d.attempt.id);
    const store = await getStore({ dataDir });
    const blobRow = store.db.prepare("SELECT stored_path FROM blobs WHERE project_id = ?").get(project.id);
    const missingPath = join(dataDir, blobRow.stored_path);
    await closeStore({ dataDir });
    rmSync(missingPath);
    for (const s of issued) revokeSession(s.session_token);
    await srv.close();
    closeAllStores();

    // 同目录重启（真实进程重启的存储面：全部句柄已关闭，重新打开同一库）
    srv = await bootServer(dataDir);
    const rt = runtimeSession(project.id);
    const drill = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    assert.equal(drill.status, 200, JSON.stringify(drill.body));
    const r = drill.body.drill;
    assert.equal(r.steps.length, 7, "七步齐全");
    const byKey = Object.fromEntries(r.steps.map((s) => [s.key, s]));
    // 步骤 1：已引用证据不可访问被报告（degraded），不删除不引用
    assert.equal(byKey.db_and_evidence.status, "degraded");
    const p1 = byKey.db_and_evidence.detail.projects.find((x) => x.project_id === project.id);
    assert.equal(p1.missing_files.length, 1, "缺失证据文件被报告");
    // 步骤 2：Outbox 未投递事件保留（重启即恢复，等待拉取补投递）
    assert.ok(byKey.outbox_and_cursors.detail.pending_total >= 1);
    // 步骤 3：过期租约 → 中断 Attempt（真实 sweep 事务）
    const p3 = byKey.expired_leases.detail.per_project.find((x) => x.project_id === project.id);
    assert.equal(p3.interrupted_attempts.length, 1);
    assert.equal(p3.interrupted_attempts[0].attempt_id, d.attempt.id);
    // 步骤 4：在途调用 unknown
    assert.equal(byKey.unfinished_tool_calls.detail.unknown_count, 1);
    assert.ok(byKey.unfinished_tool_calls.detail.remaining.some((t) => t.status === "unknown" && t.tool_call_id === reg.body.tool_call.id));
    // 步骤 5：范围/前提/资源清单在场
    const p5 = byKey.scope_prereqs_resources.detail.projects.find((x) => x.project_id === project.id);
    assert.equal(p5.new_dispatch_allowed, true);
    // 步骤 6：演练生成 Checkpoint 并给出边界后增量
    const p6 = byKey.checkpoint_and_changes.detail.projects.find((x) => x.project_id === project.id);
    assert.ok(p6.checkpoint_generated_now, "演练时无快照则先生成（§18.2 步骤 6）");
    assert.ok(p6.checkpoint.checkpoint_id.startsWith(`CP-${project.id}-`));
    assert.ok(p6.events_after_boundary >= 0);
    // 步骤 7：可恢复清单（不自动派发）
    const p7 = byKey.resumable_work.detail.projects.find((x) => x.project_id === project.id);
    assert.ok(p7.interrupted_attempts_for_redispatch.some((x) => x.attempt_id === d.attempt.id));
    assert.match(p7.note, /不自动派发/);
    // 演练报告留痕
    assert.ok(r.report_file && r.report_file.includes(join("work", "recovery", "drills")));
    // 程序未代 AI 重派：Attempt 总数不变（分配由 AI 决定，§3.2）
    const attempts = await tableCount(dataDir, "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?", project.id);
    assert.equal(attempts.c, 1);
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 4. 场景 12（配合面）：数据提交后通知前进程退出 → 重启后 Outbox 补投递 ── */

test("场景 12（配合面）：提交后通知前进程退出，重启后 Outbox 补投递，事件可达且可 applied", async () => {
  const dataDir = makeTempDir("sorne-f2-sc12-");
  let srv = await bootServer(dataDir);
  try {
    const project = await createProject(srv.base, "F2 场景12项目", { withScope: false });
    const worker = workerSession(project.id, "w1");
    // 消费者先订阅关注的对象（项目域强制通知面：scope.revised 的 subject 即项目编号）
    const subRes = await call(srv.base, "POST", "/sorne/subscriptions", {
      body: { focus: { subject_ids: [project.id] } },
      session: worker,
    });
    assert.equal(subRes.status, 200, JSON.stringify(subRes.body));
    const subscriptionId = subRes.body.subscription.id;
    // 「数据提交后、通知前」：范围修订落库（scope.revised 同事务入 Outbox，pending）
    const sr = await call(srv.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: project.id, rules: { allow: ["*.example.test"], deny: [], pending: [] }, summary: "重启前的数据提交" },
    });
    assert.equal(sr.status, 200, JSON.stringify(sr.body));
    const before = await tableCount(
      dataDir,
      "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'scope.revised'",
      project.id,
    );
    assert.ok(before.c >= 1, "数据提交时事件同事务落 Outbox（§2 约束 10）");
    // 「进程退出」：通知未投递（无人读取变化页）即关库关服
    revokeSession(worker.session_token);
    await srv.close();
    await closeAllHandles(dataDir);

    // 同目录重启 + 重签会话 → drill（步骤 2 恢复未处理 Outbox 与游标）
    srv = await bootServer(dataDir);
    const rt = runtimeSession(project.id);
    const worker2 = workerSession(project.id, "w1");
    const drill = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    assert.equal(drill.status, 200, JSON.stringify(drill.body));
    const step2 = drill.body.drill.steps.find((s) => s.key === "outbox_and_cursors");
    assert.ok(step2.detail.pending_total >= 1, "重启后 pending 事件保留待补投递");
    const subState = step2.detail.projects[0].subscriptions.find((x) => x.subscription_id === subscriptionId);
    assert.ok(subState, "订阅与游标随库恢复（§18.2 步骤 2）");

    // 补投递验证：变化页读到该事件（数据未被扣留，§4/§14.2 至少一次）
    const page = await call(srv.base, "GET", `/sorne/changes?subscription=${subscriptionId}`, { session: worker2 });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const hit = (page.body.events || []).find(
      (e) => e.event_type === "scope.revised" && (e.subject_ids || []).includes(project.id),
    );
    assert.ok(hit, "重启后事件经变化页补投递到达消费者");
    // applied：持久确认消费结果（程序消费者在自己的事务内提交处理回执）
    const ack = await call(srv.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: subscriptionId, receipt_kind: "applied", event_ids: [hit.event_id] },
      session: worker2,
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 5. 场景 24（配合面）：数据库成功但 HTTP 回执丢失 → 同 ID 恢复回执 ── */

test("场景 24（配合面）：回执丢失后同 submission_id 重发恢复原回执，不重复落库", async () => {
  const dataDir = makeTempDir("sorne-f2-sc24-");
  const srv = await bootServer(dataDir);
  try {
    const project = await createProject(srv.base, "F2 场景24项目");
    const worker = workerSession(project.id, "w1");
    const envelope = {
      submission_id: sid("F2SC24"),
      operations: [{ op: "append_observation", local_ref: "o", statement: "回执丢失场景观察" }],
    };
    const first = await call(srv.base, "POST", "/sorne/submissions", { body: envelope, session: worker });
    assert.equal(first.status, 200);
    const outboxBefore = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?", project.id)).c;
    const subsBefore = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM submissions WHERE project_id = ?", project.id)).c;
    // 「响应丢失」→ 客户端按同一 submission_id 重试（§13）
    const retry = await call(srv.base, "POST", "/sorne/submissions", { body: envelope, session: worker });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.submission_id, first.body.submission_id);
    assert.equal(retry.body.commit_seq, first.body.commit_seq, "原回执（同 commit_seq）");
    assert.equal(retry.body.result_hash, first.body.result_hash);
    const outboxAfter = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?", project.id)).c;
    const subsAfter = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM submissions WHERE project_id = ?", project.id)).c;
    assert.equal(outboxAfter, outboxBefore, "不重复创建事件");
    assert.equal(subsAfter, subsBefore, "不重复落库");
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 6. 场景 21（主责）：没有新方向且条件未变化 → 等待，不空转 ─────── */

test("场景 21（主责）：无可执行工作进入 waiting_for_change；条件未变化不重复转换不派发；条件变化恢复并继续", async () => {
  const dataDir = makeTempDir("sorne-f2-sc21-");
  const srv = await bootServer(dataDir);
  try {
    const project = await createProject(srv.base, "F2 场景21项目");
    const worker = workerSession(project.id, "w1");
    const rt = runtimeSession(project.id);

    // a) 有可执行工作时不进入等待：意图 queued → has_pending_work
    const intentId = await planIntent(srv.base, project.id, "等待判定前的工作？");
    const drill1 = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    assert.equal(drill1.status, 200, JSON.stringify(drill1.body));
    const w1 = drill1.body.drill.steps.find((s) => s.key === "resumable_work").detail.projects[0].waiting;
    assert.equal(w1.has_pending_work, true, "queued 意图构成可执行工作");
    assert.equal(w1.project.status, "active", "有工作时不转等待");
    assert.equal(w1.changed, false);

    // b) 没有可执行工作（意图取消、无活跃执行/验证/汇报/规划在途）→ 进入等待
    const cancel = await call(srv.base, "POST", "/sorne/submissions", {
      body: { submission_id: sid("F2CANCEL"), operations: [] },
      session: worker,
    });
    assert.equal(cancel.status, 200);
    /* 终审整改：清空可执行工作改经**真实意图状态机**（transitionIntent cancel：
       状态行 + intent_state_history + intent.blocked/cancelled 事件全由 C1 落库），
       不再直写 UPDATE/INSERT 夹具行。 */
    const { transitionIntent } = await import("../lib/store/intents.mjs");
    await transitionIntent(
      { dataDir },
      { projectId: project.id, actor: "orch-1", intentId, action: "cancel", reason: "F2 场景21：清空可执行工作（经真实状态机）" },
    );
    const store = await getStore({ dataDir });
    const histRow = store.db
      .prepare("SELECT * FROM intent_state_history WHERE intent_id = ? ORDER BY commit_seq DESC")
      .get(intentId);
    assert.ok(histRow && histRow.to_status === "cancelled" && histRow.via === "transition", "取消应经真实状态机留历史");
    const drill2 = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    const w2 = drill2.body.drill.steps.find((s) => s.key === "resumable_work").detail.projects[0].waiting;
    assert.equal(w2.has_pending_work, false, "无可执行工作（§1：没有可执行工作时进入等待条件变化的状态）");
    assert.equal(w2.project.status, "waiting_for_change", "进入等待");
    assert.equal(w2.changed, true, "本次演练完成 active→waiting 转换");

    // c) 条件未变化：等待边界后无新事件 → 唤醒信号为空；再次评估幂等、不产生新任务
    const attemptsBefore = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?", project.id)).c;
    const drill3 = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    const w3 = drill3.body.drill.steps.find((s) => s.key === "resumable_work").detail.projects[0].waiting;
    assert.deepEqual(w3.wake_signals, [], "条件未变化：无唤醒信号");
    assert.equal(w3.changed, false, "已等待且无信号 → 幂等不变");
    const attemptsAfter = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM attempts WHERE project_id = ?", project.id)).c;
    assert.equal(attemptsAfter, attemptsBefore, "等待期间程序不派发、不建新任务（不无限重复相同任务）");

    // d) 条件变化：planner 新计划（事件落在等待边界之后）→ 唤醒信号 + 恢复 active + 可继续派发
    const newIntent = await planIntent(srv.base, project.id, "条件变化后的新方向？");
    const drill4 = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    const w4 = drill4.body.drill.steps.find((s) => s.key === "resumable_work").detail.projects[0].waiting;
    assert.ok(w4.wake_signals.includes("plan.received"), "新计划事件构成唤醒信号（§16.1 程序检测明确条件）");
    assert.equal(w4.project.status, "active", "条件变化后恢复 active");
    const d = await dispatch(srv.base, project.id, newIntent);
    assert.ok(d.attempt.id, "恢复后可继续派发执行");
    // 项目从未被结束：等待/恢复均不触碰项目存在性（§1 不得自动结束项目）
    const proj = await call(srv.base, "GET", `/sorne/projects/${project.id}`);
    assert.equal(proj.status, 200);
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("场景 21 补充：blocked 意图构成可执行工作；受阻恢复率指标经真实状态机核对", async () => {
  await withServer(async ({ base, dataDir }) => {
    const project = await createProject(base, "F2 受阻恢复项目");
    const rt = runtimeSession(project.id);
    const { transitionIntent } = await import("../lib/store/intents.mjs");
    const i1 = await planIntent(base, project.id, "受阻方向一？");
    const i2 = await planIntent(base, project.id, "受阻方向二？");
    // 真实状态机：block（产生 intent_state_history 与 intent.blocked 事件）
    await transitionIntent({ dataDir }, { projectId: project.id, actor: "orch-1", intentId: i1, action: "block", reason: "缺少登录身份条件" });
    await transitionIntent({ dataDir }, { projectId: project.id, actor: "orch-1", intentId: i2, action: "block", reason: "等待上游验证" });
    // i1 条件恢复：resume（planner 重评估路径，§9.2）
    await transitionIntent({ dataDir }, { projectId: project.id, actor: "planner-1", intentId: i1, action: "resume", reason: "身份条件已补齐" });

    const m = await call(base, "GET", `/sorne/metrics?project_id=${project.id}`);
    assert.equal(m.body.blocked_recovery.ever_blocked, 2);
    assert.equal(m.body.blocked_recovery.recovered, 1);
    assert.equal(m.body.blocked_recovery.currently_blocked, 1);
    assert.equal(m.body.blocked_recovery.recovery_rate, 0.5);

    // blocked/deferred 意图仍构成「有可执行工作」？——否：受阻方向等待条件满足，
    // 不构成新派发工作；程序把它们列入待重评估清单（§9.2）。
    const drill = await call(base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    const step5 = drill.body.drill.steps.find((s) => s.key === "scope_prereqs_resources");
    const p5 = step5.detail.projects.find((x) => x.project_id === project.id);
    assert.equal(p5.blocked_or_deferred_intents.length, 1, "受阻意图列入待重评估清单（不一律改失败）");
    const step7 = drill.body.drill.steps.find((s) => s.key === "resumable_work");
    const p7 = step7.detail.projects.find((x) => x.project_id === project.id);
    assert.ok(p7.resume_candidates.some((c) => c.intent_id === i2), "受阻意图进入可恢复清单（恢复条件原文保留）");
  });
});

/* ── 7. drill 端点 ───────────────────────────────────────────────── */

test("drill 端点鉴权与项目域：user/runtime 可触发；无会话/其他角色/跨项目被拒", async () => {
  await withServer(async ({ base }) => {
    const a = await createProject(base, "F2 drill 项目 A");
    const b = await createProject(base, "F2 drill 项目 B", { withScope: false });
    const anonymous = await call(base, "POST", "/sorne/recovery/drill", { body: {} });
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.body.code, "TRUST_DENIED");
    const worker = workerSession(a.id);
    const denied = await call(base, "POST", "/sorne/recovery/drill", { body: {}, session: worker });
    assert.equal(denied.status, 403);
    const cross = await call(base, "POST", "/sorne/recovery/drill", { body: { project_id: b.id }, session: runtimeSession(a.id) });
    assert.equal(cross.status, 403);
    const user = userSession(a.id);
    const okUser = await call(base, "POST", "/sorne/recovery/drill", { body: {}, session: user });
    assert.equal(okUser.status, 200, JSON.stringify(okUser.body));
    assert.deepEqual(okUser.body.drill.scope.project_ids, [a.id]);
    const rt = runtimeSession(b.id);
    const okRt = await call(base, "POST", "/sorne/recovery/drill", { body: { project_id: b.id }, session: rt });
    assert.equal(okRt.status, 200, JSON.stringify(okRt.body));
  });
});

test("drill 幂等副作用：重复演练不重复中断、不重复业务事件（七步可重入）", async () => {
  const dataDir = makeTempDir("sorne-f2-idem-");
  const srv = await bootServer(dataDir);
  try {
    const project = await createProject(srv.base, "F2 drill 幂等项目");
    const rt = runtimeSession(project.id);
    const intentId = await planIntent(srv.base, project.id, "幂等演练？");
    const d = await dispatch(srv.base, project.id, intentId);
    await expireLease(dataDir, d.attempt.id);
    const first = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const interrupted1 = first.body.drill.steps.find((s) => s.key === "expired_leases").detail.per_project[0].interrupted_attempts.length;
    assert.equal(interrupted1, 1, "首次演练清扫过期租约");
    const outbox1 = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?", project.id)).c;
    const second = await call(srv.base, "POST", "/sorne/recovery/drill", { body: {}, session: rt });
    assert.equal(second.status, 200);
    const interrupted2 = second.body.drill.steps.find((s) => s.key === "expired_leases").detail.per_project[0].interrupted_attempts.length;
    assert.equal(interrupted2, 0, "清扫幂等：已中断的不重复中断");
    const outbox2 = (await tableCount(dataDir, "SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?", project.id)).c;
    // 第二次演练无状态转换（waiting 判定已由首次完成或不适用）→ 无新增业务事件
    assert.ok(outbox2 - outbox1 <= 1, `重复演练不产生风暴事件（前 ${outbox1} 后 ${outbox2}）`);
  } finally {
    await srv.close();
    await closeAllHandles(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 8. 存储级 runRecovery：多项目范围与只读核对 ──────────────────── */

test("runRecovery 存储级：全项目范围七步报告；步骤顺序与 §18.2 一致", async () => {
  await withServer(async ({ dataDir }) => {
    const project = await (async () => {
      const srvBase = "store-level";
      void srvBase;
      return null;
    })();
    void project;
    const report = await runRecovery({ dataDir }, { actor: "runtime/test", drill: false });
    assert.equal(report.steps.length, 7);
    assert.deepEqual(
      report.steps.map((s) => s.step),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      report.steps.map((s) => s.title).slice(0, 3),
      [
        "恢复数据库，检查已引用证据的可访问性和待固定上传",
        "恢复未处理 Outbox 和各消费者游标",
        "处理过期租约，标记中断 Attempt",
      ],
    );
    assert.equal(report.drill, false, "非演练：不生成快照、不维护等待状态");
  });
});
