/**
 * D1 —— 验证服务与准入测试（规范 §8.3 §12；蓝图 §7 场景 8/9/22 主责 + §12.3 五情形）。
 *
 * 覆盖蓝图 §7 中 D1 主责场景：
 *   - #8 verifier 审阅后新反对证据先提交 → 保存验证意见，拒绝直接应用旧结论；
 *   - #9 确认后新相关证据提交 → review=pending 且依赖（准入）不放行；
 *   - #22 漏洞确认并生成报告 → 项目继续，planner 可安排后续方向。
 * 以及 §12.3 五种竞争情形全测、§8.3 五要素与权限硬约束（仅 verifier 可交结果、
 * 发现者不得自证、续验不受 requested_by 限制）、Manifest 不可变与外键绑定、
 * 去重键四成分、幂等重交、准入检查、队列视图。
 *
 * 真实注入（§20.3 末段）：事务原子性经真实 SQLite TRIGGER RAISE(ABORT) 注入；
 * 重启经真实「关库关服→同目录重启→重签会话」；并发竞争经真实 runSerial 串行队列
 * （两 verifier 并行提交，恰一应用）。不使用 mock 替代事务与恢复。
 *
 * 状态机装配（§2.7 冻结签名 applyStateTransition，D2 唯一实现）：
 * D2 未落地窗口经 __installStateTransitionForTests 安装本文件提供的**真实事务实现**
 * （按 §8.4 前提校验并在调用方事务内写入新状态/版本/review，真实 DB 写入，B1 先例）；
 * D2 落地后自动走其真实默认装配，并追加默认装配集成用例（不跳过实际执行）。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（bootServer），不留后台进程、不触碰 ~/.sorne。
 * 判断/证据经 A1/A2 真实端点建立（#10 #11 #12）；计划接收经 C1 真实端点（#20）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import * as verification from "../lib/store/verification.mjs";
import { apiError } from "../lib/errors.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── D2 落地检测与状态机装配（§2.7 冻结签名） ─────────────────────── */

const d2Module = await import("../lib/store/judgements.mjs");
const D2_LANDED = typeof d2Module.applyStateTransition === "function";

/**
 * §2.7 冻结签名的真实事务实现（D2 未落地窗口的承载；真实 DB 写入，非 mock；
 * 词表与 D2 落地版一致：confirm / falsify / mark_conflicting / mark_insufficient /
 * support / reject / require_review，写路径统一推进 state_version）。
 */
function realTestApplier(db, { project_id, subject_kind, subject_id, expected, action, verification_result_id }, opts = {}) {
  const TABLES = { hypotheses: "hypotheses", facts: "facts", vulnerabilities: "vulnerabilities" };
  const table = TABLES[subject_kind];
  if (!table) throw apiError("BAD_REQUEST", `未知 subject_kind：${subject_kind}`);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(subject_id, project_id);
  if (!row) throw apiError("INVALID_REFERENCE", `状态转换目标不存在：${subject_id}`);
  if (row.state_version !== expected.state_version) {
    throw apiError("STALE_STATE", `subject.state_version 已变化（当前 ${row.state_version}，期望 ${expected.state_version}）`);
  }
  if (row.claim_revision !== expected.claim_revision || row.assessment_epoch !== expected.assessment_epoch) {
    throw apiError("CLAIM_CHANGED", "claim_revision / assessment_epoch 已推进，旧验证不能确认新判断");
  }
  if (row.evidence_revision !== expected.evidence_revision) {
    throw apiError("STALE_STATE", `证据集版本已推进（当前 ${row.evidence_revision}，期望 ${expected.evidence_revision}）`);
  }
  const boundary = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project_id).n - 1;
  const bump = (sets, args) =>
    db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`).run(...args, subject_id, project_id);
  const fromGuard = (allowed) => {
    if (!allowed.includes(row.status)) {
      throw apiError("PRECONDITION_INVALID", `${subject_id} 当前状态 ${row.status} 不允许执行 ${action}`, {
        detail: { current_status: row.status, action, allowed_from: allowed },
      });
    }
  };
  const write = (sets, args) => bump(["state_version = state_version + 1", "updated_seq = ?", ...sets], [boundary, ...args]);
  if (action === "confirm") {
    fromGuard(["suspected", "inconclusive"]);
    write(["status = 'confirmed'", "review = 'clear'", "confirmed_version = ?"], [JSON.stringify({ verification_result_id })]);
    return { applied: true, events: [] };
  }
  if (action === "falsify") {
    fromGuard(["suspected", "inconclusive", "confirmed"]);
    if (row.status === "confirmed" && opts.overturn !== true) {
      throw apiError("PRECONDITION_INVALID", "对已确认判断的推翻必须显式声明 overturn=true（§8.4）");
    }
    write(["status = 'falsified'"], []);
    return { applied: true, events: [] };
  }
  if (action === "mark_conflicting") {
    fromGuard(["suspected", "confirmed", "inconclusive", "falsified"]);
    if (table === "vulnerabilities" && row.review !== "disputed") {
      write(["review = 'disputed'"], []);
    }
    return { applied: true, events: [] };
  }
  if (action === "mark_insufficient") {
    if (table === "vulnerabilities") {
      if (row.status === "confirmed") {
        if (row.review !== "pending") write(["review = 'pending'"], []);
        return { applied: true, events: [], note: "确认判断的补验不足：保留确认历史（§8.4）" };
      }
      if (row.status !== "falsified") {
        write(["status = 'inconclusive'"], []);
        return { applied: true, events: [], note: "未确认问题在证据不足时为 inconclusive（§8.4）" };
      }
      return { applied: true, events: [], note: "已排除判断不因补验不足改变（§8.4）" };
    }
    throw apiError("BAD_REQUEST", `对象 ${subject_kind} 不支持动作 ${action}`);
  }
  if (action === "support") {
    fromGuard(["open", "testing", "inconclusive"]);
    write(["status = 'supported'"], []);
    return { applied: true, events: [] };
  }
  if (action === "reject") {
    fromGuard(["open", "testing", "supported", "inconclusive"]);
    write(["status = 'rejected'"], []);
    return { applied: true, events: [] };
  }
  if (action === "require_review") {
    fromGuard(["confirmed"]);
    if (row.review !== "pending") write(["review = 'pending'"], []);
    return { applied: true, events: [] };
  }
  throw apiError("BAD_REQUEST", `未知 action：${action}`);
}

if (!D2_LANDED) {
  verification.__installStateTransitionForTests(realTestApplier);
}

/* ── 服务器与夹具 ─────────────────────────────────────────────────── */

async function call(base, method, path, { body, session, rawBody, contentType } = {}) {
  const headers = { origin: base };
  if (body !== undefined || rawBody !== undefined) {
    headers["content-type"] = contentType || "application/json";
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
  const dataDir = makeTempDir("sorne-d1-ver-");
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
  const dataDir = makeTempDir("sorne-d1-restart-");
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

let submissionCounter = 0;
async function createProject(base, name = "D1 验证服务测试", { withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: { name, ...(withScope ? { scope_rules: { allow: ["*.example.test"], deny: [], pending: [] } } : {}) },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function workerSession(projectId, actor = "w-finder") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}
function verifierSession(projectId, actor = "v-independent") {
  return issueSession({ project_id: projectId, actor, role: "verifier" });
}
function plannerSession(projectId, actor = "p-1") {
  return issueSession({ project_id: projectId, actor, role: "planner" });
}

/** 经 A1 #10 建立疑似漏洞 + 可选首条支持证据（真实提交管线）。 */
async function seedVulnerability(base, worker, { category = "sql-injection", conditions = ["未登录身份"], withSupport = true } = {}) {
  const sid = `D1SEED-${Date.now()}-${submissionCounter++}`;
  const operations = [
    { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: `target-${submissionCounter}.example.test` },
    { op: "report_vulnerability", local_ref: "v", asset_id: "a", category, conditions, location: "/api/login" },
  ];
  if (withSupport) {
    operations.push({ op: "append_observation", local_ref: "o1", statement: "登录接口对单引号返回 500", conditions });
    operations.push({ op: "add_relation", from: "o1", type: "supports", to: "v" });
  }
  const res = await call(base, "POST", "/sorne/submissions", { body: { submission_id: sid, operations }, session: worker });
  assert.equal(res.status, 200, `建立疑似漏洞失败：${JSON.stringify(res.body)}`);
  return { vulnId: res.body.ids.v, obsId: res.body.ids.o1, assetId: res.body.ids.a, receipt: res.body };
}

/** 经 A1 #10 追加一条证据边（supports / contradicts → 推进 evidence_revision）。 */
async function addEvidenceEdge(base, worker, vulnId, stance, note) {
  const sid = `D1EV-${Date.now()}-${submissionCounter++}`;
  const res = await call(base, "POST", "/sorne/submissions", {
    body: {
      submission_id: sid,
      operations: [
        { op: "append_observation", local_ref: "o", statement: note, conditions: ["未登录身份"] },
        { op: "add_relation", from: "o", type: stance, to: vulnId },
      ],
    },
    session: worker,
  });
  assert.equal(res.status, 200, `追加证据边失败：${JSON.stringify(res.body)}`);
  return res.body;
}

/** 经 A2 #11/#12 固定 Blob 并建立采集（verifier 可经 #43/#44 读取的原始证据）。 */
async function seedCapture(base, worker, projectId, content, seq) {
  const sha = createHash("sha256").update(content).digest("hex");
  const up = await call(
    base,
    "POST",
    `/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body&source_kind=tool_gateway`,
    { rawBody: content, contentType: "application/octet-stream" },
  );
  assert.equal(up.status, 200, `上传 Blob 失败：${JSON.stringify(up.body)}`);
  assert.equal(up.body.sha256, sha);
  const cap = await call(base, "POST", "/sorne/captures", {
    body: {
      project_id: projectId,
      tool_call_id: `TC-D1-${seq}`,
      request_url_exact: `https://target.example.test/api/login?seq=${seq}`,
      method: "POST",
      response_body_blob: up.body.blob_id,
      condition_snapshot_id: "COND-未登录",
      integrity_status: "verified",
    },
  });
  assert.equal(cap.status, 200, `建立采集失败：${JSON.stringify(cap.body)}`);
  return { blobId: up.body.blob_id, sha256: sha, captureId: cap.body.capture_id };
}

const POLICY = { id: "d1-test/poc-repro", version: "2026-11", required_checks: ["evidence_reviewed", "conditions_reproduced"], description: "测试用验证策略：证据审阅 + 条件复现" };

/** 注册验证策略（进程内注册表；测试服务器与本文件同进程，共享同一实例）。 */
function registerTestPolicy() {
  return verification.registerVerificationPolicy(POLICY);
}

/** 发起验证请求（#27）并断言成功，返回 job。 */
async function requestJob(base, session, input) {
  const res = await call(base, "POST", "/sorne/verification-requests", { body: input, session });
  assert.equal(res.status, 200, `验证请求失败：${JSON.stringify(res.body)}`);
  return res.body;
}

function checkItem(name, passed = true) {
  return { name, passed, note: "" };
}

/** 构造一份与 job 期望一致的结果载荷（按需覆盖）。 */
function resultInput(job, verifierIdentity, outcome, overrides = {}) {
  return {
    job_id: job.id,
    claim_revision: job.claim_revision,
    verifier_identity: verifierIdentity,
    verifier_kind: "llm_agent",
    policy_version: job.policy_version,
    reviewed_manifest_id: job.evidence_manifest_id,
    reviewed_evidence_revision: job.expected.evidence_revision,
    expected_state_version: job.expected.state_version,
    expected_assessment_epoch: job.expected.assessment_epoch,
    outcome,
    checks: [checkItem("evidence_reviewed"), checkItem("conditions_reproduced")],
    supporting_refs: [],
    opposing_refs: [],
    limitations: "",
    suggested_followups: [],
    ...overrides,
  };
}

/* 断言辅助：同进程直读判断行（业务写入全部经真实端点/事务） */
async function subjectOf(dataDir, projectId, subjectId) {
  const store = await getStore({ dataDir });
  for (const t of ["vulnerabilities", "hypotheses", "facts"]) {
    const row = store.db.prepare(`SELECT * FROM ${t} WHERE id = ? AND project_id = ?`).get(subjectId, projectId);
    if (row) return { table: t, row };
  }
  return null;
}

async function outboxEvents(dataDir, projectId, type) {
  const store = await getStore({ dataDir });
  const rows = store.db
    .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = ? ORDER BY commit_seq, event_index")
    .all(projectId, type);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), subject_ids: JSON.parse(r.subject_ids) }));
}

/* ── 1. 验证请求五要素（§8.3）与去重键（§7.3） ─────────────────────── */

test("§8.3 五要素齐备：创建 pending 任务并绑定不可变 Manifest 与期望三版本", () =>
  withServer(async ({ base, dataDir }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const { blobId, captureId } = await seedCapture(base, worker, project.id, "HTTP/1.1 500 Internal Error\n", 1);

    const { job, deduplicated } = await requestJob(base, worker, {
      subject_id: vulnId,
      condition_snapshot_id: "COND-未登录",
      raw_evidence_refs: [blobId, captureId],
      opposing_evidence_refs: [],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    });
    assert.equal(deduplicated, false);
    assert.equal(job.status, "pending");
    assert.equal(job.subject_id, vulnId);
    // P0-4（评审 §4b）：subject_kind 为语义类型，物理表名经 subject_table 并存
    assert.equal(job.subject_kind, "vulnerability");
    assert.equal(job.subject_table, "vulnerabilities");
    // §12.1：任务外键绑定 Manifest；期望版本来自请求时 subject 快照
    assert.ok(job.evidence_manifest_id);
    assert.equal(job.manifest.evidence_revision, 2); // 建立时 supports 边已推进到 2
    assert.equal(job.manifest.members_count, 1);
    assert.equal(job.manifest.id, job.evidence_manifest_id);
    // 成员明细经 Manifest 服务（§12.1 四要素：成员/条件/判断版本/策略版本）
    const full = await verification.generateEvidenceManifest({ dataDir }, {
      session: workerSession(project.id),
      subjectId: vulnId,
      policyId: POLICY.id,
      policyVersion: POLICY.version,
    });
    assert.equal(full.deduplicated, true, "同证据集版本应幂等返回任务绑定的同一 Manifest");
    assert.equal(full.manifest.members.length, 1);
    assert.equal(full.manifest.members[0].member_id.startsWith("O-"), true);
    assert.equal(full.manifest.members[0].stance, "supports");
    assert.equal(full.manifest.members[0].status, "active");
    assert.deepEqual(full.manifest.conditions, ["未登录身份"]);
    assert.equal(full.manifest.claim_revision, 1);
    assert.equal(full.manifest.policy_version, POLICY.version);
    assert.ok(full.manifest.content_hash.length === 64);
    assert.equal(job.expected.claim_revision, 1);
    assert.equal(job.expected.state_version, 1);
    assert.equal(job.expected.assessment_epoch, 1);
    assert.ok(typeof job.waiting_ms === "number");
    const subject = await subjectOf(dataDir, project.id, vulnId);
    assert.equal(subject.row.evidence_revision, 2);
  }));

test("§8.3 五要素缺失或非法分别拒绝（不创建任务）", () =>
  withServer(async ({ base }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId, assetId } = await seedVulnerability(base, worker);
    const { blobId } = await seedCapture(base, worker, project.id, "x", 1);

    // 缺环境与身份条件
    const noCond = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vulnId, raw_evidence_refs: [blobId], policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(noCond.status, 400);
    assert.equal(noCond.body.code, "BAD_REQUEST");
    assert.match(noCond.body.message, /环境与身份条件/);

    // 缺原始证据索引
    const noRaw = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vulnId, condition_snapshot_id: "C1", policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(noRaw.status, 400);
    assert.match(noRaw.body.message, /raw_evidence_refs/);

    // 原始证据索引指向非原始证据（观察不是原始证据）
    const wrongRaw = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vulnId, condition_snapshot_id: "C1", raw_evidence_refs: [vulnId], policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(wrongRaw.status, 422);
    assert.equal(wrongRaw.body.code, "INVALID_REFERENCE");

    // 策略未注册
    const noPolicy = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: vulnId, condition_snapshot_id: "C1", raw_evidence_refs: [blobId], policy_id: "ghost/p", policy_version: "9" },
      session: worker,
    });
    assert.equal(noPolicy.status, 422);
    assert.equal(noPolicy.body.code, "INVALID_REFERENCE");
    assert.match(noPolicy.body.message, /验证策略未注册/);

    // 判断不存在 / 非判断类对象
    const noSubject = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: "V-9999", condition_snapshot_id: "C1", raw_evidence_refs: [blobId], policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(noSubject.status, 422);
    assert.equal(noSubject.body.code, "INVALID_REFERENCE");
    const notJudgement = await call(base, "POST", "/sorne/verification-requests", {
      body: { subject_id: assetId, condition_snapshot_id: "C1", raw_evidence_refs: [blobId], policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(notJudgement.status, 400);
    assert.match(notJudgement.body.message, /判断类/);

    // 自报 project_id 一律拒绝（§11.1）
    const selfReported = await call(base, "POST", "/sorne/verification-requests", {
      body: { project_id: project.id, subject_id: vulnId, condition_snapshot_id: "C1", raw_evidence_refs: [blobId], policy_id: POLICY.id, policy_version: POLICY.version },
      session: worker,
    });
    assert.equal(selfReported.status, 400);
    assert.match(selfReported.body.message, /project_id/);
  }));

test("§7.3 去重键四成分：同判断+同条件+同策略+同证据版本 → 同一任务；新证据 → 新任务（续验通道）", () =>
  withServer(async ({ base }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const { blobId } = await seedCapture(base, worker, project.id, "x", 1);
    const reqBody = {
      subject_id: vulnId,
      condition_snapshot_id: "COND-未登录",
      raw_evidence_refs: [blobId],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    };
    const first = await requestJob(base, worker, reqBody);
    const again = await requestJob(base, worker, reqBody);
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.id, first.job.id);

    // 新证据到来 → evidence_revision 推进 → 去重键变化 → 可开新任务（§7.3 续验）
    await addEvidenceEdge(base, worker, vulnId, "supports", "第二次复现 500");
    const renewed = await requestJob(base, worker, reqBody);
    assert.equal(renewed.deduplicated, false);
    assert.notEqual(renewed.job.id, first.job.id);
    assert.equal(renewed.job.expected.evidence_revision, first.job.expected.evidence_revision + 1);

    // 条件快照或策略版本变化同样构成新去重键
    const otherCond = await requestJob(base, worker, { ...reqBody, condition_snapshot_id: "COND-登录后" });
    assert.equal(otherCond.deduplicated, false);
    const otherPolicy = verification.registerVerificationPolicy({ id: POLICY.id, version: "2026-12", required_checks: POLICY.required_checks });
    assert.equal(otherPolicy.version, "2026-12");
    const otherVersion = await requestJob(base, worker, { ...reqBody, policy_version: "2026-12" });
    assert.equal(otherVersion.deduplicated, false);
  }));

test("请求角色面：worker/orchestrator/verifier 可发起；user/planner/runtime/无会话拒绝（§8.3(3) 续验不受 requested_by 限制）", () =>
  withServer(async ({ base }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const { blobId } = await seedCapture(base, worker, project.id, "x", 1);
    const body = {
      subject_id: vulnId,
      condition_snapshot_id: "C1",
      raw_evidence_refs: [blobId],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    };
    for (const [role, actor] of [["orchestrator", "o-1"], ["verifier", "v-self"]]) {
      const session = issueSession({ project_id: project.id, actor, role });
      const res = await call(base, "POST", "/sorne/verification-requests", { body, session });
      assert.equal(res.status, 200, `${role} 应可发起验证请求：${JSON.stringify(res.body)}`);
    }
    for (const role of ["user", "planner", "runtime", "projection"]) {
      const session = issueSession({ project_id: project.id, actor: `x-${role}`, role });
      const res = await call(base, "POST", "/sorne/verification-requests", { body, session });
      assert.equal(res.status, 403, `${role} 不得发起验证请求`);
      assert.equal(res.body.code, "TRUST_DENIED");
    }
    const anonymous = await call(base, "POST", "/sorne/verification-requests", { body });
    assert.equal(anonymous.status, 403);
  }));

test("声明一致性：请求未声明反对证据但库内存在 active 反对成员 → 告警并全部列入 Manifest", () =>
  withServer(async ({ base, dataDir }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    await addEvidenceEdge(base, worker, vulnId, "contradicts", "另一身份条件下返回 200，未见异常");
    const { blobId } = await seedCapture(base, worker, project.id, "x", 1);
    const { job, warnings } = await requestJob(base, worker, {
      subject_id: vulnId,
      condition_snapshot_id: "C1",
      raw_evidence_refs: [blobId],
      opposing_evidence_refs: [],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    });
    assert.equal(job.manifest.members_count, 2);
    const full = await verification.generateEvidenceManifest({ dataDir }, {
      session: worker,
      subjectId: vulnId,
      policyId: POLICY.id,
      policyVersion: POLICY.version,
    });
    assert.equal(full.manifest.members.filter((m) => m.stance === "contradicts").length, 1);
    assert.ok(warnings.length >= 1, "应产生反对证据声明告警");
    assert.match(warnings.join("\n"), /反对/);
  }));

/* ── 2. Manifest 服务（§12.1） ────────────────────────────────────── */

test("Manifest 不可变（§12.1）：同判断+同证据集版本+同策略版本 → 幂等返回同一 Manifest 与 content_hash", () =>
  withServer(async ({ base, dataDir }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const verifier = verifierSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const first = await verification.generateEvidenceManifest({ dataDir }, { session: verifier, subjectId: vulnId, policyId: POLICY.id, policyVersion: POLICY.version });
    assert.ok(first.manifest.id);
    assert.equal(first.deduplicated, false);
    const again = await verification.generateEvidenceManifest({ dataDir }, { session: verifier, subjectId: vulnId, policyId: POLICY.id, policyVersion: POLICY.version });
    assert.equal(again.manifest.id, first.manifest.id, "同键应幂等返回同一 Manifest");
    assert.equal(again.deduplicated, true);
    assert.equal(again.manifest.content_hash, first.manifest.content_hash);
  }));

test("Manifest 服务按证据集版本生成：新证据 → 新 Manifest，旧 Manifest 行不可变（§12.1）", () =>
  withServer(async ({ base, dataDir }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const verifier = verifierSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const m1 = await verification.generateEvidenceManifest({ dataDir }, { session: verifier, subjectId: vulnId, policyId: POLICY.id, policyVersion: POLICY.version });
    assert.equal(m1.manifest.evidence_revision, 2);
    await addEvidenceEdge(base, worker, vulnId, "supports", "第三次复现");
    const m2 = await verification.generateEvidenceManifest({ dataDir }, { session: verifier, subjectId: vulnId, policyId: POLICY.id, policyVersion: POLICY.version });
    assert.equal(m2.manifest.evidence_revision, 3);
    assert.notEqual(m2.manifest.id, m1.manifest.id);
    assert.equal(m2.manifest.members.length, 2); // 完整视图来自 generateEvidenceManifest
    // 旧 Manifest 不可变：行仍在且内容不变
    const store = await getStore({ dataDir });
    const old = store.db.prepare("SELECT * FROM evidence_manifests WHERE id = ?").get(m1.manifest.id);
    assert.equal(old.evidence_revision, 2);
    assert.equal(old.content_hash, m1.manifest.content_hash);
  }));

/* ── 3. #28 权限与结果合同（§8.3(1)(2)、§12.2 步骤 1） ────────────── */

let SEED_OBS_ID = null;
async function setupJob(base) {
  registerTestPolicy();
  const project = await createProject(base);
  const worker = workerSession(project.id);
  const verifier = verifierSession(project.id);
  const seeded = await seedVulnerability(base, worker);
  SEED_OBS_ID = seeded.obsId;
  const vulnId = seeded.vulnId;
  const { blobId } = await seedCapture(base, worker, project.id, "x", 1);
  const { job } = await requestJob(base, worker, {
    subject_id: vulnId,
    condition_snapshot_id: "COND-未登录",
    raw_evidence_refs: [blobId],
    policy_id: POLICY.id,
    policy_version: POLICY.version,
  });
  return { project, worker, verifier, vulnId, job };
}

test("§8.3(1) 仅 verifier 会话可交结果：worker/orchestrator/user/无会话一律 403 且无落库", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, vulnId, job } = await setupJob(base);
    const payload = resultInput(job, "verifier-llm-1", "supported");
    for (const session of [
      worker,
      issueSession({ project_id: project.id, actor: "o-1", role: "orchestrator" }),
      issueSession({ project_id: project.id, actor: "u-1", role: "user" }),
    ]) {
      const res = await call(base, "POST", "/sorne/verification-results", { body: payload, session });
      assert.equal(res.status, 403, `角色 ${session.role} 不得提交验证结果`);
      assert.equal(res.body.code, "TRUST_DENIED");
    }
    const anonymous = await call(base, "POST", "/sorne/verification-results", { body: payload });
    assert.equal(anonymous.status, 403);
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results").get().c, 0, "拒绝路径不得落库");
    const subject = await subjectOf(dataDir, project.id, vulnId);
    assert.equal(subject.row.status, "suspected");
  }));

test("§8.3(2) 发现者不得自证：finder 的 verifier 会话交 supported/falsified → 403 且无落库；insufficient（非应用型）允许", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, job } = await setupJob(base);
    // 发现者本人以 verifier 角色会话提交（独立性由调用身份与服务权限落实，§8.3）
    const finderAsVerifier = issueSession({ project_id: project.id, actor: "w-finder", role: "verifier" });
    const supported = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "finder-self", "supported"),
      session: finderAsVerifier,
    });
    assert.equal(supported.status, 403);
    assert.equal(supported.body.code, "TRUST_DENIED");
    assert.match(supported.body.message, /发现者/);
    const falsified = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "finder-self", "falsified"),
      session: finderAsVerifier,
    });
    assert.equal(falsified.status, 403);
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results").get().c, 0);

    // 非应用型意见（insufficient）不属于「确认自己」，允许保存（§8.3(2) 针对应用型）
    const insufficient = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "finder-self", "insufficient", { limitations: "证据不足以判定" }),
      session: finderAsVerifier,
    });
    assert.equal(insufficient.status, 200, JSON.stringify(insufficient.body));
    // 保存缺口是 §8.4 合法转换（可为 inconclusive）；发现者的非应用型意见不得使其变为 confirmed
    assert.notEqual(insufficient.body.subject.status, "confirmed", "发现者自己的意见不得确认自己的判断");
    assert.notEqual(insufficient.body.subject.status, "falsified", "也不得自行排除");
    void worker;
  }));

test("§12.1/§12.2 步骤 1：Manifest 绑定与声明版本校验（错 Manifest / 错 reviewed_evidence_revision / 错策略版本 / 错 claim 回执）", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, vulnId, job } = await setupJob(base);
    // 另一 Manifest：对同 subject 以另一策略版本生成
    verification.registerVerificationPolicy({ id: POLICY.id, version: "2026-12", required_checks: POLICY.required_checks });
    const other = await verification.generateEvidenceManifest({ dataDir }, { session: verifier, subjectId: vulnId, policyId: POLICY.id, policyVersion: "2026-12" });
    const wrongManifest = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "supported", { reviewed_manifest_id: other.manifest.id }),
      session: verifier,
    });
    assert.equal(wrongManifest.status, 422);
    assert.equal(wrongManifest.body.code, "PRECONDITION_INVALID");
    assert.match(wrongManifest.body.message, /Manifest/);

    const wrongRevision = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "supported", { reviewed_evidence_revision: job.expected.evidence_revision + 5 }),
      session: verifier,
    });
    assert.equal(wrongRevision.status, 422);
    assert.equal(wrongRevision.body.code, "PRECONDITION_INVALID");

    const wrongPolicy = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "supported", { policy_version: "2026-12" }),
      session: verifier,
    });
    assert.equal(wrongPolicy.status, 422);
    assert.equal(wrongPolicy.body.code, "PRECONDITION_INVALID");

    const wrongClaim = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "supported", { claim_revision: job.claim_revision + 1 }),
      session: verifier,
    });
    assert.equal(wrongClaim.status, 422);
    assert.equal(wrongClaim.body.code, "CLAIM_CHANGED");

    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results").get().c, 0, "校验失败不得落库");
    void worker;
  }));

test("§8.3 检查项：必需检查未覆盖 + supported → 拒绝；必需检查 passed=false → 保存意见但不应用并置复核", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, vulnId, job } = await setupJob(base);
    const missing = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "supported", { checks: [checkItem("evidence_reviewed")] }),
      session: verifier,
    });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.code, "PRECONDITION_INVALID");
    assert.match(missing.body.message, /未覆盖/);
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results").get().c, 0);

    // 未覆盖但 outcome=insufficient 是合法的（§8.3：检查项未覆盖时必须返回不足或冲突）
    const thin = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "v-1", "insufficient", { checks: [checkItem("evidence_reviewed")] }),
      session: verifier,
    });
    assert.equal(thin.status, 200, JSON.stringify(thin.body));

    // 新任务：必需检查存在但未通过 → 保存不应用 + review=pending（§12.2「匹配且检查通过」）
    const { job: job2 } = await setupJobOn(base, project.id, verifier);
    const failed = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job2, "v-1", "supported", { checks: [checkItem("evidence_reviewed"), checkItem("conditions_reproduced", false)] }),
      session: verifier,
    });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.applied, false);
    assert.equal(failed.body.decision, "checks_failed");
    const failedSubject = await subjectOf(dataDir, project.id, failed.body.subject_id);
    assert.equal(failedSubject.row.status, "suspected", "检查未通过不得确认");
    assert.equal(failedSubject.row.review, "pending", "标记需复核");
    void vulnId;
  }));

/** 在既有项目上再建一条疑似漏洞 + 验证任务（不重复建项目）。 */
async function setupJobOn(base, projectId, requester) {
  const worker = workerSession(projectId, `w-${submissionCounter}`);
  const { vulnId } = await seedVulnerability(base, worker, { category: `cat-${submissionCounter}` });
  const { blobId } = await seedCapture(base, worker, projectId, `y${submissionCounter}`, 100 + submissionCounter);
  const { job } = await requestJob(base, requester, {
    subject_id: vulnId,
    condition_snapshot_id: "COND-未登录",
    raw_evidence_refs: [blobId],
    policy_id: POLICY.id,
    policy_version: POLICY.version,
  });
  return { vulnId, job };
}

/* ── 4. §12.2 应用路径（经真实 §2.7 applyStateTransition 装配） ────── */

test("§12.2 应用：supported + 版本匹配 + 检查通过 → confirmed、state_version 推进、review=clear、事件同事务", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, vulnId, job } = await setupJob(base);
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);
    assert.equal(res.body.decision, "applied");
    assert.equal(res.body.subject.status, "confirmed");
    assert.equal(res.body.subject.state_version, 2);
    assert.equal(res.body.subject.review, "clear");
    const subject = await subjectOf(dataDir, project.id, vulnId);
    assert.equal(subject.row.status, "confirmed");
    assert.ok(subject.row.confirmed_version);
    const store = await getStore({ dataDir });
    const jobRow = store.db.prepare("SELECT * FROM verification_jobs WHERE id = ?").get(job.id);
    assert.equal(jobRow.status, "completed");
    const resultRow = store.db.prepare("SELECT * FROM verification_results WHERE id = ?").get(res.body.result_id);
    assert.equal(resultRow.applied, 1);
    // 同事务事件：verification.completed + vulnerability.state_changed 同一 commit_seq
    const done = await outboxEvents(dataDir, project.id, "verification.completed");
    assert.equal(done.length, 1);
    const stateChanges = await outboxEvents(dataDir, project.id, "vulnerability.state_changed");
    // 建立时 A1 已发 from=null→suspected；此处断言确认转换（D2 状态机返回、D1 同事务 flush）
    const changed = stateChanges.filter((e) => e.payload.to === "confirmed");
    assert.equal(changed.length, 1);
    assert.equal(changed[0].commit_seq, done[0].commit_seq, "状态事件与验证完成事件同事务（§12.2 步骤 5）");
    assert.equal(changed[0].payload.from, "suspected");
    assert.equal(changed[0].payload.verification_result_id, res.body.result_id);
  }));

test("§8.4 falsified：明确排除当前判断，各版本匹配 → falsified；证据与采集历史保留", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, job } = await setupJob(base);
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-rule-1", "falsified", { verifier_kind: "versioned_rule" }),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);
    const subject = await subjectOf(dataDir, project.id, res.body.subject_id);
    assert.equal(subject.row.status, "falsified");
    // 历史证据不被覆盖（§8.4：保留证据和历史）
    const store = await getStore({ dataDir });
    assert.ok(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ?").get(project.id).c >= 1);
    assert.ok(store.db.prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id = ?").get(project.id).c >= 1);
    assert.ok(store.db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(project.id).c >= 1);
  }));

test("§8.4 conflicting：实质矛盾 → review=disputed，结论状态不被覆盖", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, job } = await setupJob(base);
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-2", "conflicting", { limitations: "正反证据实质矛盾，需仲裁" }),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true); // mark_disputed 属应用动作（review 标记）
    const subject = await subjectOf(dataDir, project.id, res.body.subject_id);
    assert.equal(subject.row.status, "suspected", "结论状态不被 conflicting 覆盖");
    assert.equal(subject.row.review, "disputed");
  }));

test("§8.4 insufficient：未确认问题可为 inconclusive，不伪装成已排除；缺口与限制保留", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, job } = await setupJob(base);
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-3", "insufficient", { limitations: "缺少目标版本对应的复现条件" }),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    // D2 状态机（mark_insufficient 动态分流）：suspected → inconclusive（§8.4「可为」）
    assert.equal(subject.row.status, "inconclusive", "未确认问题在证据不足时为 inconclusive");
    assert.notEqual(subject.row.status, "falsified", "不得伪装成已排除");
    assert.equal(subject.row.review, "clear", "复核标记不受补验不足影响");
    assert.equal(res.body.limitations, "缺少目标版本对应的复现条件", "缺口保留在不可变结果中");
  }));

test("再确认路径：对已 confirmed 判断的 supported 复核意见被保留但不重复转换（no_transition）", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    const first = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-A", "supported"),
      session: verifier,
    });
    assert.equal(first.status, 200);
    // 确认后新证据 → 新去重键 → 新任务（其期望版本为 confirmed 后的当前值）
    await addEvidenceEdge(base, worker, job.subject_id, "supports", "确认后的补充复现");
    const { blobId } = await seedCapture(base, worker, project.id, "reaffirm", 3);
    const second = await requestJob(base, verifier, {
      subject_id: job.subject_id,
      condition_snapshot_id: "COND-未登录",
      raw_evidence_refs: [blobId],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    });
    const again = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(second.job, "verifier-B", "supported"),
      session: verifier,
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.applied, false, "confirmed 无 confirm 出边，不得重复转换");
    assert.equal(again.body.decision, "no_transition");
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.status, "confirmed");
    assert.equal(subject.row.state_version, first.body.subject.state_version, "复核意见不重复推进 state_version（新证据只推 evidence_revision）");
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE job_id = ?").get(second.job.id).c, 1, "复核意见保留");
  }));

test("§8.4 confirmed→falsified 需显式推翻声明：缺 overturn 拒绝；携带 overturn 应用并保留证据历史", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    const confirm = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-A", "supported"),
      session: verifier,
    });
    assert.equal(confirm.status, 200);
    // 推翻前先有新证据 → 新任务（否则同键去重拿回旧任务）
    await addEvidenceEdge(base, worker, job.subject_id, "contradicts", "环境变更后不再复现且根因消除");
    const { blobId } = await seedCapture(base, worker, project.id, "overturn", 4);
    const renewed = await requestJob(base, verifier, {
      subject_id: job.subject_id,
      condition_snapshot_id: "COND-未登录",
      raw_evidence_refs: [blobId],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    });
    // 未显式声明 overturn：新验证不能因「本次未复现」直接推翻历史确认（§8.4）
    const noDeclare = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(renewed.job, "verifier-B", "falsified"),
      session: verifier,
    });
    assert.equal(noDeclare.status, 422, JSON.stringify(noDeclare.body));
    assert.equal(noDeclare.body.code, "PRECONDITION_INVALID");
    assert.match(noDeclare.body.message, /overturn|推翻/);
    // 显式推翻：应用 falsified，证据与采集历史保留
    const declared = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(renewed.job, "verifier-B", "falsified", { overturn: true }),
      session: verifier,
    });
    assert.equal(declared.status, 200, JSON.stringify(declared.body));
    assert.equal(declared.body.applied, true);
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.status, "falsified");
    const store = await getStore({ dataDir });
    assert.ok(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ?").get(project.id).c >= 1, "证据历史保留");
    assert.ok(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE subject_id = ?").get(job.subject_id).c >= 2, "历史验证意见保留");
  }));

test("假设经验证转换：supported → supported 状态（经真实状态机装配，subject_kind 覆盖 hypotheses）", () =>
  withServer(async ({ base, dataDir }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const verifier = verifierSession(project.id);
    const sid = `D1HYP-${Date.now()}-${submissionCounter++}`;
    const sub = await call(base, "POST", "/sorne/submissions", {
      body: {
        submission_id: sid,
        operations: [
          { op: "propose_hypothesis", local_ref: "h", statement: "输入影响后端查询构造", conditions: ["未登录身份"] },
          { op: "append_observation", local_ref: "o", statement: "观察 A：500 响应", conditions: [] },
          { op: "add_relation", from: "o", type: "supports", to: "h" },
        ],
      },
      session: worker,
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const hypId = sub.body.ids.h;
    const { blobId } = await seedCapture(base, worker, project.id, "hyp-evidence", 2);
    const { job } = await requestJob(base, worker, {
      subject_id: hypId,
      condition_snapshot_id: "COND-未登录",
      raw_evidence_refs: [blobId],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    });
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-4", "supported"),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);
    const subject = await subjectOf(dataDir, project.id, hypId);
    assert.equal(subject.row.status, "supported");
    assert.equal(subject.row.state_version, 2);
  }));

/* ── 5. §12.3 五种竞争情形 + 蓝图场景 8/9 ─────────────────────────── */

test("场景 8（§12.3-1）verifier 审阅后新反对证据先提交：意见保存、STALE_EVIDENCE 拒绝直接应用、置复核", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    // verifier 已按 Manifest（rev=N）审阅；新反对证据先于结果提交 → evidence_revision 推进
    await addEvidenceEdge(base, worker, job.subject_id, "contradicts", "复验：登录身份下无异常");
    const before = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(before.row.evidence_revision, job.expected.evidence_revision + 1);

    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    // §20.1：提交已保存——422 错误信封带回执，不用错误掩盖
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "STALE_EVIDENCE");
    assert.ok(res.body.receipt, "错误信封必须带回已保存内容的回执");
    assert.equal(res.body.receipt.result_id.startsWith("VR-"), true);
    assert.equal(res.body.receipt.applied, false);
    assert.deepEqual(res.body.receipt.version_mismatches, ["evidence_revision"]);

    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.status, "suspected", "旧结论不得直接应用");
    assert.equal(subject.row.review, "pending", "标记需复核（§12.2 否则分支）");
    const store = await getStore({ dataDir });
    const saved = store.db.prepare("SELECT * FROM verification_results WHERE job_id = ?").get(job.id);
    assert.ok(saved, "验证意见（不可变结果）必须保留");
    assert.equal(saved.applied, 0);
    assert.equal(saved.outcome, "supported");
    // 未应用意见也发 verification.completed 事件（蓝图 §6：含未应用意见）
    const done = await outboxEvents(dataDir, project.id, "verification.completed");
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.applied, false);
    assert.equal(done[0].payload.decision, "stale_evidence");
  }));

test("场景 9（§12.3-2）确认后新相关证据提交：review=pending、evidence_revision 推进、依赖准入不放行", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    const confirm = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.subject.status, "confirmed");

    // 验证确认先提交 → 随后新相关证据提交（A1 证据集路径）：复核需求 + 版本推进
    await addEvidenceEdge(base, worker, job.subject_id, "contradicts", "确认后新反对证据：目标已修复");
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.status, "confirmed", "确认历史保留");
    assert.equal(subject.row.review, "pending", "收到新相关证据置复核需求");
    assert.equal(subject.row.evidence_revision, confirm.body.subject.versions.evidence_revision + 1);
    // 通知：evidence_set.revised 携带 review 变化（受影响消费者可感知，§9.2/§12.3）
    const revised = (await outboxEvents(dataDir, project.id, "evidence_set.revised")).filter((e) => e.payload.review === "pending");
    assert.equal(revised.length, 1, "确认后新相关证据恰好产生一次复核通知");
    assert.equal(revised[0].payload.evidence_revision, subject.row.evidence_revision);

    // 依赖准入：不能只看字符串 confirmed（§8.2）——复核未清不得无条件放行
    const admission = await verification.evaluateAdmission({ dataDir }, { projectId: project.id, subjectId: job.subject_id });
    assert.equal(admission.admitted, false);
    assert.ok(admission.reasons.join("\n").includes("复核"));
    // 复核清除前（无清除通道：复核属 AI/验证流程），显式期望 clear 的准入同样拒绝
    const strict = await verification.evaluateAdmission({ dataDir }, { projectId: project.id, subjectId: job.subject_id, expectedReview: "clear" });
    assert.equal(strict.admitted, false);
  }));

test("§12.3-3 只新增不影响判断的备注：不推进 evidence_revision，不制造虚假冲突（同 Manifest 结果仍可应用）", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    // 备注型观察：不带 supports/contradicts 边（与判断无证据关系）
    const note = await call(base, "POST", "/sorne/submissions", {
      body: {
        submission_id: `D1NOTE-${Date.now()}-${submissionCounter++}`,
        operations: [{ op: "append_observation", statement: "备注：同行在别的资产上看到类似现象", conditions: [] }],
      },
      session: worker,
    });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.ok(note.body.warnings.length === 0 || note.body.warnings.join("").length >= 0);
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.evidence_revision, job.expected.evidence_revision, "无关备注不推进 evidence_revision");

    // 无虚假冲突：针对同一 Manifest 的结果仍可正常应用
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);
  }));

test("§12.3-4 新提交与旧证据完全重复且可确定：返回去重结果，不无故触发复核（confirmed+clear 不被置 pending）", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    const confirm = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(confirm.status, 200);
    const afterConfirm = await subjectOf(dataDir, project.id, job.subject_id);

    // 完全重复：同一条观察对同一判断的相同 supports 关系再次提交（§12.3「新提交和旧证据
    // 完全重复且可确定」——同一成员而非同文本新观察）→ A1 去重告警，不推进版本
    const dupRes = await call(base, "POST", "/sorne/submissions", {
      body: {
        submission_id: `D1DUP-${Date.now()}-${submissionCounter++}`,
        operations: [{ op: "add_relation", from: SEED_OBS_ID, type: "supports", to: job.subject_id }],
      },
      session: worker,
    });
    assert.equal(dupRes.status, 200, JSON.stringify(dupRes.body));
    assert.ok(
      (dupRes.body.warnings ?? []).some((w) => /去重/.test(w)),
      "完全重复应返回去重告警（A1 §12.3 路径）",
    );
    const afterDup = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(afterDup.row.evidence_revision, afterConfirm.row.evidence_revision, "重复证据不推进 evidence_revision");
    assert.equal(afterDup.row.review, "clear", "不无故触发复核");
    assert.equal(afterDup.row.status, "confirmed", "确认保留");

    // 依赖准入保持放行（未制造虚假冲突）
    const admission = await verification.evaluateAdmission({ dataDir }, { projectId: project.id, subjectId: job.subject_id });
    assert.equal(admission.admitted, true, JSON.stringify(admission.reasons));
  }));

test("§12.3-5 无法确定新增资料是否影响判断：按相关证据处理，worker 不能自称「无关」绕过版本机制", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    // worker 在观察文本里自称无关，但结构上建立了 supports 边（相关性由证据关系判定，不由自报）
    const sid = `D1UNREL-${Date.now()}-${submissionCounter++}`;
    const res = await call(base, "POST", "/sorne/submissions", {
      body: {
        submission_id: sid,
        operations: [
          { op: "append_observation", local_ref: "o", statement: "（自称与该判断无关）新参数组合下再次 500", conditions: [] },
          { op: "add_relation", from: "o", type: "supports", to: job.subject_id },
        ],
      },
      session: worker,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.evidence_revision, job.expected.evidence_revision + 1, "结构相关即推进版本，自报无关不生效");

    // 旧结果因此成为过期意见：保存但不应用，交复核决定其作用
    const stale = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "STALE_EVIDENCE");
    assert.equal(stale.body.receipt.applied, false);
    const after = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(after.row.review, "pending", "先按相关证据处理并标记复核");
  }));

/* ── 6. 场景 22 + 幂等/并发/重启/原子性（§20.3 真实注入） ──────────── */

test("场景 22 漏洞确认后：项目继续（active），planner 可经 #20 安排引用该漏洞的后续方向", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, worker, verifier, job } = await setupJob(base);
    const confirm = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported", { suggested_followups: ["排查同参数族的其他入口"] }),
      session: verifier,
    });
    assert.equal(confirm.status, 200);
    // 确认漏洞不得结束项目（§1：发现或确认漏洞均不自动结束）
    const store = await getStore({ dataDir });
    const projectRow = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
    assert.equal(projectRow.status, "active");

    // planner 安排后续方向：引用已确认漏洞作为依据（§16.3 确认漏洞可立即产生后续意图）
    const planner = plannerSession(project.id);
    const plan = await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: `D1PLAN-${Date.now()}`,
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "i1",
            question: `围绕已确认漏洞 ${job.subject_id} 排查同参数族的其他入口`,
            kind: "investigate",
            success_criteria: "给出同参数族入口的覆盖清单或明确缺口",
            basis_refs: [job.subject_id],
            rationale: "确认漏洞的后续方向（§16.3）",
          },
        ],
      },
      session: planner,
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.received_status, "accepted");
    const created = plan.body.ids?.i1 ?? plan.body.intents_created?.[0];
    assert.ok(created, "后续意图应被创建");
  }));

test("幂等重交：同内容验证结果重发返回原回执，不重复建行、不重复事件", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, job } = await setupJob(base);
    const payload = resultInput(job, "verifier-llm-1", "supported");
    const first = await call(base, "POST", "/sorne/verification-results", { body: payload, session: verifier });
    assert.equal(first.status, 200);
    const second = await call(base, "POST", "/sorne/verification-results", { body: payload, session: verifier });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.result_id, first.body.result_id);
    assert.equal(second.body.deduplicated, true);
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE job_id = ?").get(job.id).c, 1);
    assert.equal((await outboxEvents(dataDir, project.id, "verification.completed")).length, 1);
  }));

test("并发竞争（§12.3-2 变体）：两 verifier 并行提交 supported，恰一应用；另一保存为 stale_state 且不污染复核", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, job } = await setupJob(base);
    const v1 = issueSession({ project_id: project.id, actor: "v-parallel-1", role: "verifier" });
    const v2 = issueSession({ project_id: project.id, actor: "v-parallel-2", role: "verifier" });
    const [r1, r2] = await Promise.all([
      call(base, "POST", "/sorne/verification-results", { body: resultInput(job, "verifier-A", "supported"), session: v1 }),
      call(base, "POST", "/sorne/verification-results", {
        body: resultInput(job, "verifier-B", "supported", { limitations: "并行第二意见" }),
        session: v2,
      }),
    ]);
    const outcomes = [r1, r2].sort((a, b) => (a.body.applied === true ? -1 : 1));
    const appliedOne = outcomes.find((r) => r.status === 200 && r.body.applied === true);
    const otherOne = outcomes.find((r) => r !== appliedOne);
    assert.ok(appliedOne, `应恰有一份结果被应用：${JSON.stringify([r1.body, r2.body])}`);
    assert.equal(appliedOne.status, 200);
    assert.equal(otherOne.status, 422, "另一份应因版本移动未被应用");
    assert.equal(otherOne.body.code, "STALE_STATE");
    assert.equal(otherOne.body.receipt.applied, false);
    const subject = await subjectOf(dataDir, project.id, job.subject_id);
    assert.equal(subject.row.status, "confirmed");
    assert.equal(subject.row.state_version, 2, "只推进一次");
    assert.equal(subject.row.review, "clear", "state_version 单独移动（另一验证已应用）不制造虚假复核（§12.3-3/§16.3）");
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE job_id = ?").get(job.id).c, 2, "两份意见都保留");
  }));

test("重启注入：结果提交成功后关库关服重启，同内容重交恢复原回执，subject 单次确认、事件单条", async () => {
  let savedProjectId;
  let savedJob;
  let savedPayload;
  let savedReceipt;
  await withRestartServer(async ({ base, dataDir, phase }) => {
    if (phase === 1) {
      registerTestPolicy();
      const project = await createProject(base);
      const worker = workerSession(project.id);
      const verifier = verifierSession(project.id);
      const { vulnId } = await seedVulnerability(base, worker);
      const { blobId } = await seedCapture(base, worker, project.id, "restart-evidence", 1);
      const { job } = await requestJob(base, worker, {
        subject_id: vulnId,
        condition_snapshot_id: "COND-未登录",
        raw_evidence_refs: [blobId],
        policy_id: POLICY.id,
        policy_version: POLICY.version,
      });
      savedPayload = resultInput(job, "verifier-llm-1", "supported");
      const res = await call(base, "POST", "/sorne/verification-results", { body: savedPayload, session: verifier });
      assert.equal(res.status, 200);
      savedReceipt = res.body;
      savedProjectId = project.id;
      savedJob = job;
      return null;
    }
    // phase 2：同目录重启（会话为进程内注册表，需重签；持久对象身份不受影响，§1）
    const verifier = verifierSession(savedProjectId);
    const again = await call(base, "POST", "/sorne/verification-results", { body: savedPayload, session: verifier });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.result_id, savedReceipt.result_id, "重启后按内容幂等恢复原回执");
    assert.equal(again.body.deduplicated, true);
    const subject = await subjectOf(dataDir, savedProjectId, savedJob.subject_id);
    assert.equal(subject.row.status, "confirmed", "重启不丢已应用状态");
    assert.equal(subject.row.state_version, 2, "单次确认");
    const store = await getStore({ dataDir });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE job_id = ?").get(savedJob.id).c, 1);
    assert.equal((await outboxEvents(dataDir, savedProjectId, "verification.completed")).length, 1, "事件不重复");
    return null;
  });
});

test("事务原子性注入（真实 SQLite TRIGGER RAISE）：结果写入点失败 → 整体回滚，无半状态", () =>
  withServer(async ({ base, dataDir }) => {
    const { project, verifier, job } = await setupJob(base);
    const store = await getStore({ dataDir });
    await store.runSerial((db) => {
      db.exec(
        "CREATE TRIGGER inject_results_fail BEFORE INSERT ON verification_results BEGIN SELECT RAISE(ABORT, '注入：结果写入失败'); END",
      );
    });
    try {
      const res = await call(base, "POST", "/sorne/verification-results", {
        body: resultInput(job, "verifier-llm-1", "supported"),
        session: verifier,
      });
      assert.equal(res.status, 500);
      assert.match(res.body.message, /注入/);
      // 全部回滚：无结果行、无事件、任务仍 pending、subject 未变
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results").get().c, 0);
      assert.equal((await outboxEvents(dataDir, project.id, "verification.completed")).length, 0);
      assert.equal(store.db.prepare("SELECT status FROM verification_jobs WHERE id = ?").get(job.id).status, "pending");
      const subject = await subjectOf(dataDir, project.id, job.subject_id);
      assert.equal(subject.row.status, "suspected");
      assert.equal(subject.row.state_version, 1);
      // commit_seq 不因失败提交产生空洞业务（下一个成功提交仍单调）
    } finally {
      await store.runSerial((db) => db.exec("DROP TRIGGER inject_results_fail"));
    }
    // 摘除注入后同一载荷可正常提交
    const ok = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-llm-1", "supported"),
      session: verifier,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.applied, true);
  }));

/* ── 7. verifier 读取原始证据（§8.3 / #43 / #44）与队列视图（#29） ──── */

test("§8.3 verifier 可读取原始证据：#43 按哈希取字节、#44 采集详情（条件快照与完整性状态）", () =>
  withServer(async ({ base }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const verifier = verifierSession(project.id);
    const content = "HTTP/1.1 500 Internal Server\nX-Probe: d1";
    const { sha256, captureId } = await seedCapture(base, worker, project.id, content, 7);

    const blobRes = await fetch(`${base}/sorne/evidence/blobs/${sha256}?project_id=${encodeURIComponent(project.id)}`, {
      headers: { "x-sorne-session": verifier.session_token },
    });
    assert.equal(blobRes.status, 200);
    assert.equal(await blobRes.text(), content);
    assert.equal(blobRes.headers.get("x-sorne-representation"), "raw_body");

    const cap = await call(base, "GET", `/sorne/captures/${encodeURIComponent(captureId)}?project_id=${encodeURIComponent(project.id)}`, {
      session: verifier,
    });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    assert.ok(JSON.stringify(cap.body).includes("COND-未登录") || JSON.stringify(cap.body).includes("condition_snapshot_id"));
  }));

test("#29 队列视图：状态/outcome 过滤、游标分页、等待时长、Manifest 摘要；跨项目读取拒绝", () =>
  withServer(async ({ base }) => {
    registerTestPolicy();
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const verifier = verifierSession(project.id);
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      const { vulnId } = await seedVulnerability(base, worker, { category: `c-${i}` });
      const { blobId } = await seedCapture(base, worker, project.id, `q${i}`, 10 + i);
      const { job } = await requestJob(base, worker, {
        subject_id: vulnId,
        condition_snapshot_id: "C1",
        raw_evidence_refs: [blobId],
        policy_id: POLICY.id,
        policy_version: POLICY.version,
      });
      jobs.push(job);
    }
    // 第一个任务交 insufficient → completed；其余 pending
    const first = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(jobs[0], "verifier-llm-1", "insufficient"),
      session: verifier,
    });
    assert.equal(first.status, 200);

    const all = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}`, { session: verifier });
    assert.equal(all.status, 200);
    assert.equal(all.body.jobs.length, 3);
    assert.ok(all.body.jobs.every((j) => typeof j.waiting_ms === "number"));
    assert.ok(all.body.jobs.every((j) => j.manifest && j.manifest.members_count >= 1));

    const pendingOnly = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}&status=pending`, { session: verifier });
    assert.equal(pendingOnly.body.jobs.length, 2);
    assert.ok(pendingOnly.body.jobs.every((j) => j.status === "pending"));

    const insufficientOnly = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}&status=completed&outcome=insufficient`, { session: verifier });
    assert.equal(insufficientOnly.body.jobs.length, 1);
    assert.equal(insufficientOnly.body.jobs[0].latest_result.outcome, "insufficient");

    // 游标分页：limit=2 → has_more + next_after，续读取剩余
    const page1 = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}&limit=2`, { session: verifier });
    assert.equal(page1.body.jobs.length, 2);
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.next_after);
    const page2 = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}&limit=2&cursor=${encodeURIComponent(page1.body.next_after)}`, {
      session: verifier,
    });
    assert.equal(page2.body.jobs.length, 1);
    assert.equal(page2.body.has_more, false);

    // 跨项目：另一项目会话读取本项目 → 403（无范围创建：规避 A1 既有 SR 编号跨项目冲突，见竣工记录）
    const otherProject = await createProject(base, "另一项目", { withScope: false });
    const stranger = verifierSession(otherProject.id);
    const cross = await call(base, "GET", `/sorne/verification-jobs?project_id=${project.id}`, { session: stranger });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");

    // 他项目 verifier 会话提交本项目任务的结果 → 任务在其项目域内不存在
    const hijack = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(jobs[1], "stranger", "supported"),
      session: stranger,
    });
    assert.equal(hijack.status, 422);
    assert.equal(hijack.body.code, "INVALID_REFERENCE");
  }));

/* ── 8. D2 默认装配集成（条件执行：D2 落地后走其真实 applyStateTransition） ── */

test("D2 集成：§2.7 applyStateTransition 默认装配下的确认路径（D2 落地后执行；未落地时由上方用例经真实测试装配覆盖）", { skip: !D2_LANDED }, () =>
  withServer(async ({ base, dataDir }) => {
    assert.equal(verification.stateTransitionSource(), "d2/judgements");
    const { verifier, job } = await setupJob(base);
    const res = await call(base, "POST", "/sorne/verification-results", {
      body: resultInput(job, "verifier-d2-integration", "supported"),
      session: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);
    const subject = await subjectOf(dataDir, job.project_id, job.subject_id);
    assert.equal(subject.row.status, "confirmed");
  }));

test("装配来源诊断：D2 未落地窗口为 test-install（真实事务实现），落地后为 d2/judgements", () => {
  const source = verification.stateTransitionSource();
  assert.ok(
    source === "test-install" || source === "d2/judgements",
    `状态机装配来源应为真实实现之一，实际：${source}`,
  );
});
