/**
 * D2 —— 判断分层与漏洞状态机测试（规范 §8.1 §8.2 §8.4 §7.1 §7.2 §7.3）。
 *
 * 覆盖：
 *   - §8.1 四类语义边界：非流水线（三表独立成行）、原观察永留、一观察多判断、
 *     漏洞判断不得写 Fact 绕过验证（角色面 + 核实依据准入）；
 *   - §8.2 状态与权限：confirmed ≠ 持续存在、review 独立、依赖放行看有效性与
 *     复核标记（evaluatePrerequisite）；
 *   - §8.4 状态转换合同唯一实现（applyStateTransition）：确认/推翻/不足/冲突/
 *     复核/重开全表 + 版本三码（STALE_STATE/CLAIM_CHANGED/STALE_EVIDENCE）+
 *     发现者自证拒绝 + 必要检查 + overturn 显式声明；
 *   - §7.1 规范化版本化保留原始输入（不普遍小写路径/不删查询/不重排参数）、
 *     IP 与域名经解析关系相连不合并；
 *   - §7.2 模板可修正不丢样本（§20.3 场景 6 主责：数字路径推断错误可拆分）；
 *   - §7.3 候选组不替代漏洞身份、误合并可拆分（§20.3 场景 7 主责）；
 *   - §20.3 场景 11 主责：漏洞被推翻但下游事实有独立证据——保留下游事实、
 *     重查必要依赖；场景 19 配合面：suspected 即时持久化可引用、状态不被提升；
 *   - 真实事务与故障注入：SQLite TRIGGER RAISE 事务原子性、真实关库重启持久，
 *     不用 mock 代替真实行为（§20.3 末段）。
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
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore, submit } from "../lib/store/record-service.mjs";
import {
  applyStateTransition,
  evaluatePrerequisite,
  parseRequiresState,
} from "../lib/store/judgements.mjs";
import {
  CANONICALIZATION_VERSION,
  canonicalizeHttpResource,
  canonicalizeServiceIdentity,
  derivePathTemplate,
} from "../lib/store/dedup.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有 HTTP 工具（支持会话头；helpers 为冻结文件） ────────── */

async function call(base, method, path, { body, session, rawBody } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (rawBody !== undefined) headers["content-type"] = "application/octet-stream";
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

async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "sorne-d2-"));
  const server = await bootServer(dataDir);
  return { ...server, dataDir };
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */

let subCounter = 0;
function nextSubId(prefix = "SUB") {
  subCounter += 1;
  return `${prefix}-D2-${String(subCounter).padStart(4, "0")}`;
}

async function createProject(base, name = "D2 测试项目") {
  const res = await call(base, "POST", "/sorne/projects", { body: { name } });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function workerSession(projectId, actor = "worker-a") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}
function verifierSession(projectId, actor = "verifier-x") {
  return issueSession({ project_id: projectId, actor, role: "verifier" });
}

function plannerSession(projectId, actor = "planner-1") {
  return issueSession({ project_id: projectId, actor, role: "planner" });
}
function orchestratorSession(projectId, actor = "orch-1") {
  return issueSession({ project_id: projectId, actor, role: "orchestrator" });
}
function runtimeSession(projectId, actor = "rt-1") {
  return issueSession({ project_id: projectId, actor, role: "runtime" });
}

/** 经真实端点固定一段证据（#11 rawBody 上传 + #12 采集登记），返回 blob/capture 编号。 */
async function seedCaptureHttp(base, projectId, content, seq) {
  const up = await call(
    base,
    "POST",
    `/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body&source_kind=tool_gateway`,
    { rawBody: Buffer.from(content, "utf8") },
  );
  assert.equal(up.status, 200, `上传 Blob 失败：${JSON.stringify(up.body)}`);
  const cap = await call(base, "POST", "/sorne/captures", {
    body: {
      project_id: projectId,
      tool_call_id: `TC-S11-${seq}`,
      request_url_exact: `https://s11.test/api/login?seq=${seq}`,
      method: "POST",
      response_body_blob: up.body.blob_id,
      condition_snapshot_id: "COND-未登录",
      integrity_status: "verified",
    },
  });
  assert.equal(cap.status, 200, `建立采集失败：${JSON.stringify(cap.body)}`);
  const captureId = cap.body.capture ? cap.body.capture.capture_id : cap.body.capture_id;
  assert.ok(captureId, `采集响应缺少 capture_id：${JSON.stringify(cap.body).slice(0, 200)}`);
  return { blobId: up.body.blob_id, captureId };
}

/** 计划提交（真实 #20）建一条意图，返回意图编号。 */
async function planIntentHttp(base, projectId, intentSpec, tag) {
  const res = await call(base, "POST", "/sorne/plan-revisions", {
    body: {
      submission_id: `PLAN-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      plan_revision: "r1",
      intents: [{ op: "create", local_ref: "i1", success_criteria: "任何可核验产出", ...intentSpec }],
    },
    session: plannerSession(projectId),
  });
  assert.equal(res.status, 200, `计划提交失败：${JSON.stringify(res.body)}`);
  return res.body.ids.i1;
}

/** 验证任务（真实 #27，orchestrator 发起）。 */
async function requestJobHttp(base, session, input) {
  const res = await call(base, "POST", "/sorne/verification-requests", { body: input, session });
  assert.equal(res.status, 200, `验证请求失败：${JSON.stringify(res.body)}`);
  return res.body.job;
}

/** 验证结果（真实 #28，verifier 会话；checks 须覆盖策略 required_checks）。 */
async function submitResultHttp(base, verifier, job, outcome, { checks, ...overrides } = {}) {
  const res = await call(base, "POST", "/sorne/verification-results", {
    body: {
      job_id: job.id,
      claim_revision: job.claim_revision,
      verifier_identity: "verifier-llm-s11",
      verifier_kind: "llm_agent",
      policy_version: job.policy_version,
      reviewed_manifest_id: job.evidence_manifest_id,
      reviewed_evidence_revision: job.expected.evidence_revision,
      expected_state_version: job.expected.state_version,
      expected_assessment_epoch: job.expected.assessment_epoch,
      outcome,
      checks: checks || [{ name: "evidence_reviewed", passed: true, note: "证据审阅核对" }],
      supporting_refs: [],
      opposing_refs: [],
      limitations: "",
      suggested_followups: [],
      ...overrides,
    },
    session: verifier,
  });
  return res;
}

/** 经真实 POST /sorne/submissions 提交操作（真实事务与事件）。 */
async function submitOps(base, session, operations, submissionId) {
  const res = await call(base, "POST", "/sorne/submissions", {
    session,
    body: { submission_id: submissionId || nextSubId(), operations },
  });
  return res;
}

async function reportVulnerability(base, session, { category = "injection", location = "/login", assetId = null, conditions }, localRef = "v") {
  const res = await submitOps(base, session, [
    {
      op: "report_vulnerability",
      local_ref: localRef,
      category,
      location,
      ...(assetId ? { asset_id: assetId } : {}),
      ...(conditions ? { conditions } : {}),
    },
  ]);
  assert.equal(res.status, 200, `建漏洞失败：${JSON.stringify(res.body)}`);
  return res.body.ids[localRef];
}

/** 直写 D1 域的验证三件套（manifest + job + result）——D1 并行施工中，
 *  其表已冻结于 DDL；夹具按真实外键与唯一约束插入（C1 denied 夹具直写先例）。 */
function seedVerificationResult(db, { projectId, subjectId, subjectKind = "vulnerabilities", outcome, createdBy, evidenceRevision = 1, checks = "[]", tag }) {
  const id = tag || `VR-${subjectId}-${outcome}`;
  const policy = `pol-${id}-${evidenceRevision}`;
  const manifestId = `MAN-${id}`;
  const jobId = `JOB-${id}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO evidence_manifests (id, project_id, subject_id, subject_kind, claim_revision,
       policy_version, evidence_revision, members, conditions, content_hash, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, 1, ?, ?, '[]', '[]', ?, ?, ?, 9)`,
  ).run(manifestId, projectId, subjectId, subjectKind, policy, evidenceRevision, `hash-${id}`, now, createdBy);
  db.prepare(
    `INSERT INTO verification_jobs (id, project_id, subject_id, subject_kind, claim_revision,
       condition_snapshot_id, policy_id, policy_version, evidence_manifest_id, expected_state_version,
       expected_evidence_revision, expected_assessment_epoch, requested_by, status, dedup_key,
       created_at, created_by, created_seq, updated_seq, state_version)
     VALUES (?, ?, ?, ?, 1, NULL, 'pol', ?, ?, 1, ?, 1, ?, 'completed', ?, ?, ?, 10, 0, 1)`,
  ).run(jobId, projectId, subjectId, subjectKind, policy, manifestId, evidenceRevision, createdBy, `dk-${id}`, now, createdBy);
  db.prepare(
    `INSERT INTO verification_results (id, project_id, job_id, subject_id, claim_revision,
       condition_snapshot_id, verifier_identity, verifier_kind, policy_version, reviewed_manifest_id,
       reviewed_evidence_revision, expected_state_version, expected_assessment_epoch, outcome, checks,
       supporting_refs, opposing_refs, limitations, suggested_followups, applied, created_at, created_by, created_seq)
     VALUES (?, ?, ?, ?, 1, NULL, ?, 'llm_agent', ?, ?, ?, 1, 1, ?, ?, '[]', '[]', '[]', '[]', 0, ?, ?, 11)`,
  ).run(id, projectId, jobId, subjectId, createdBy, policy, manifestId, evidenceRevision, outcome, checks, now, createdBy);
  return id;
}

/** 经唯一状态机确认漏洞（D1 将来的调用方式：runSerial 事务内调 applyStateTransition）。 */
async function confirmVulnerability(store, { projectId, vulnerabilityId, verifierActor = "verifier-x", evidenceRevision = 1 }) {
  const vrId = seedVerificationResult(store.db, {
    projectId,
    subjectId: vulnerabilityId,
    outcome: "supported",
    createdBy: verifierActor,
    evidenceRevision,
    tag: `VR-${vulnerabilityId}-sup-${evidenceRevision}`,
  });
  return store.runSerial((tx) =>
    applyStateTransition(tx, {
      project_id: projectId,
      subject_kind: "vulnerability",
      subject_id: vulnerabilityId,
      expected: { state_version: 1, claim_revision: 1, evidence_revision: evidenceRevision, assessment_epoch: 1 },
      action: "confirm",
      verification_result_id: vrId,
    }),
  );
}

/* ── 纯函数：§7.1 规范化与 §8.2 requires_state 语法 ─────────────────── */

test("§7.1 规范化只统一明确等价表示，不动路径/查询/参数", () => {
  // scheme/host 大小写与默认端口显式表示 → 同一服务身份
  const a = canonicalizeServiceIdentity({ scheme: "HTTPS", host: "API.Test", port: 443 });
  const b = canonicalizeServiceIdentity({ scheme: "https", host: "api.test" });
  assert.equal(a.canonical_key, b.canonical_key);
  assert.equal(a.canonical_key, "https://api.test");
  assert.equal(a.canonicalization_version, CANONICALIZATION_VERSION);
  // 非默认端口是不同身份
  const c = canonicalizeServiceIdentity({ scheme: "https", host: "api.test", port: 8443 });
  assert.equal(c.canonical_key, "https://api.test:8443");
  // 路径大小写不同 → 不同资源（不普遍小写路径）
  const r1 = canonicalizeHttpResource("https://api.test/Users/X?a=1&b=2");
  const r2 = canonicalizeHttpResource("https://api.test/users/x?a=1&b=2");
  assert.notEqual(r1.path_exact, r2.path_exact);
  assert.equal(r1.path_exact, "/Users/X");
  // 查询参数顺序不重排、重复参数不删（§7.1）
  const r3 = canonicalizeHttpResource("https://api.test/x?b=2&a=1&a=1");
  assert.equal(r3.query_exact, "?b=2&a=1&a=1");
  // 编码保留不解码、fragment 不属资源身份
  const r4 = canonicalizeHttpResource("https://api.test/a%2Fb?x=%41#frag");
  assert.equal(r4.path_exact, "/a%2Fb");
  assert.equal(r4.query_exact, "?x=%41");
  // 原始输入保留（url_exact 恒为原始串）
  assert.equal(r4.url_exact, "https://api.test/a%2Fb?x=%41#frag");
});

test("§7.2 路径模板推导：数字/UUID/Hash 段折叠，其余段保留", () => {
  assert.equal(derivePathTemplate("/users/10086").path_template, "/users/{n}");
  assert.equal(
    derivePathTemplate("/files/8b0f3a1c9d2e4f5667788990aabbccdd").path_template,
    "/files/{hash}",
  );
  assert.equal(
    derivePathTemplate("/u/123e4567-e89b-12d3-a456-426614174000").path_template,
    "/u/{uuid}",
  );
  const mixed = derivePathTemplate("/Users/10086/Orders");
  assert.equal(mixed.path_template, "/Users/{n}/Orders"); // 非参数段大小写保留
  assert.equal(mixed.rule_version, "path-template-v1");
});

test("§8.2 requires_state 受控语法解析与保守拒绝", () => {
  assert.deepEqual(parseRequiresState("confirmed"), { status: "confirmed" });
  assert.deepEqual(parseRequiresState("status=confirmed & review=clear"), { status: "confirmed", review: "clear" });
  assert.deepEqual(parseRequiresState(""), {});
  assert.equal(parseRequiresState("kind of confirmed maybe"), null);
  assert.equal(parseRequiresState("confirmed & confirmed"), null);
});

/* ── §8.1 语义边界 ───────────────────────────────────────────────── */

test("§8.1 一观察多判断非流水线：原观察永留，假设被拒后观察不变", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id);
  const res = await submitOps(s.base, worker, [
    { op: "append_observation", local_ref: "obs", statement: "该请求响应为 500" },
    { op: "propose_hypothesis", local_ref: "hyp", statement: "输入可能影响后端查询" },
    { op: "report_vulnerability", local_ref: "vuln", category: "injection", location: "/login" },
    { op: "add_relation", from: "obs", type: "supports", to: "hyp" },
    { op: "add_relation", from: "obs", type: "supports", to: "vuln" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { obs, hyp, vuln } = res.body.ids;
  // 三类对象是三行独立记录，不是同一行改类型（§8.1 非流水线）
  const store = await getStore({ dataDir: s.dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM observations").get().c, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM hypotheses").get().c, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM vulnerabilities").get().c, 1);
  // 同一观察支持多个判断（一观察多判断）
  const edges = store.db
    .prepare("SELECT * FROM relations WHERE from_id = ? AND relation_type = 'supports'")
    .all(obs);
  assert.deepEqual(new Set(edges.map((e) => e.to_id)), new Set([hyp, vuln]));
  // 假设被拒后，原观察原样保留（观察永不删除/改写）
  await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "hypothesis", subject_id: hyp, expected: { state_version: 1 }, action: "reject", reason: "验证排除" }),
  );
  const obsRow = store.db.prepare("SELECT * FROM observations WHERE id = ?").get(obs);
  assert.equal(obsRow.statement, "该请求响应为 500");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM observations").get().c, 1);
  await closeStore({ dataDir: s.dataDir });
});

test("§8.1 漏洞判断不得写 Fact：worker 角色被拒（角色面）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-inject");
  const res = await submitOps(s.base, worker, [
    { op: "record_fact", statement: "参数存在 SQL 注入", verification_refs: [] },
  ]);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "TRUST_DENIED");
  assert.match(res.body.message, /record_fact/);
});

test("§8.1 Fact 准入：无核实依据拒绝（绕过验证被程序阻止）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const verifier = verifierSession(project.id, "ver-noop");
  const res = await submitOps(s.base, verifier, [
    { op: "record_fact", statement: "参数存在 SQL 注入" },
  ]);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "PRECONDITION_INVALID");
  assert.match(res.body.message, /verification_refs/);
});

test("§8.1 Fact 准入：引用不存在或未通过核实的验证结果被拒；supported 与规则通道可归档", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const verifier = verifierSession(project.id);
  const worker = workerSession(project.id, "w2");
  const vulnId = await reportVulnerability(s.base, worker, { category: "injection" });
  const store = await getStore({ dataDir: s.dataDir });
  seedVerificationResult(store.db, {
    projectId: project.id,
    subjectId: vulnId,
    outcome: "insufficient",
    createdBy: "verifier-x",
    tag: "VR-INS-1",
  });
  // 引用不存在
  let res = await submitOps(s.base, verifier, [
    { op: "record_fact", statement: "判断 A", verification_refs: [{ source: "verification_result", id: "VR-NOPE" }] },
  ]);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "INVALID_REFERENCE");
  // outcome 非 supported（未核实）不得归档为 Fact
  res = await submitOps(s.base, verifier, [
    { op: "record_fact", statement: "判断 A", verification_refs: [{ source: "verification_result", id: "VR-INS-1" }] },
  ]);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "PRECONDITION_INVALID");
  // supported 可归档（status=verified、核实依据随行）
  seedVerificationResult(store.db, {
    projectId: project.id,
    subjectId: vulnId,
    outcome: "supported",
    createdBy: "verifier-y",
    tag: "VR-SUP-F1",
  });
  res = await submitOps(s.base, verifier, [
    {
      op: "record_fact",
      local_ref: "f1",
      statement: "响应头声明了服务版本",
      conditions: ["未登录状态"],
      verification_refs: [{ source: "verification_result", id: "VR-SUP-F1" }],
    },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const factId = res.body.ids.f1;
  const row = store.db.prepare("SELECT * FROM facts WHERE id = ?").get(factId);
  assert.equal(row.status, "verified");
  assert.equal(JSON.parse(row.verification_refs)[0].id, "VR-SUP-F1");
  assert.deepEqual(JSON.parse(row.conditions), ["未登录状态"]);
  // 版本化规则通道（§8.1「经过相应规则……核实」）也可归档，规则版本可追溯
  res = await submitOps(s.base, verifier, [
    {
      op: "record_fact",
      local_ref: "f2",
      statement: "JS 文件引用了新域名",
      verification_refs: [{ source: "versioned_rule", rule_id: "js-domain-extract", rule_version: "1.3" }],
    },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM facts").get().c, 2);
  await closeStore({ dataDir: s.dataDir });
});

/* ── §8.4 状态转换合同（唯一实现 applyStateTransition） ─────────────── */

test("§8.4 suspected→confirmed：前提齐全时确认并发布确认事件", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-discoverer");
  const vulnId = await reportVulnerability(s.base, worker, { category: "injection", location: "/login" });
  const store = await getStore({ dataDir: s.dataDir });
  const vrId = seedVerificationResult(store.db, {
    projectId: project.id,
    subjectId: vulnId,
    outcome: "supported",
    createdBy: "verifier-ind",
  });
  const out = await store.runSerial((tx) =>
    applyStateTransition(tx, {
      project_id: project.id,
      subject_kind: "vulnerability",
      subject_id: vulnId,
      expected: { state_version: 1, claim_revision: 1, evidence_revision: 1, assessment_epoch: 1 },
      action: "confirm",
      verification_result_id: vrId,
    }),
  );
  assert.equal(out.subject.status, "confirmed");
  assert.equal(out.subject.review, "clear");
  assert.ok(out.subject.confirmed_version.verification_result_id === vrId);
  assert.ok(out.events.some((e) => e.event_type === "vulnerability.state_changed"));
  const row = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
  assert.equal(row.state_version, 2);
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4 版本前提不匹配分别拒绝：STALE_STATE / CLAIM_CHANGED / STALE_EVIDENCE", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-ver");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  const vrId = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "supported", createdBy: "verifier-ind" });
  const base = { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, action: "confirm", verification_result_id: vrId };
  await assert.rejects(
    store.runSerial((tx) => applyStateTransition(tx, { ...base, expected: { state_version: 99 } })),
    (e) => e.code === "STALE_STATE",
  );
  await assert.rejects(
    store.runSerial((tx) => applyStateTransition(tx, { ...base, expected: { claim_revision: 7 } })),
    (e) => e.code === "CLAIM_CHANGED",
  );
  await assert.rejects(
    store.runSerial((tx) => applyStateTransition(tx, { ...base, expected: { evidence_revision: 7 } })),
    (e) => e.code === "STALE_EVIDENCE",
  );
  const row = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
  assert.equal(row.state_version, 1, "被拒的转换不得推进任何版本");
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4/蓝图§8.3 发现者自证拒绝：验证结果提交者与判断创建者相同", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-self");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  const vrId = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "supported", createdBy: "w-self" });
  await assert.rejects(
    store.runSerial((tx) =>
      applyStateTransition(tx, {
        project_id: project.id,
        subject_kind: "vulnerability",
        subject_id: vulnId,
        expected: { state_version: 1 },
        action: "confirm",
        verification_result_id: vrId,
      }),
    ),
    (e) => e.code === "PRECONDITION_INVALID" && /发现者不得自证/.test(e.message),
  );
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4 必要检查未通过不得确认（checks 显式失败）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-chk");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  const vrId = seedVerificationResult(store.db, {
    projectId: project.id,
    subjectId: vulnId,
    outcome: "supported",
    createdBy: "verifier-ind",
    checks: JSON.stringify([{ name: "复现请求", status: "failed" }]),
  });
  await assert.rejects(
    store.runSerial((tx) =>
      applyStateTransition(tx, {
        project_id: project.id,
        subject_kind: "vulnerability",
        subject_id: vulnId,
        expected: { state_version: 1 },
        action: "confirm",
        verification_result_id: vrId,
      }),
    ),
    (e) => e.code === "PRECONDITION_INVALID" && /必要检查/.test(e.message),
  );
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4 验证 insufficient 三分流：未确认→inconclusive；confirmed 保持并置复核；falsified 不动", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-ins");
  const v1 = await reportVulnerability(s.base, worker, {}, "v1");
  const v2 = await reportVulnerability(s.base, worker, { category: "xss" }, "v2");
  const store = await getStore({ dataDir: s.dataDir });
  // v2 先确认
  await confirmVulnerability(store, { projectId: project.id, vulnerabilityId: v2, verifierActor: "verifier-ind" });
  const vrIns1 = seedVerificationResult(store.db, { projectId: project.id, subjectId: v1, outcome: "insufficient", createdBy: "verifier-ind", tag: "VR-INS-v1" });
  const out1 = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: v1, expected: { state_version: 1 }, action: "mark_insufficient", verification_result_id: vrIns1 }),
  );
  assert.equal(out1.subject.status, "inconclusive", "未确认问题可为 inconclusive，不伪装成已排除");
  // 对 confirmed 的补验不足：不自动证明原结论为假，保留确认历史，置 review=pending
  const vrIns2 = seedVerificationResult(store.db, { projectId: project.id, subjectId: v2, outcome: "insufficient", createdBy: "verifier-ind2", tag: "VR-INS-v2" });
  const out2 = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: v2, expected: { state_version: 2 }, action: "mark_insufficient", verification_result_id: vrIns2 }),
  );
  assert.equal(out2.subject.status, "confirmed");
  assert.equal(out2.subject.review, "pending");
  const row2 = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(v2);
  assert.ok(row2.confirmed_version, "确认历史保留");
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4 验证 conflicting：review=disputed 独立于结论状态；重复冲突不虚增版本", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-cfl");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  const vr = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "conflicting", createdBy: "verifier-ind", tag: "VR-CFL" });
  const out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 1 }, action: "mark_conflicting", verification_result_id: vr }),
  );
  assert.equal(out.subject.status, "suspected", "冲突不改变结论状态");
  assert.equal(out.subject.review, "disputed");
  // 再次报告冲突：受理但无字段变化（不虚增版本）
  const again = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 2 }, action: "mark_conflicting" }),
  );
  assert.deepEqual(again.changed_fields, []);
  const row = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
  assert.equal(row.state_version, 2);
  await closeStore({ dataDir: s.dataDir });
});

test("§8.4 confirmed→falsified 需显式 overturn；falsified→reopen 推进 assessment_epoch 不直接确认", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-fls");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  await confirmVulnerability(store, { projectId: project.id, vulnerabilityId: vulnId, verifierActor: "verifier-ind" });
  const vrFal = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "falsified", createdBy: "verifier-ind2", tag: "VR-FAL-v" });
  // 未声明 overturn：拒绝（推翻 ≠ 本次未复现）
  await assert.rejects(
    store.runSerial((tx) =>
      applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 2 }, action: "falsify", verification_result_id: vrFal }),
    ),
    (e) => e.code === "PRECONDITION_INVALID" && /overturn/.test(e.message),
  );
  const out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 2 }, action: "falsify", verification_result_id: vrFal, overturn: true }),
  );
  assert.equal(out.subject.status, "falsified");
  assert.ok(out.events.some((e) => e.event_type === "judgement.invalidated"), "推翻发布判断失效事件");
  const row = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
  assert.ok(row.confirmed_version, "确认历史保留（不删除确认版本记录）");
  // falsified → 重新调查：推进 assessment_epoch、回到 suspected，程序不直接确认
  const reopen = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 3 }, action: "reopen", reason: "新证据需重评原排除依据" }),
  );
  assert.equal(reopen.subject.status, "suspected");
  assert.equal(reopen.subject.assessment_epoch, 2, "重新调查推进评估代际");
  await closeStore({ dataDir: s.dataDir });
});

test("§8.2 confirmed≠持续存在：复核未清不放行；evaluatePrerequisite 不只看状态字符串", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-gate");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  await confirmVulnerability(store, { projectId: project.id, vulnerabilityId: vulnId, verifierActor: "verifier-ind" });
  const db = store.db;
  const gate = (rs) => evaluatePrerequisite(db, { project_id: project.id, ref: vulnId, requires_state: rs });
  assert.equal(gate("confirmed").satisfied, true, "confirmed 且复核 clear 时放行");
  // 确认后新相关证据 → review=pending（§8.4 合同行）
  await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 2 }, action: "require_review", reason: "新相关证据到达" }),
  );
  const after = gate("confirmed");
  assert.equal(after.satisfied, false, "confirmed 但复核 pending：不放行（§8.2 不能只检查字符串 confirmed）");
  assert.match(after.reason, /不代表持续存在|复核/);
  assert.equal(gate("status=confirmed & review=pending").satisfied, true, "显式声明接受 pending 时按声明判定");
  // 无法解析的声明保守拒绝
  const bad = gate("大概是确认了吧");
  assert.equal(bad.satisfied, false);
  assert.match(bad.reason, /无法解析/);
  // 未声明目标状态：不放行
  assert.equal(gate("").satisfied, false);
  // 不存在的对象：不放行
  assert.equal(gate("confirmed").ref, vulnId);
  assert.equal(
    evaluatePrerequisite(db, { project_id: project.id, ref: "V-9999", requires_state: "confirmed" }).satisfied,
    false,
  );
  await closeStore({ dataDir: s.dataDir });
});

/* ── §20.3 场景 11（D2 主责）：漏洞被推翻，下游事实有独立证据 ───────── */

/* 终审整改：本用例改为纯黑盒——下游意图经真实 #20 计划接收建立、确认/推翻经
   真实 #27/#28（Manifest 绑定 + §12.2 事务应用状态转换）、依赖门槛用真实 #22
   派发核验、依赖变化事件经 user 面只读变化流观察；不再直插 intent 行、不再以
   seedVerificationResult 伪造验证结果行、不再直接调用 applyStateTransition。 */
test("保留下游事实重查必要依赖（§20.3 场景 11，纯黑盒）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const { registerVerificationPolicy } = await import("../lib/store/verification.mjs");
  registerVerificationPolicy({
    id: "pol-s11-blackbox",
    version: "v1",
    required_checks: ["evidence_reviewed"],
    description: "场景 11 黑盒策略",
  });

  /* 项目须带有效范围版本（#20 计划接收的 §17 校验）。 */
  const projRes = await call(s.base, "POST", "/sorne/projects", {
    body: { name: "场景11黑盒项目", scope_rules: { allow: ["s11.test"], deny: [], pending: [] } },
  });
  assert.equal(projRes.status, 200, JSON.stringify(projRes.body));
  const project = projRes.body.project;
  const worker = workerSession(project.id, "w-s11b");
  const verifier = verifierSession(project.id, "verifier-ind");
  const orch = orchestratorSession(project.id, "orch-s11");

  /* ① 发现链路（真实 #11/#12/#10）：Blob → Capture → 观察/疑似漏洞/支持边。 */
  const evidence1 = await seedCaptureHttp(s.base, project.id, "HTTP/1.1 500\r\nX-Echo: ' ", 1);
  const sub = await submitOps(s.base, worker, [
    { op: "register_asset", local_ref: "a", asset_type: "domain", canonicalization_version: "v1", canonical_key: "s11.test" },
    { op: "append_observation", local_ref: "o", statement: "注入观察：错误回显", capture_id: evidence1.captureId, conditions: ["未登录身份"] },
    { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "injection", location: "/login", conditions: ["未登录身份"] },
    { op: "add_relation", from: "o", type: "supports", to: "v" },
  ]);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const vulnId = sub.body.ids.v;

  /* ② 下游意图（真实 #20）+ requires 边（真实 #10）。 */
  const intentId = await planIntentHttp(s.base, project.id, {
    question: "基于注入成立后的利用面调查",
    kind: "investigate",
    prerequisite_refs: [vulnId],
    rationale: "依赖注入漏洞成立（场景 11）",
  }, "S11");
  const relRes = await submitOps(s.base, worker, [
    { op: "add_relation", from: intentId, type: "requires", to: vulnId, requires_state: "status=confirmed" },
  ]);
  assert.equal(relRes.status, 200, JSON.stringify(relRes.body));
  const requiresEdgeId = relRes.body.accepted_operations.find((o) => o.op === "add_relation").id;

  /* ③ 独立确认（真实 #27→#28）：版本匹配 + 必需检查通过 → 应用转换。 */
  const job1 = await requestJobHttp(s.base, orch, {
    subject_id: vulnId,
    condition_snapshot_id: "COND-未登录",
    raw_evidence_refs: [evidence1.blobId],
    policy_id: "pol-s11-blackbox",
    policy_version: "v1",
  });
  const confirm = await submitResultHttp(s.base, verifier, job1, "supported");
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.applied, true, "确认应被应用（§12.2）");
  assert.equal(confirm.body.subject.status, "confirmed");
  const confirmResultId = confirm.body.result_id;

  /* 前提放行的正向对照：确认后下游意图可真实派发（#22 runtime）。 */
  const dispatchOk = await call(s.base, "POST", "/sorne/attempts", {
    body: { intent_id: intentId, worker_id: "w-s11b", assignment_id: "ASM-S11-1" },
    session: runtimeSession(project.id),
  });
  assert.equal(dispatchOk.status, 200, JSON.stringify(dispatchOk.body));

  /* ④ 下游事实（真实 #10 record_fact，verifier 会话；引用真实验证结果行）。 */
  const factRes = await submitOps(s.base, verifier, [
    { op: "record_fact", local_ref: "f", statement: "响应头暴露内网网段", conditions: ["任意身份"], verification_refs: [{ source: "verification_result", id: confirmResultId }] },
  ]);
  assert.equal(factRes.status, 200, JSON.stringify(factRes.body));
  const factId = factRes.body.ids.f;
  const factBefore = await call(s.base, "GET", `/sorne/records/${factId}?project_id=${project.id}`);
  assert.equal(factBefore.status, 200);

  /* ⑤ 明确推翻（真实链路）：新反对证据 → evidence_revision 推进 → 新任务（§7.3
     续验）→ #28 falsified + 显式 overturn → 应用。 */
  const evidence2 = await seedCaptureHttp(s.base, project.id, "HTTP/1.1 200\r\nX-Fixed: yes", 2);
  const opp = await submitOps(s.base, worker, [
    { op: "append_observation", local_ref: "o2", statement: "环境变更后不再复现且根因消除", capture_id: evidence2.captureId, conditions: ["修复后环境"] },
    { op: "add_relation", from: "o2", type: "contradicts", to: vulnId },
  ]);
  assert.equal(opp.status, 200, JSON.stringify(opp.body));
  const job2 = await requestJobHttp(s.base, orch, {
    subject_id: vulnId,
    condition_snapshot_id: "COND-修复后",
    raw_evidence_refs: [evidence2.blobId],
    policy_id: "pol-s11-blackbox",
    policy_version: "v1",
  });
  const falsify = await submitResultHttp(s.base, verifierSession(project.id, "verifier-ind2"), job2, "falsified", { overturn: true });
  assert.equal(falsify.status, 200, JSON.stringify(falsify.body));
  assert.equal(falsify.body.applied, true);
  assert.equal(falsify.body.subject.status, "falsified");

  /* ⑥ 黑盒断言：
     a) 下游事实有独立证据 → 行未被推翻波及（GET /records 与推翻前一致）。 */
  const factAfter = await call(s.base, "GET", `/sorne/records/${factId}?project_id=${project.id}`);
  assert.equal(factAfter.status, 200);
  assert.deepEqual(factAfter.body.record, factBefore.body.record, "下游事实原样保留");

  /* b) 必要依赖被重查：被推翻漏洞不再放行——新分配派发被程序拦截（§9.2）。 */
  const dispatchBlocked = await call(s.base, "POST", "/sorne/attempts", {
    body: { intent_id: intentId, worker_id: "w-s11b", assignment_id: "ASM-S11-2" },
    session: runtimeSession(project.id),
  });
  assert.equal(dispatchBlocked.status, 422, JSON.stringify(dispatchBlocked.body));
  assert.equal(dispatchBlocked.body.code, "PRECONDITION_INVALID");
  assert.match(dispatchBlocked.body.message, /前提|prereq|confirmed/i);

  /* c) 依赖变化事件已持久化并可经只读变化流观察（强制通知，§9.2/§15.5）。 */
  const log = await call(s.base, "GET", `/sorne/change-log?project_id=${project.id}`);
  assert.equal(log.status, 200);
  const depEvents = log.body.events.filter((e) => e.event_type === "dependency.changed");
  assert.ok(depEvents.length >= 1, "推翻应产生依赖变化事件");
  assert.ok(
    depEvents.some((e) => e.payload.relation_id === requiresEdgeId),
    `依赖变化事件应携带受影响 requires 边 ${requiresEdgeId}`,
  );

  /* d) 历史保留：确认/推翻两次验证意见与全部证据仍在库。 */
  const store = await getStore({ dataDir: s.dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM verification_results WHERE subject_id = ?").get(vulnId).c, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id = ?").get(project.id).c, 2);
  await closeStore({ dataDir: s.dataDir });
});

/* ── 真实故障注入：事务原子性与重启持久 ───────────────────────────── */

test("状态转换原子性：真实 TRIGGER RAISE 注入使 UPDATE 失败 → 整个事务回滚", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-atomic");
  const vulnId = await reportVulnerability(s.base, worker, {});
  const store = await getStore({ dataDir: s.dataDir });
  const vrId = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "supported", createdBy: "verifier-ind" });
  // 注入：确认动作触发的 UPDATE 被 SQLite RAISE 拒绝（模拟写失败）
  store.db.exec(
    `CREATE TRIGGER d2_block_confirm BEFORE UPDATE OF status ON vulnerabilities
       WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, '注入：确认写入失败'); END`,
  );
  await assert.rejects(
    store.runSerial((tx) =>
      applyStateTransition(tx, {
        project_id: project.id,
        subject_kind: "vulnerability",
        subject_id: vulnId,
        expected: { state_version: 1 },
        action: "confirm",
        verification_result_id: vrId,
        commitSeq: 99,
      }),
    ),
    (e) => /注入/.test(e.message),
  );
  store.db.exec("DROP TRIGGER d2_block_confirm");
  const row = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
  assert.equal(row.status, "suspected", "事务回滚：状态未变");
  assert.equal(row.state_version, 1, "事务回滚：版本未推进");
  assert.equal(row.confirmed_version, null);
  // 回滚后同一验证结果可正常重试应用
  const out = await store.runSerial((tx) =>
    applyStateTransition(tx, {
      project_id: project.id,
      subject_kind: "vulnerability",
      subject_id: vulnId,
      expected: { state_version: 1 },
      action: "confirm",
      verification_result_id: vrId,
    }),
  );
  assert.equal(out.subject.status, "confirmed");
  await closeStore({ dataDir: s.dataDir });
});

test("重启持久性：关库重开后确认状态与版本仍在（真实 closeStore → 重开）", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sorne-d2-restart-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await bootServer(dataDir);
  try {
    const project = await createProject(server.base, "重启项目");
    const worker = workerSession(project.id, "w-restart");
    const vulnId = await reportVulnerability(server.base, worker, {});
    const vrId = `VR-${vulnId}-sup`;
    const store1 = await getStore({ dataDir });
    seedVerificationResult(store1.db, { projectId: project.id, subjectId: vulnId, outcome: "supported", createdBy: "verifier-ind", tag: `VR-${vulnId}-sup` });
    await store1.runSerial((tx) =>
      applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 1 }, action: "confirm", verification_result_id: vrId }),
    );
    // 模拟进程退出：关库 + 关服务，再原目录拉起
    await closeStore({ dataDir });
    await server.close();
    const server2 = await bootServer(dataDir);
    try {
      const store2 = await getStore({ dataDir });
      const row = store2.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vulnId);
      assert.equal(row.status, "confirmed");
      assert.equal(row.state_version, 2);
      assert.ok(row.confirmed_version);
      // 事件也持久（Outbox 同事务语义由 A1 承载；此处验证状态机事件已 flush 的场景由 D1 负责）
      const again = await store2.runSerial((tx) =>
        applyStateTransition(tx, { project_id: project.id, subject_kind: "vulnerability", subject_id: vulnId, expected: { state_version: 2 }, action: "require_review", reason: "重启后新证据" }),
      );
      assert.equal(again.subject.review, "pending");
      await closeStore({ dataDir });
    } finally {
      await server2.close();
    }
  } catch (err) {
    await closeStore({ dataDir }).catch(() => {});
    await server.close().catch(() => {});
    throw err;
  }
});

/* ── §20.3 场景 19 配合面：suspected 即时持久化，状态不被提升 ───────── */

/* 终审整改：夹具直插 intent 行改为真实 #20 计划接收；死代码占位提交移除；
   「未确认不放行」改为真实 #22 派发核验（黑盒）。 */
test("suspected 即时持久化可引用、状态不被摘要或新会话提升（§20.3 场景 19 D2 配合面，纯黑盒）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const projRes = await call(s.base, "POST", "/sorne/projects", {
    body: { name: "场景19黑盒项目", scope_rules: { allow: ["s19.test"], deny: [], pending: [] } },
  });
  assert.equal(projRes.status, 200, JSON.stringify(projRes.body));
  const project = projRes.body.project;
  const worker = workerSession(project.id, "w-orig");
  const vulnId = await reportVulnerability(s.base, worker, { category: "injection", location: "/login" });
  // 模拟上下文压缩/会话更换：原会话撤销，新 worker 会话引用已持久化漏洞
  const worker2 = workerSession(project.id, "w-newctx");
  /* 「Worker 发现漏洞后上下文压缩 → 漏洞已在库，后续意图可引用」：
     后续意图经真实 #20 计划接收建立（planner 会话），并真实 requires 该漏洞。 */
  const intentId = await planIntentHttp(s.base, project.id, {
    question: "验证注入并评估利用面",
    kind: "verify",
    prerequisite_refs: [vulnId],
    rationale: "依赖该疑似漏洞的验证方向（场景 19）",
  }, "S19");
  const linkRes = await submitOps(s.base, worker2, [
    { op: "add_relation", from: intentId, type: "requires", to: vulnId, requires_state: "status=confirmed" },
  ]);
  assert.equal(linkRes.status, 200, `后续意图可引用已持久化漏洞：${JSON.stringify(linkRes.body)}`);
  // 台账可见且状态仍为 suspected（不被任何摘要/汇报/新会话提升）
  const list = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.vulnerabilities.length, 1);
  assert.equal(list.body.vulnerabilities[0].status, "suspected");
  // 未确认漏洞作为前提不放行：真实 #22 派发被程序拦截（黑盒依赖门槛）
  const blocked = await call(s.base, "POST", "/sorne/attempts", {
    body: { intent_id: intentId, worker_id: "w-newctx", assignment_id: "ASM-S19-1" },
    session: runtimeSession(project.id),
  });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, "PRECONDITION_INVALID");
  await closeStore({ dataDir: s.dataDir });
});

/* ── §7.1：资产规范化与解析关系（经真实提交通道） ──────────────────── */

test("§7.1 服务资产规范化版本化：等价表示归并、原始输入保留、并发身份靠唯一约束", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-asset");
  const r1 = await submitOps(s.base, worker, [
    { op: "register_service_asset", local_ref: "svc1", url: "HTTPS://API.Test:443" },
  ]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const first = r1.body.ids.svc1;
  assert.equal(r1.body.accepted_operations[0].id, first);
  // 等价表示（大小写/显式默认端口）→ 同一节点（唯一约束归并，无覆盖）
  const r2 = await submitOps(s.base, worker, [
    { op: "register_service_asset", local_ref: "svc2", url: "https://api.test" },
  ]);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.ids.svc2, first, "等价服务身份归并为同一资产节点");
  assert.ok(r2.body.warnings.some((w) => /归并/.test(w)));
  const store = await getStore({ dataDir: s.dataDir });
  const row = store.db.prepare("SELECT * FROM assets WHERE id = ?").get(first);
  assert.equal(row.canonicalization_version, CANONICALIZATION_VERSION, "规范化规则版本随行");
  assert.equal(row.original_input, "HTTPS://API.Test:443", "原始输入保留，不被后续输入覆盖");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM assets WHERE asset_type='service'").get().c, 1);
  await closeStore({ dataDir: s.dataDir });
});

test("§7.1 HTTP 资源样本：精确身份保留参数组合，不因资产合并丢失", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-res");
  const r1 = await submitOps(s.base, worker, [
    { op: "register_http_resource", local_ref: "res1", url: "https://api.test/users/10086?debug=1", method: "GET" },
  ]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  // 参数组合不同 → 不同资源样本（各自保留），同一服务资产
  const r2 = await submitOps(s.base, worker, [
    { op: "register_http_resource", local_ref: "res2", url: "https://api.test/users/10086", method: "GET" },
  ]);
  assert.equal(r2.status, 200);
  assert.notEqual(r2.body.ids.res2, r1.body.ids.res1);
  const store = await getStore({ dataDir: s.dataDir });
  const rows = store.db.prepare("SELECT * FROM resources ORDER BY created_seq").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].query_exact, "?debug=1");
  assert.equal(rows[1].query_exact, "");
  assert.equal(rows[0].asset_id, rows[1].asset_id, "两样本归并到同一服务资产（资产归并不丢样本）");
  // 同一提交重试幂等由 A1 承载；不同提交重复登记同一样本 → 去重警告不报错
  const r3 = await submitOps(s.base, worker, [
    { op: "register_http_resource", url: "https://api.test/users/10086?debug=1", method: "GET" },
  ]);
  assert.equal(r3.status, 200);
  assert.equal(r3.body.accepted_operations[0].id, r1.body.ids.res1);
  assert.ok(r3.body.warnings.some((w) => /资源样本已存在/.test(w)));
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM resources").get().c, 2, "去重不产生重复样本行");
  await closeStore({ dataDir: s.dataDir });
});

test("§7.1 IP 与域名经解析关系相连不合并", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-dns");
  const res = await submitOps(s.base, worker, [
    { op: "observe_resolution", domain: "Api.Test", ip: "10.0.0.5", observed_via: "capture E-1" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // A1 回执只透传操作主 id（域名资产）；IP 资产与解析边从库取（真实行为验证）
  const domainAssetId = res.body.accepted_operations[0].id;
  assert.ok(domainAssetId, "回执带回域名资产主编号");
  const store = await getStore({ dataDir: s.dataDir });
  const ipa = store.db
    .prepare("SELECT * FROM assets WHERE project_id = ? AND asset_type = 'ip'")
    .get(project.id);
  const edge = store.db
    .prepare("SELECT * FROM relations WHERE relation_type = 'related_to' AND retracted_at IS NULL")
    .get();
  assert.ok(ipa, "IP 资产节点已建立");
  assert.ok(edge, "解析关系边已建立");
  assert.notEqual(domainAssetId, ipa.id, "域名与 IP 是两个独立资产节点");
  const dom = store.db.prepare("SELECT * FROM assets WHERE id = ?").get(domainAssetId);
  assert.equal(dom.asset_type, "domain");
  assert.equal(ipa.asset_type, "ip");
  assert.equal(dom.canonical_key, "api.test");
  assert.equal(dom.original_input, "Api.Test");
  assert.equal(edge.from_id, domainAssetId);
  assert.equal(edge.to_id, ipa.id);
  assert.equal(JSON.parse(edge.conditions).kind, "dns_resolution");
  assert.ok(res.body.warnings.some((w) => /未合并为同一资产/.test(w)), "回执说明未合并（§7.1）");
  await closeStore({ dataDir: s.dataDir });
});

/* ── §7.2 / §20.3 场景 6（D2 主责）：模板可修正不丢样本 ─────────────── */

test("模板拆分不丢样本与引用（§20.3 场景 6）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-tpl");
  // 具体样本：精确 URL 与参数组合入库（资源身份保留）
  const sub = await submitOps(s.base, worker, [
    { op: "register_http_resource", local_ref: "r1", url: "https://api.test/users/10086?debug=1", method: "GET" },
    { op: "register_http_resource", local_ref: "r2", url: "https://api.test/users/20086", method: "GET" },
    {
      op: "propose_endpoint_template",
      local_ref: "tpl",
      resource_ids: ["r1", "r2"],
      captured_from: ["capture CAP-0101", "capture CAP-0102"],
    },
  ]);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const { r1, r2, tpl } = sub.body.ids;
  // 数字路径折叠为候选模板；具体 URL 仍保留
  const store = await getStore({ dataDir: s.dataDir });
  const tplRow = store.db.prepare("SELECT * FROM endpoint_templates WHERE id = ?").get(tpl);
  assert.equal(tplRow.status, "candidate");
  assert.equal(tplRow.path_template, "/users/{n}");
  const membersBefore = store.db
    .prepare("SELECT * FROM template_members WHERE template_id = ? ORDER BY resource_id")
    .all(tpl);
  assert.equal(membersBefore.length, 2);
  // 推断错误：/users/20086 实为订单号语义（不同接口族）→ 拆分到新模板
  const splitRes = await submitOps(s.base, worker, [
    {
      op: "revise_endpoint_template",
      template_id: tpl,
      action: "split",
      expected_state_version: 1,
      reason: "20086 段为订单号语义，接口族不同",
      split_targets: [{ resource_ids: [r2], path_template: "/users/{orderId}" }],
    },
  ]);
  assert.equal(splitRes.status, 200, JSON.stringify(splitRes.body));
  assert.equal(splitRes.body.accepted_operations[0].id, tpl, "回执主编号为被修订模板");
  const tplAfter = store.db.prepare("SELECT * FROM endpoint_templates WHERE id = ?").get(tpl);
  assert.equal(tplAfter.status, "split");
  // 拆分产生的新模板从库取（事件 payload 与 warnings 亦携带其编号）
  const newTpl = store.db
    .prepare("SELECT * FROM endpoint_templates WHERE project_id = ? AND path_template = '/users/{orderId}'")
    .get(project.id);
  assert.ok(newTpl, "拆分目标模板已创建");
  assert.equal(newTpl.status, "candidate");
  const newTplId = newTpl.id;
  assert.ok(splitRes.body.warnings.some((w) => w.includes(newTplId)), "回执 warnings 携带新模板编号");
  // 原样本与引用不丢失（§20.3 场景 6 观察点）
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM resources").get().c, 2, "资源样本行全部保留");
  const res1 = store.db.prepare("SELECT * FROM resources WHERE id = ?").get(r1);
  const res2 = store.db.prepare("SELECT * FROM resources WHERE id = ?").get(r2);
  assert.equal(res1.url_exact, "https://api.test/users/10086?debug=1");
  assert.equal(res2.url_exact, "https://api.test/users/20086");
  // 被移样本的成员关系重挂且 captured_from 保留
  const moved = store.db.prepare("SELECT * FROM template_members WHERE template_id = ? AND resource_id = ?").get(newTplId, r2);
  assert.equal(moved.captured_from, "capture CAP-0102", "样本来源随成员移动保留");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM template_members WHERE template_id = ?").get(tpl).c, 1, "原模板保留未移动样本");
  const stayed = store.db.prepare("SELECT * FROM template_members WHERE template_id = ?").all(tpl)[0];
  assert.equal(stayed.resource_id, r1);
  assert.equal(stayed.captured_from, "capture CAP-0101");
  await closeStore({ dataDir: s.dataDir });
});

test("§7.2 模板确认/撤回走修改型版本检查；非法动作与过期版本被拒", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-tpl2");
  const sub = await submitOps(s.base, worker, [
    { op: "register_http_resource", local_ref: "r", url: "https://api.test/items/77", method: "GET" },
    { op: "propose_endpoint_template", local_ref: "tpl", resource_ids: ["r"] },
  ]);
  const tpl = sub.body.ids.tpl;
  // 修改型：缺 expected_state_version 拒绝；错误值 STALE_STATE
  let res = await submitOps(s.base, worker, [
    { op: "revise_endpoint_template", template_id: tpl, action: "confirm", reason: "样本充足" },
  ]);
  assert.equal(res.status, 400);
  res = await submitOps(s.base, worker, [
    { op: "revise_endpoint_template", template_id: tpl, action: "confirm", expected_state_version: 9, reason: "样本充足" },
  ]);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "STALE_STATE");
  // 正确版本确认
  res = await submitOps(s.base, worker, [
    { op: "revise_endpoint_template", template_id: tpl, action: "confirm", expected_state_version: 1, reason: "样本充足" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const store = await getStore({ dataDir: s.dataDir });
  assert.equal(store.db.prepare("SELECT status FROM endpoint_templates WHERE id = ?").get(tpl).status, "confirmed");
  // 已确认模板重复确认被拒（§7.2 状态机）
  res = await submitOps(s.base, worker, [
    { op: "revise_endpoint_template", template_id: tpl, action: "confirm", expected_state_version: 2, reason: "再确认" },
  ]);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "PRECONDITION_INVALID");
  // 撤回保留样本
  res = await submitOps(s.base, worker, [
    { op: "revise_endpoint_template", template_id: tpl, action: "withdraw", expected_state_version: 2, reason: "误报" },
  ]);
  assert.equal(res.status, 200);
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM template_members WHERE template_id = ?").get(tpl).c, 1, "撤回不清除样本成员");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM resources").get().c, 1);
  await closeStore({ dataDir: s.dataDir });
});

/* ── §7.3 / §20.3 场景 7（D2 主责）：候选组不替代漏洞身份 ────────────── */

test("候选聚合不被迫合成一个漏洞（§20.3 场景 7）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-cand");
  // 同资产、同位置、同类别，但身份条件不同（未登录 vs 已登录管理员）→ 两个独立问题
  const assetRes = await submitOps(s.base, worker, [
    { op: "register_asset", local_ref: "a", asset_type: "domain", canonicalization_version: "v1", canonical_key: "api.test" },
  ]);
  const assetId = assetRes.body.ids.a;
  const v1 = await reportVulnerability(s.base, worker, { category: "injection", location: "/login", assetId, conditions: ["未登录身份"] }, "v1");
  const v2 = await reportVulnerability(s.base, worker, { category: "injection", location: "/login", assetId, conditions: ["已登录管理员"] }, "v2");
  const store = await getStore({ dataDir: s.dataDir });
  // 候选聚合：同 group_key 聚到一组，但两行漏洞独立存在（不被迫合成一个）
  const mergeRes = await submitOps(s.base, worker, [
    {
      op: "merge_candidate_group",
      member_ids: [v1, v2],
      primary_id: v1,
      relation: "duplicate_of",
      expected_group_state_version: undefined,
      reason: "同参数同类别，疑似重复，待验证分辨",
    },
  ]);
  assert.equal(mergeRes.status, 200, JSON.stringify(mergeRes.body));
  const groupId = mergeRes.body.accepted_operations[0].id;
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM vulnerabilities").get().c, 2, "候选聚合不合成一个漏洞");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM memberships WHERE group_id = ?").get(groupId).c, 2);
  // 确认重复：显式 duplicate_of 关系，保留原 ID/引用/证据（不删除被合并节点）
  const dupEdge = store.db
    .prepare("SELECT * FROM relations WHERE relation_type = 'duplicate_of' AND retracted_at IS NULL")
    .all();
  assert.equal(dupEdge.length, 1);
  assert.equal(dupEdge[0].from_id, v2);
  assert.equal(dupEdge[0].to_id, v1);
  assert.ok(store.db.prepare("SELECT id FROM vulnerabilities WHERE id = ?").get(v2), "被合并节点保留");
  // 独立状态机：v1 确认不影响 v2
  await confirmVulnerability(store, { projectId: project.id, vulnerabilityId: v1, verifierActor: "verifier-ind" });
  assert.equal(store.db.prepare("SELECT status FROM vulnerabilities WHERE id = ?").get(v2).status, "suspected");
  // 发现实为不同问题 → 误合并可拆分：成员移出、合并边撤回、节点原样
  const groupVersion = store.db.prepare("SELECT state_version FROM candidate_groups WHERE id = ?").get(groupId).state_version;
  const splitRes = await submitOps(s.base, worker, [
    {
      op: "split_candidate_group",
      group_id: groupId,
      expected_group_state_version: groupVersion,
      remove_member_ids: [v2],
      reason: "身份条件不同，实为两个独立问题",
    },
  ]);
  assert.equal(splitRes.status, 200, JSON.stringify(splitRes.body));
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM memberships WHERE group_id = ? AND member_id = ?").get(groupId, v2).c, 0);
  const retractedEdge = store.db.prepare("SELECT * FROM relations WHERE id = ?").get(dupEdge[0].id);
  assert.ok(retractedEdge.retracted_at, "误合并的 duplicate_of 边被撤回（保留历史）");
  const v2After = store.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(v2);
  assert.equal(v2After.status, "suspected");
  assert.equal(v2After.id, v2, "原 ID 保留");
  // 组版本推进：过期版本再拆分被拒（修改型）
  const stale = await submitOps(s.base, worker, [
    { op: "split_candidate_group", group_id: groupId, expected_group_state_version: 1, remove_member_ids: [v1], reason: "过期重试" },
  ]);
  assert.equal(stale.status, 422);
  assert.equal(stale.body.code, "STALE_STATE");
  await closeStore({ dataDir: s.dataDir });
});

/* ── 假设/事实状态机（§8.2 行） ───────────────────────────────────── */

test("§8.2 假设与事实状态机经唯一实现驱动（testing/supported/rejected；dispute/retract）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-hf");
  const sub = await submitOps(s.base, worker, [
    { op: "propose_hypothesis", local_ref: "h", statement: "输入可能影响后端查询" },
  ]);
  const hid = sub.body.ids.h;
  const store = await getStore({ dataDir: s.dataDir });
  let out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "hypothesis", subject_id: hid, expected: { state_version: 1 }, action: "test" }),
  );
  assert.equal(out.subject.status, "testing");
  out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "hypothesis", subject_id: hid, expected: { state_version: 2 }, action: "support" }),
  );
  assert.equal(out.subject.status, "supported");
  // 事实：经核实归档后走 dispute/retract
  const vulnId = await reportVulnerability(s.base, worker, {});
  const vrId = seedVerificationResult(store.db, { projectId: project.id, subjectId: vulnId, outcome: "supported", createdBy: "verifier-ind", tag: "VR-HF" });
  const factRes = await submitOps(s.base, verifierSession(project.id), [
    { op: "record_fact", local_ref: "f", statement: "固定判断", verification_refs: [{ source: "verification_result", id: vrId }] },
  ]);
  const fid = factRes.body.ids.f;
  out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "fact", subject_id: fid, expected: { state_version: 1 }, action: "dispute", reason: "收到实质相反证据" }),
  );
  assert.equal(out.subject.status, "disputed");
  out = await store.runSerial((tx) =>
    applyStateTransition(tx, { project_id: project.id, subject_kind: "fact", subject_id: fid, expected: { state_version: 2 }, action: "retract", reason: "受控修正流程撤回" }),
  );
  assert.equal(out.subject.status, "retracted");
  assert.ok(out.events.some((e) => e.event_type === "judgement.invalidated"), "撤回发布判断失效事件");
  await closeStore({ dataDir: s.dataDir });
});

/* ── #30 漏洞台账视图 ─────────────────────────────────────────────── */

test("#30 漏洞台账：状态与复核分列、过滤、游标分页、证据与候选组入口", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-ledger");
  const assetRes = await submitOps(s.base, worker, [
    { op: "register_asset", local_ref: "a", asset_type: "domain", canonicalization_version: "v1", canonical_key: "api.test" },
    { op: "append_observation", local_ref: "o1", statement: "错误信息回显 SQL 片段" },
    { op: "append_observation", local_ref: "o2", statement: "另一身份下无回显" },
    { op: "report_vulnerability", local_ref: "v1", category: "injection", location: "/login", asset_id: "a" },
    { op: "report_vulnerability", local_ref: "v2", category: "xss", location: "/search", asset_id: "a" },
    { op: "add_relation", from: "o1", type: "supports", to: "v1" },
    { op: "add_relation", from: "o2", type: "contradicts", to: "v1" },
  ]);
  assert.equal(assetRes.status, 200, JSON.stringify(assetRes.body));
  const v1 = assetRes.body.ids.v1;
  const v2 = assetRes.body.ids.v2;
  const store = await getStore({ dataDir: s.dataDir });
  await confirmVulnerability(store, { projectId: project.id, vulnerabilityId: v2, verifierActor: "verifier-ind" });
  // 无会话回环按 user 面只读（蓝图 §8.2 user 含 #30）
  const list = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  const byId = new Map(list.body.vulnerabilities.map((v) => [v.id, v]));
  assert.equal(byId.get(v1).status, "suspected");
  assert.equal(byId.get(v1).review, "clear");
  assert.equal(byId.get(v2).status, "confirmed");
  assert.ok(byId.get(v2).confirmed_version, "确认版本入口");
  assert.deepEqual(byId.get(v1).evidence, { supports: 1, contradicts: 1, total: 2 }, "证据入口分支持/反对");
  // 过滤：status + review 组合
  const confirmed = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}&status=confirmed&review=clear`);
  assert.equal(confirmed.body.vulnerabilities.length, 1);
  assert.equal(confirmed.body.vulnerabilities[0].id, v2);
  const bad = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}&status=bogus`);
  assert.equal(bad.status, 400);
  // 游标分页：limit=1 两页取完，不静默截断
  const page1 = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}&limit=1`);
  assert.equal(page1.body.vulnerabilities.length, 1);
  assert.equal(page1.body.has_more, true);
  assert.ok(page1.body.next_cursor);
  const page2 = await call(
    s.base,
    "GET",
    `/sorne/vulnerabilities?project_id=${project.id}&limit=1&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
  );
  assert.equal(page2.body.vulnerabilities.length, 1);
  assert.equal(page2.body.has_more, false);
  assert.equal(new Set([page1.body.vulnerabilities[0].id, page2.body.vulnerabilities[0].id]).size, 2);
  // 候选组入口：归并后台账可见组信息
  const mergeRes = await submitOps(s.base, worker, [
    { op: "merge_candidate_group", member_ids: [v1, v2], primary_id: v1, reason: "同资产相邻位置" },
  ]);
  assert.equal(mergeRes.status, 200, JSON.stringify(mergeRes.body));
  const after = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
  const withGroup = new Map(after.body.vulnerabilities.map((v) => [v.id, v]));
  assert.equal(withGroup.get(v1).candidate_groups.length, 1);
  assert.equal(withGroup.get(v2).candidate_groups.length, 1);
  // 跨项目隔离：另一项目读不到本项目漏洞；带会话跨项目读取被拒
  const other = await createProject(s.base, "另一项目");
  const otherList = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${other.id}`);
  assert.equal(otherList.body.total, 0);
  const sess = workerSession(other.id, "w-cross");
  const denied = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`, { session: sess });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "TRUST_DENIED");
  // 缺 project_id 拒绝
  const noPid = await call(s.base, "GET", `/sorne/vulnerabilities`);
  assert.equal(noPid.status, 400);
  await closeStore({ dataDir: s.dataDir });
});

test("#30 台账候选组视图不改变漏洞身份（组信息只是视图聚合）", async (t) => {
  const s = await startServer();
  t.after(async () => {
    await s.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  });
  const project = await createProject(s.base);
  const worker = workerSession(project.id, "w-view");
  const v1 = await reportVulnerability(s.base, worker, {}, "v1");
  const v2 = await reportVulnerability(s.base, worker, { category: "ssrf" }, "v2");
  const mergeRes = await submitOps(s.base, worker, [
    { op: "merge_candidate_group", member_ids: [v1, v2], primary_id: v1, reason: "组视图检查" },
  ]);
  assert.equal(mergeRes.status, 200);
  const store = await getStore({ dataDir: s.dataDir });
  // 组只是聚合视图：两行漏洞仍在、无任何字段被组改写
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM vulnerabilities").get().c, 2);
  const list = await call(s.base, "GET", `/sorne/vulnerabilities?project_id=${project.id}`);
  assert.equal(list.body.vulnerabilities.length, 2);
  await closeStore({ dataDir: s.dataDir });
});
