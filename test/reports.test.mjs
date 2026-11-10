/**
 * F1 —— 报告服务测试（规范 §19 报告与覆盖度；蓝图 §7 场景 22 的 F1 配合面）。
 *
 * 覆盖：
 *   - §19 逐条：suspected 起草稿、§19 必备字段全量、确认版本/排除/争议同步当前
 *     视图且历史版本保留、阶段报告数据截止版本与时间、五块内容、覆盖度按
 *     资产/方向/身份条件记录、生成后探索继续、任何漏洞/事实四向追溯；
 *   - 版本同步噪声防护：其他对象的提交不增殖本报告版本（§20.3 场景 10 的
 *     报告面同义保障）；重复读取幂等；
 *   - 蓝图 §7 场景 22（F1 配合面）：漏洞确认并生成报告 → 项目继续、planner
 *     可安排后续方向（真实端到端链路 A1→A2→C1→C2→D1→D2→F1）；
 *   - 真实注入（§20.3 末段）：原子性经真实 SQLite TRIGGER RAISE(ABORT)（业务
 *     无半行、旧版本完好、孤立文件可回收）；重启经真实「关库关服→同目录重启」
 *     （同步与历史版本跨重启可用）。不使用 mock 替代事务与恢复。
 *
 * 业务夹具全部经真实端点建立：项目/漏洞/观察/证据边经 #5/#10（A1），Blob 与
 * 采集经 #11/#12（A2），意图经 #20（C1），意图状态迁移经 C1 存储级 API
 * transitionIntent（调度/协调侧程序的文档化入口），执行分配/工具调用经
 * #22/#26（C2），验证经 #27/#28（D1，策略进程内注册、verifier≠发现者）。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（bootServer），finally 关服务、
 * 关库、删目录，不留后台进程、不触碰 ~/.sorne。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import * as verification from "../lib/store/verification.mjs";
import { transitionIntent } from "../lib/store/intents.mjs";
import { projectDir } from "../lib/store/layout.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 服务器与请求工具（与 D1 测试同法：mock ctx 挂真实路由） ──────── */

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
  const dataDir = makeTempDir("sorne-f1-rep-");
  const s = await bootServer(dataDir);
  try {
    return await fn({ ...s, dataDir });
  } finally {
    await s.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ── 夹具（全部经真实端点） ───────────────────────────────────────── */

let submissionCounter = 0;
async function createProject(base, name = "F1 报告服务测试", { withScope = true } = {}) {
  const res = await call(base, "POST", "/sorne/projects", {
    body: { name, ...(withScope ? { scope_rules: { allow: ["*.example.test"], deny: [], pending: [] } } : {}) },
  });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

const workerSession = (projectId, actor = "w-finder") =>
  issueSession({ project_id: projectId, actor, role: "worker" });
const verifierSession = (projectId, actor = "v-independent") =>
  issueSession({ project_id: projectId, actor, role: "verifier" });
const plannerSession = (projectId, actor = "p-1") =>
  issueSession({ project_id: projectId, actor, role: "planner" });
const runtimeSession = (projectId, actor = "rt-1") =>
  issueSession({ project_id: projectId, actor, role: "runtime" });

async function submit(base, session, operations, tag) {
  const sid = `F1-${tag}-${Date.now()}-${submissionCounter++}`;
  const res = await call(base, "POST", "/sorne/submissions", {
    body: { submission_id: sid, operations },
    session,
  });
  assert.equal(res.status, 200, `提交失败（${tag}）：${JSON.stringify(res.body)}`);
  return res.body;
}

/** 疑似漏洞 + 首条支持观察（A1 #10 真实管线）。 */
async function seedVulnerability(base, worker, { category = "sql-injection", conditions = ["未登录身份"], withSupport = true, seq = 0 } = {}) {
  const operations = [
    { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: `target-${submissionCounter}-${seq}.example.test` },
    { op: "report_vulnerability", local_ref: "v", asset_id: "a", category, conditions, location: "/api/login" },
  ];
  if (withSupport) {
    operations.push({ op: "append_observation", local_ref: "o1", statement: "登录接口对单引号返回 500", conditions });
    operations.push({ op: "add_relation", from: "o1", type: "supports", to: "v" });
  }
  const receipt = await submit(base, worker, operations, "SEED");
  return { vulnId: receipt.ids.v, obsId: receipt.ids.o1, assetId: receipt.ids.a };
}

async function addEvidenceEdge(base, worker, vulnId, stance, note) {
  return submit(base, worker, [
    { op: "append_observation", local_ref: "o", statement: note, conditions: ["未登录身份"] },
    { op: "add_relation", from: "o", type: stance, to: vulnId },
  ], "EV");
}

/** A2 #11/#12：固定 Blob + 建立采集（可挂 attempt/resource）。 */
async function seedCapture(base, projectId, content, seq, { attemptId, resourceId } = {}) {
  const up = await call(
    base,
    "POST",
    `/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body&source_kind=tool_gateway`,
    { rawBody: content, contentType: "application/octet-stream" },
  );
  assert.equal(up.status, 200, `上传 Blob 失败：${JSON.stringify(up.body)}`);
  const cap = await call(base, "POST", "/sorne/captures", {
    body: {
      project_id: projectId,
      tool_call_id: `TC-F1-${seq}-${submissionCounter++}`,
      ...(resourceId ? { resource_id: resourceId } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      request_url_exact: `https://target.example.test/api/login?seq=${seq}`,
      method: "GET",
      response_body_blob: up.body.blob_id,
      condition_snapshot_id: "COND-未登录",
      integrity_status: "verified",
    },
  });
  assert.equal(cap.status, 200, `建立采集失败：${JSON.stringify(cap.body)}`);
  return { blobId: up.body.blob_id, captureId: cap.body.capture_id };
}

const POLICY = {
  id: "f1-test/poc-repro",
  version: "2026-11",
  required_checks: ["evidence_reviewed", "conditions_reproduced"],
  description: "F1 测试用验证策略：证据审阅 + 条件复现",
};

/** 发起验证请求（#27）：raw_evidence_refs 至少一条原始证据（§8.3），先固定真实采集。 */
async function requestVerificationJob(base, session, projectId, vulnId, seq, { conditionSnapshotId = "COND-未登录" } = {}) {
  const { captureId } = await seedCapture(base, projectId, `evidence-${seq}\n`, seq);
  const res = await call(base, "POST", "/sorne/verification-requests", {
    body: {
      subject_id: vulnId,
      condition_snapshot_id: conditionSnapshotId,
      raw_evidence_refs: [captureId],
      opposing_evidence_refs: [],
      policy_id: POLICY.id,
      policy_version: POLICY.version,
    },
    session,
  });
  if (res.status !== 200) {
    throw new Error(`验证请求失败：${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function submitResult(base, verifier, job, outcome, overrides = {}) {
  const res = await call(base, "POST", "/sorne/verification-results", {
    body: {
      job_id: job.job ? job.job.id : job.id,
      claim_revision: (job.job || job).claim_revision,
      verifier_identity: "verifier-llm-f1",
      verifier_kind: "llm_agent",
      policy_version: (job.job || job).policy_version,
      reviewed_manifest_id: (job.job || job).evidence_manifest_id,
      reviewed_evidence_revision: (job.job || job).expected.evidence_revision,
      expected_state_version: (job.job || job).expected.state_version,
      expected_assessment_epoch: (job.job || job).expected.assessment_epoch,
      outcome,
      checks: [
        { name: "evidence_reviewed", passed: true, note: "" },
        { name: "conditions_reproduced", passed: true, note: "" },
      ],
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

/** 完整真实确认链路：疑似 → 验证任务（含原始证据）→ 独立 verifier supported（applied）。 */
async function confirmVulnerability(base, { project, worker, vulnId }) {
  verification.registerVerificationPolicy(POLICY);
  const jobBody = await requestVerificationJob(base, worker, project.id, vulnId, 100 + (submissionCounter++ % 50));
  const verifier = verifierSession(project.id);
  const res = await submitResult(base, verifier, jobBody, "supported");
  assert.equal(res.status, 200, `确认失败：${JSON.stringify(res.body)}`);
  assert.equal(res.body.applied, true);
  return { jobId: jobBody.job.id, resultId: res.body.result_id, verifier };
}

/* 直读断言辅助（同进程 getStore；业务写入全部经真实端点/事务） */
async function dbOf(dataDir) {
  return (await getStore({ dataDir })).db;
}

function vulnReportFile(dataDir, projectId, vulnId, version) {
  return join(projectDir(dataDir, projectId), "reports", "vulnerabilities", vulnId, `v${version}.json`);
}

async function reportRows(dataDir, projectId, kind = "vulnerability", subjectId = null) {
  const db = await dbOf(dataDir);
  return subjectId
    ? db.prepare("SELECT * FROM report_revisions WHERE project_id = ? AND report_kind = ? AND subject_id = ? ORDER BY CAST(version AS INTEGER)").all(projectId, kind, subjectId)
    : db.prepare("SELECT * FROM report_revisions WHERE project_id = ? AND report_kind = ? ORDER BY rowid").all(projectId, kind);
}

/* ── 1. suspected 起草稿 + §19 必备字段 ───────────────────────────── */

test("§19 suspected 起草稿：首次读取即建 v1，§19 必备字段全量在场并落 §5.2 reports/ 目录", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId, assetId, obsId } = await seedVulnerability(base, worker);

    const list = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.reports.length, 1);
    assert.equal(list.body.reports[0].id, vulnId);
    assert.equal(list.body.reports[0].status, "suspected");
    assert.equal(list.body.reports[0].review, "clear");
    assert.equal(list.body.reports[0].latest_version, "v1");
    assert.equal(list.body.summary.by_status.suspected, 1);

    // report_revisions 行 + §5.2 文件
    const rows = await reportRows(dataDir, project.id, "vulnerability", vulnId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, "v1");
    assert.ok(existsSync(vulnReportFile(dataDir, project.id, vulnId, 1)), "报告内容文件应落在 reports/vulnerabilities/<id>/v1.json");
    const boundary = JSON.parse(rows[0].data_boundary);
    assert.equal(typeof boundary.snapshot_commit_seq, "number");
    assert.ok(boundary.generated_at);

    // 单份报告：§19 至少包含——漏洞 ID、资产、状态与复核状态、判断条件、支持/反对
    // 证据、验证结论、限制、来源意图和后续意图
    const single = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(single.status, 200, JSON.stringify(single.body));
    const report = single.body.report;
    assert.equal(report.subject.id, vulnId);
    assert.equal(report.subject.asset.id, assetId);
    assert.equal(report.subject.status, "suspected");
    assert.equal(report.subject.review, "clear");
    assert.deepEqual(report.subject.conditions, ["未登录身份"]);
    assert.equal(report.supporting_evidence.length, 1);
    assert.equal(report.supporting_evidence[0].member_id, obsId);
    assert.equal(report.supporting_evidence[0].statement, "登录接口对单引号返回 500");
    assert.deepEqual(report.verification_conclusions, { results: [], pending_jobs: [] });
    assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 1);
    assert.deepEqual(report.source_intents, []);
    assert.deepEqual(report.follow_up_intents, []);
    // 四向追溯骨架（§21 F）
    for (const key of ["origin", "execution", "evidence", "follow_ups"]) {
      assert.ok(report.trace[key], `trace.${key} 必须在场`);
    }
    assert.equal(report.trace.evidence.counts.active_supports, 1);
    assert.ok(report.trace.origin.provenance_note, "无来源边时应显式说明不推断来源");
    // 数据截止版本与时间（§19）
    assert.equal(typeof report.data_boundary.snapshot_commit_seq, "number");
    assert.ok(report.data_boundary.generated_at);
    assert.equal(report.version_record.version, "v1");
    assert.deepEqual(report.version_record.changed_fields, ["created"]);
  }));

test("证据观察挂采集时报告证据链下钻到 Blob 身份（sha256/表示形式，§5.3/§8.3 读取入口）", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const content = "HTTP/1.1 500 Internal Error\n";
    const { blobId, captureId } = await seedCapture(base, project.id, content, 1);
    const receipt = await submit(base, worker, [
      { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: "target-ev.example.test" },
      { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "info-leak" },
      { op: "append_observation", local_ref: "o", statement: "错误页回显堆栈", capture_id: captureId },
      { op: "add_relation", from: "o", type: "supports", to: "v" },
    ], "CAP-EV");
    const vulnId = receipt.ids.v;

    const single = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(single.status, 200);
    const member = single.body.report.supporting_evidence.find((m) => m.member_id === receipt.ids.o);
    assert.ok(member, "支持证据应含观察成员");
    assert.equal(member.capture.id, captureId);
    assert.equal(member.capture.response_body_blob.id, blobId);
    assert.equal(member.capture.response_body_blob.representation, "raw_body");
    assert.equal(member.capture.response_body_blob.sha256, createHash("sha256").update(content).digest("hex"));
  }));

/* ── 2. 确认/排除/争议同步当前视图，历史保留（§19） ───────────────── */

test("确认后生成确认版本：v2 携带确认版本与验证结论，v1 历史保留可读（真实 D1/D2 链路）", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);

    const before = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(before.body.current_version, "v1");

    const { resultId } = await confirmVulnerability(base, { project, worker, vulnId });

    const after = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.current_version, "v2");
    assert.equal(after.body.report.subject.status, "confirmed");
    assert.equal(after.body.report.subject.confirmed_version.verification_result_id, resultId);
    assert.equal(after.body.report.verification_conclusions.results.length, 1);
    assert.equal(after.body.report.verification_conclusions.results[0].applied, true);
    assert.ok(after.body.report.limitations.some((s) => String(s).includes("不代表持续存在")));
    assert.ok(after.body.report.version_record.changed_fields.includes("subject"), `changed_fields 应含 subject：${after.body.report.version_record.changed_fields}`);

    // 历史版本保留且可读（§19）
    const v1 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}&version=v1`);
    assert.equal(v1.status, 200);
    assert.equal(v1.body.report.subject.status, "suspected");
    assert.equal(v1.body.requested_version, "v1");
    assert.equal(v1.body.current_version, "v2");
    assert.equal(after.body.history_total, 2);

    const rows = await reportRows(dataDir, project.id, "vulnerability", vulnId);
    assert.equal(rows.length, 2);
    assert.ok(existsSync(vulnReportFile(dataDir, project.id, vulnId, 1)));
    assert.ok(existsSync(vulnReportFile(dataDir, project.id, vulnId, 2)));
  }));

test("场景 22（F1 配合面）：漏洞确认并生成报告——项目继续，planner 可安排后续方向且报告呈现", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const draft = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(draft.body.current_version, "v1");
    await confirmVulnerability(base, { project, worker, vulnId });

    // 报告生成后探索继续：项目状态不被报告/确认改变（§1：均不得自动结束项目）
    const reportRes = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(reportRes.status, 200);
    assert.equal(reportRes.body.current_version, "v2");
    assert.equal(reportRes.body.report.subject.status, "confirmed");
    const db = await dbOf(dataDir);
    assert.equal(db.prepare("SELECT status FROM projects WHERE id = ?").get(project.id).status, "active");

    // planner 安排引用该确认漏洞的后续方向（§16.3；C1 真实端点）
    const planner = plannerSession(project.id);
    const plan = await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: `F1PLAN-${Date.now()}`,
        plan_revision: "r1",
        intents: [
          {
            op: "create",
            local_ref: "i1",
            question: `围绕已确认漏洞 ${vulnId} 排查同参数族的其他入口`,
            kind: "investigate",
            success_criteria: "给出同参数族入口的覆盖清单或明确缺口",
            basis_refs: [vulnId],
            rationale: "确认漏洞的后续方向（§16.3）",
          },
        ],
      },
      session: planner,
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const intentId = plan.body.ids?.i1;
    assert.ok(intentId, "后续意图应被创建");

    // 报告同步呈现后续意图（§19 后续意图字段 + 四向追溯）
    const after = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(after.body.current_version, "v3", "后续方向出现应切新版本");
    assert.equal(after.body.report.follow_up_intents.length, 1);
    assert.equal(after.body.report.follow_up_intents[0].intent_id, intentId);
    assert.equal(after.body.report.follow_up_intents[0].via[0], "basis_refs");
    assert.equal(after.body.report.trace.follow_ups.intents.length, 1);
    assert.ok(after.body.report.version_record.changed_fields.includes("follow_up_intents"));

    // 探索继续：阶段报告呈现进行中的探索（ongoing intents），且确认不结束项目
    const ms = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(ms.status, 200);
    assert.ok(ms.body.report.exploration_continues);
    assert.equal(ms.body.report.exploration_continues.ongoing_total >= 1, true);
    assert.equal(ms.body.report.project.status, "active");
    assert.equal(db.prepare("SELECT status FROM projects WHERE id = ?").get(project.id).status, "active");
  }));

test("排除（falsified）同步当前视图且不写成历史上不存在；v1 保留", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const draft = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(draft.body.current_version, "v1");
    verification.registerVerificationPolicy(POLICY);
    const jobBody = await requestVerificationJob(base, worker, project.id, vulnId, 201);
    const res = await submitResult(base, verifierSession(project.id), jobBody, "falsified");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, true);

    const view = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(view.body.current_version, "v2");
    assert.equal(view.body.report.subject.status, "falsified");
    assert.ok(view.body.report.limitations.some((s) => String(s).includes("不等于历史上不存在")));
    const v1 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}&version=1`);
    assert.equal(v1.body.report.subject.status, "suspected");
  }));

test("争议（conflicting）同步 review=disputed 并提示依赖检查不能只看状态字符串", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const draft = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(draft.body.current_version, "v1");
    verification.registerVerificationPolicy(POLICY);
    const jobBody = await requestVerificationJob(base, worker, project.id, vulnId, 202);
    const res = await submitResult(base, verifierSession(project.id), jobBody, "conflicting");
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const view = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(view.body.current_version, "v2");
    assert.equal(view.body.report.subject.review, "disputed");
    assert.equal(view.body.report.subject.status, "suspected");
    assert.ok(view.body.report.limitations.some((s) => String(s).includes("复核状态为 disputed")));
  }));

/* ── 3. 版本同步的噪声防护（场景 10 报告面） ──────────────────────── */

test("其他对象的提交不增殖本报告版本；重复读取幂等（§20.3 场景 10 的报告面）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const a = await seedVulnerability(base, worker, { seq: 1 });
    const b = await seedVulnerability(base, worker, { seq: 2 });

    const first = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}`);
    assert.equal(first.body.reports.find((r) => r.id === a.vulnId).versions, 1);
    assert.equal(first.body.reports.find((r) => r.id === b.vulnId).versions, 1);

    // 漏洞 B 侧新增观察与支持证据（推进 B 的 evidence_revision）——与 A 无关
    await addEvidenceEdge(base, worker, b.vulnId, "supports", "B 的补充观察");
    // 再来一条完全无关的提交（新资产）
    await submit(base, worker, [
      { op: "register_asset", local_ref: "a2", asset_type: "host", canonicalization_version: "v1", canonical_key: "unrelated.example.test" },
    ], "UNREL");

    const second = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}`);
    const aEntry = second.body.reports.find((r) => r.id === a.vulnId);
    const bEntry = second.body.reports.find((r) => r.id === b.vulnId);
    assert.equal(aEntry.versions, 1, "无关提交不得使 A 的报告失效或增殖版本");
    assert.equal(aEntry.latest_version, "v1");
    assert.equal(bEntry.versions, 2, "B 的相关证据变化应切新版本");
    const syncA = second.body.sync.find((s) => s.subject_id === a.vulnId);
    assert.equal(syncA.changed, false);

    // 重复读取幂等：不产生新版本
    const third = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}`);
    assert.equal(third.body.reports.find((r) => r.id === a.vulnId).versions, 1);
    assert.equal(third.body.reports.find((r) => r.id === b.vulnId).versions, 2);
    assert.ok(third.body.sync.every((s) => s.changed === false));
  }));

test("相关反对证据切新版本：opposing_evidence 在场且证据集版本推进", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const before = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    const evBefore = before.body.report.subject.evidence_revision;

    await addEvidenceEdge(base, worker, vulnId, "contradicts", "补丁后不再复现（仅本条件）");
    const after = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(after.body.current_version, "v2");
    assert.equal(after.body.report.opposing_evidence.length, 1);
    assert.equal(after.body.report.evidence_counts.opposing, 1);
    assert.equal(after.body.report.subject.evidence_revision, evBefore + 1);
  }));

test("漏洞报告列表游标分页：limit 截页带 next_cursor，续读覆盖全集不静默截断", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    for (let i = 0; i < 3; i += 1) {
      await seedVulnerability(base, worker, { seq: 20 + i });
    }
    const page1 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&limit=2`);
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.reports.length, 2);
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.next_cursor);
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.summary.total, 3, "汇总计数不受分页影响");
    const page2 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`);
    assert.equal(page2.status, 200, JSON.stringify(page2.body));
    assert.equal(page2.body.reports.length, 1);
    assert.equal(page2.body.has_more, false);
    assert.equal(page2.body.next_cursor, null);
    const seen = [...page1.body.reports, ...page2.body.reports].map((r) => r.id);
    assert.equal(new Set(seen).size, 3, "两页合并覆盖全集");
    const badCursor = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&cursor=bad`);
    assert.equal(badCursor.status, 400);
  }));

/* ── 4. 阶段报告（§19 五块 + 数据截止 + 覆盖度） ─────────────────── */

test("阶段报告注明数据截止版本与时间；读取不增殖版本，refresh 显式生成新版本", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    await seedVulnerability(base, worker);

    const v1 = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(v1.status, 200, JSON.stringify(v1.body));
    assert.equal(v1.body.current_version, "v1");
    const db = await dbOf(dataDir);
    const boundary1 = v1.body.report.data_boundary.snapshot_commit_seq;
    assert.equal(boundary1, db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(project.id).n - 1);
    assert.ok(v1.body.report.data_boundary.generated_at);
    // §19 五块内容
    for (const key of ["confirmed_findings", "unconfirmed_leads", "completed_directions", "blocked_directions", "uncovered"]) {
      assert.ok(v1.body.report[key], `阶段报告缺 ${key}`);
    }
    assert.ok(v1.body.report.coverage);
    assert.ok(v1.body.report.exploration_continues);

    // 读取不增殖版本
    const again = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(again.body.current_version, "v1");
    assert.equal(again.body.refreshed, false);

    // 新提交后普通读取仍不增殖；refresh 显式生成 v2 且边界推进
    await seedVulnerability(base, worker, { seq: 9 });
    const stillV1 = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(stillV1.body.current_version, "v1");
    const v2 = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}&refresh=1`);
    assert.equal(v2.body.refreshed, true);
    assert.equal(v2.body.current_version, "v2");
    assert.ok(v2.body.report.data_boundary.snapshot_commit_seq > boundary1);
    // 历史版本可读（数据截止各版本自带）
    const v1Back = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}&version=v1`);
    assert.equal(v1Back.status, 200);
    assert.equal(v1Back.body.report.data_boundary.snapshot_commit_seq, boundary1);
  }));

test("覆盖度按资产/方向/身份条件记录；未覆盖资产显式呈现；不把执行过方向当测透", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const planner = plannerSession(project.id);

    // 一条疑似漏洞（其主机资产无任何方向/采集 → 未覆盖资产样例）
    await seedVulnerability(base, worker, { withSupport: false, seq: 5 });

    // 资产 A：服务资产 + HTTP 资源样本（D2 真实操作）+ 采集 + 观察
    const receipt = await submit(base, worker, [
      { op: "register_http_resource", local_ref: "res", url: "https://cov.example.test/api/users?page=1", method: "GET" },
    ], "COV-RES");
    const resourceId = receipt.ids.res;
    const db0 = await dbOf(dataDir);
    const assetId = db0.prepare("SELECT asset_id FROM resources WHERE id = ?").get(resourceId).asset_id;
    const { captureId } = await seedCapture(base, project.id, "[]", 3, { resourceId });
    await submit(base, worker, [
      { op: "append_observation", local_ref: "o", statement: "接口返回用户列表", capture_id: captureId, conditions: ["管理员身份"] },
    ], "COV-OBS");

    // 资产 A 两个方向：collect（后 resolved）与 investigate（后 blocked）
    const plan = await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: `F1COV-${Date.now()}`,
        plan_revision: "r1",
        intents: [
          {
            op: "create", local_ref: "ic", question: "采集 A 的接口清单", kind: "collect",
            success_criteria: "清单入库", target_asset_ids: [assetId],
            condition_requirements: [{ description: "管理员身份" }],
          },
          {
            op: "create", local_ref: "ii", question: "调查 A 的越权行为", kind: "investigate",
            success_criteria: "给出结论或缺口", target_asset_ids: [assetId],
          },
        ],
      },
      session: planner,
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));

    const ms = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(ms.status, 200);
    const coverage = ms.body.report.coverage;
    assert.ok(coverage.coverage_note.includes("不代表该资产没有其他漏洞"));

    const rec = coverage.records.find((r) => r.asset.id === assetId);
    assert.ok(rec, "覆盖记录应含带资源样本的资产");
    assert.equal(rec.intents_directed, plan.body.ids ? Object.values(plan.body.ids).length : 0);
    assert.equal(rec.directions.collect.total, 1);
    assert.equal(rec.directions.investigate.total, 1);
    assert.equal(rec.captures >= 1, true);
    assert.equal(rec.observations >= 1, true);
    assert.deepEqual(rec.identity_conditions.observed_in_captures, ["管理员身份"]);
    assert.deepEqual(rec.identity_conditions.from_intents, ["管理员身份"]);
    assert.equal(rec.uncovered_flags.no_direction, false);
    assert.equal(rec.uncovered_flags.no_capture, false);

    // 状态迁移（C1 存储级 API：调度/协调侧程序的文档化入口）
    const collectId = plan.body.ids.ic;
    const investigateId = plan.body.ids.ii;
    for (const action of ["activate", "start", "resolve"]) {
      await transitionIntent({ dataDir }, { projectId: project.id, actor: "test-runtime", intentId: collectId, action, reason: "测试推进" });
    }
    await transitionIntent({ dataDir }, { projectId: project.id, actor: "test-runtime", intentId: investigateId, action: "block", reason: "缺少普通用户身份" });

    const ms2 = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}&refresh=1`);
    const cov2 = ms2.body.report.coverage.records.find((r) => r.asset.id === assetId);
    assert.equal(cov2.directions.collect.resolved, 1, "已完成方向按 resolved 计数");
    assert.equal(cov2.directions.investigate.blocked, 1, "受阻方向计数");
    // 已完成方向 + 受阻方向两块（§19）
    assert.equal(ms2.body.report.completed_directions.intents.some((i) => i.id === collectId), true);
    const blockedEntry = ms2.body.report.blocked_directions.intents.find((i) => i.id === investigateId);
    assert.ok(blockedEntry, "受阻意图应在受阻方向块");
    assert.deepEqual(blockedEntry.resume_conditions, []);

    // 未覆盖资产显式呈现（seedVulnerability 建的主机资产无任何方向/采集）
    assert.ok(ms2.body.report.uncovered.assets_without_direction >= 1);
    assert.ok(
      ms2.body.report.coverage.records.some((r) => r.uncovered_flags.no_direction),
      "无方向的资产应带 no_direction 标记",
    );
  }));

test("事实四向追溯：验证归档的 Fact 在阶段报告中可追来源/执行/证据/后续（§21 F）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId, assetId } = await seedVulnerability(base, worker);

    // 确认链路取得 supported 结果，再由 verifier 归档 Fact（D2 record_fact 真实操作）
    verification.registerVerificationPolicy(POLICY);
    const jobBody = await requestVerificationJob(base, worker, project.id, vulnId, 203);
    const confirm = await submitResult(base, verifierSession(project.id), jobBody, "supported");
    assert.equal(confirm.status, 200);
    const resultId = confirm.body.result_id;
    const verifier = verifierSession(project.id);
    const factReceipt = await submit(base, verifier, [
      { op: "record_fact", local_ref: "f", statement: "登录接口在未登录身份下对单引号返回 500", conditions: ["未登录身份"], verification_refs: [resultId] },
    ], "FACT");

    const ms = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}`);
    assert.equal(ms.status, 200);
    const fact = ms.body.report.confirmed_findings.facts.find((f) => f.id === factReceipt.ids.f);
    assert.ok(fact, "verified 事实应进入已确认成果");
    // D2 record_fact 将核实依据归一化为 {source, id, outcome} 对象
    assert.equal(fact.verification_refs.length, 1);
    assert.equal(fact.verification_refs[0].source, "verification_result");
    assert.equal(fact.verification_refs[0].id, resultId);
    for (const key of ["origin", "execution", "evidence", "follow_ups"]) {
      assert.ok(fact.trace[key], `事实 trace.${key} 必须在场（§21 F）`);
    }

    // 后续方向引用该事实 → 追溯链呈现（planner 真实端点）
    const planner = plannerSession(project.id);
    const plan = await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: `F1FACT-${Date.now()}`,
        plan_revision: "r1",
        intents: [
          { op: "create", local_ref: "i", question: "基于事实排查同类接口", kind: "investigate", success_criteria: "清单或缺口", basis_refs: [fact.id] },
        ],
      },
      session: planner,
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const ms2 = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}&refresh=1`);
    const fact2 = ms2.body.report.confirmed_findings.facts.find((f) => f.id === fact.id);
    assert.equal(fact2.trace.follow_ups.intents.length, 1);
    assert.equal(fact2.trace.follow_ups.intents[0].intent_id, plan.body.ids.i);
    void assetId;
  }));

test("执行追溯：证据采集归因的 Attempt 与工具调用汇总进入报告（真实 C2 链路）", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id, "w-exec");
    const runtime = runtimeSession(project.id);
    const planner = plannerSession(project.id);

    // 意图（C1）→ 执行分配（C2 #22）→ 工具调用（C2 #26）→ 采集挂 attempt（A2 #12）
    const plan = await call(base, "POST", "/sorne/plan-revisions", {
      body: {
        submission_id: `F1EXEC-${Date.now()}`,
        plan_revision: "r1",
        intents: [
          { op: "create", local_ref: "i", question: "登录接口行为采集", kind: "collect", success_criteria: "采集入库" },
        ],
      },
      session: planner,
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const intentId = plan.body.ids.i;
    const disp = await call(base, "POST", "/sorne/attempts", {
      body: { intent_id: intentId, worker_id: "w-exec" },
      session: runtime,
    });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    const attemptId = disp.body.attempt.id;
    const fencing = disp.body.fencing_token;

    const reg = await call(base, "POST", "/sorne/tool-calls", {
      body: { action: "register", attempt_id: attemptId, fencing_token: fencing, tool_name: "http_probe", args: { url: "https://target.example.test/api/login" } },
      session: worker,
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const toolCallId = reg.body.tool_call?.id ?? reg.body.tool_call_id;
    assert.ok(toolCallId);

    const { captureId } = await seedCapture(base, project.id, "probe-output", 7, { attemptId });
    const receipt = await submit(base, worker, [
      { op: "register_asset", local_ref: "a", asset_type: "host", canonicalization_version: "v1", canonical_key: "exec.example.test" },
      { op: "report_vulnerability", local_ref: "v", asset_id: "a", category: "info-leak" },
      { op: "append_observation", local_ref: "o", statement: "探测输出回显内部路径", capture_id: captureId },
      { op: "add_relation", from: "o", type: "supports", to: "v" },
    ], "EXEC");

    const view = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${receipt.ids.v}`);
    assert.equal(view.status, 200);
    const attempts = view.body.report.trace.execution.attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].id, attemptId);
    assert.equal(attempts[0].intent_id, intentId);
    assert.equal(attempts[0].tool_calls.total, 1);
    assert.ok(attempts[0].tool_calls.by_status.planned >= 1 || attempts[0].tool_calls.by_status.running >= 1);
  }));

/* ── 5. 边界面：隔离、鉴权、参数、空项目 ──────────────────────────── */

test("跨项目隔离：他项目列表不含本项目漏洞，跨项目 id 读取 404 不泄露", () =>
  withServer(async ({ base }) => {
    const p1 = await createProject(base, "F1 项目一");
    // 第二项目不带初始范围：规避 A1 既有跨项目 SR 编号冲突（C1 偏差 6 实证，不改其文件）
    const p2 = await createProject(base, "F1 项目二", { withScope: false });
    const worker1 = workerSession(p1.id);
    const { vulnId } = await seedVulnerability(base, worker1);

    const list2 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p2.id}`);
    assert.equal(list2.status, 200);
    assert.equal(list2.body.reports.length, 0);
    assert.equal(list2.body.summary.total, 0);

    const cross = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p2.id}&id=${vulnId}`);
    assert.equal(cross.status, 404);
    assert.equal(cross.body.code, "NOT_FOUND");

    // 项目二的阶段报告独立生成，不含项目一数据
    const ms2 = await call(base, "GET", `/sorne/reports/milestones?project_id=${p2.id}`);
    assert.equal(ms2.status, 200);
    assert.equal(ms2.body.report.coverage.total_assets, 0);
    assert.equal(ms2.body.report.confirmed_findings.vulnerabilities_total, 0);
  }));

test("鉴权面：缺 project_id 拒 400；会话跨项目拒 403；无会话回环按 user 面只读", () =>
  withServer(async ({ base }) => {
    const p1 = await createProject(base, "F1 鉴权一");
    const p2 = await createProject(base, "F1 鉴权二", { withScope: false });
    const worker1 = workerSession(p1.id);
    const { vulnId } = await seedVulnerability(base, worker1);

    const noProject = await call(base, "GET", `/sorne/reports/vulnerabilities`);
    assert.equal(noProject.status, 400);
    assert.equal(noProject.body.code, "BAD_REQUEST");

    const cross = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p2.id}`, { session: workerSession(p1.id) });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");

    const msNoProject = await call(base, "GET", `/sorne/reports/milestones`);
    assert.equal(msNoProject.status, 400);

    // 无会话回环（user 面）可读
    const anon = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p1.id}&id=${vulnId}`);
    assert.equal(anon.status, 200);
    assert.equal(anon.body.report.subject.id, vulnId);
  }));

test("参数面：漏洞不存在 404；报告版本不存在 404；version 形态非法 400", () =>
  withServer(async ({ base }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);

    const missingVuln = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=V-9999`);
    assert.equal(missingVuln.status, 404);

    const missingVersion = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}&version=v9`);
    assert.equal(missingVersion.status, 404);

    const badVersion = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}&version=abc`);
    assert.equal(badVersion.status, 400);

    const msMissing = await call(base, "GET", `/sorne/reports/milestones?project_id=${project.id}&version=v9`);
    assert.equal(msMissing.status, 404);
    const projectMissing = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=PRJ-9999`);
    assert.equal(projectMissing.status, 404);
  }));

/* ── 6. 真实注入：原子性（TRIGGER RAISE）与重启 ───────────────────── */

test("原子性注入（真实 TRIGGER RAISE）：版本行写入失败不留半行，旧版本完好，恢复后孤立文件被回收", () =>
  withServer(async ({ base, dataDir }) => {
    const project = await createProject(base);
    const worker = workerSession(project.id);
    const { vulnId } = await seedVulnerability(base, worker);
    const first = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(first.body.current_version, "v1");

    const db = await dbOf(dataDir);
    db.exec(
      `CREATE TRIGGER f1_block_report_insert BEFORE INSERT ON report_revisions
         WHEN NEW.report_kind = 'vulnerability' BEGIN SELECT RAISE(ABORT, 'f1 注入：报告版本写入失败'); END`,
    );

    // 使报告相关状态变化（新反对证据）→ 同步需要 v2 → 行写入被注入失败
    await addEvidenceEdge(base, worker, vulnId, "contradicts", "注入窗口内的反对证据");
    const failed = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(failed.status, 500, `注入应使同步失败：${JSON.stringify(failed.body)}`);
    assert.equal(failed.body.code, "INTERNAL_ERROR");

    // 无半行：v1 之后没有新行；v1 内容与文件完好（§20.1 不用错误掩盖已有内容）
    const rows = await reportRows(dataDir, project.id, "vulnerability", vulnId);
    assert.equal(rows.length, 1);
    const v1File = readFileSync(vulnReportFile(dataDir, project.id, vulnId, 1), "utf8");
    assert.equal(JSON.parse(v1File).subject.id, vulnId);
    // 业务数据不受报告失败影响（证据边仍在库）
    assert.ok(db.prepare("SELECT 1 FROM evidence_memberships WHERE project_id = ? AND subject_id = ?").get(project.id, vulnId));

    // 恢复：DROP 触发器后重试成功；失败窗口留下的孤立 v2 文件被同版本号回收
    db.exec("DROP TRIGGER f1_block_report_insert");
    const ok = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${project.id}&id=${vulnId}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.current_version, "v2");
    assert.equal(ok.body.report.opposing_evidence.length, 1);
    assert.equal((await reportRows(dataDir, project.id, "vulnerability", vulnId)).length, 2);
  }));

test("重启注入主体（真实关库关服→同目录重启）：v1 草稿→重启→确认→v2 生成、v1 历史与阶段报告跨重启可读", async () => {
  const dataDir = makeTempDir("sorne-f1-restart2-");
  const s1 = await bootServer(dataDir);
  let projectId;
  let vulnId;
  try {
    const project = await createProject(s1.base, "F1 重启演练主体");
    projectId = project.id;
    const worker = workerSession(projectId);
    vulnId = (await seedVulnerability(s1.base, worker)).vulnId;
    const v1 = await call(s1.base, "GET", `/sorne/reports/vulnerabilities?project_id=${projectId}&id=${vulnId}`);
    assert.equal(v1.body.current_version, "v1");
    await call(s1.base, "GET", `/sorne/reports/milestones?project_id=${projectId}`);
  } finally {
    await s1.close();
    await closeStore({ dataDir });
  }
  // 重启（同目录；会话为进程内注册表，重签后继续）
  const s2 = await bootServer(dataDir);
  try {
    const worker = workerSession(projectId);
    const { resultId } = await confirmVulnerability(s2.base, { project: { id: projectId }, worker, vulnId });
    const view = await call(s2.base, "GET", `/sorne/reports/vulnerabilities?project_id=${projectId}&id=${vulnId}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.current_version, "v2", "重启后同步应生成确认版本");
    assert.equal(view.body.report.subject.status, "confirmed");
    assert.equal(view.body.report.subject.confirmed_version.verification_result_id, resultId);
    const v1 = await call(s2.base, "GET", `/sorne/reports/vulnerabilities?project_id=${projectId}&id=${vulnId}&version=v1`);
    assert.equal(v1.status, 200, "重启前生成的 v1 历史版本应仍可读");
    assert.equal(v1.body.report.subject.status, "suspected");
    const ms = await call(s2.base, "GET", `/sorne/reports/milestones?project_id=${projectId}`);
    assert.equal(ms.status, 200);
    assert.equal(ms.body.current_version, "v1");
    const ms2 = await call(s2.base, "GET", `/sorne/reports/milestones?project_id=${projectId}&refresh=1`);
    assert.equal(ms2.body.current_version, "v2");
    assert.equal(ms2.body.report.confirmed_findings.vulnerabilities_total, 1);
  } finally {
    await s2.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
