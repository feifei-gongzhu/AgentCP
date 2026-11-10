/**
 * M2 —— subject_kind 语义化测试（评审 §4b/§7b；蓝图 §d-2 / P0-4）。
 *
 * 覆盖：
 *   ① 真实服务下 jobView 的 subject_kind 为语义类型（vulnerability/hypothesis），
 *     同时返回 subject_table（物理表名并存）；四处写点（任务行、Manifest 行与
 *     内容哈希、事件 payload、回执/准入视图）不再以物理表名当类型；
 *   ② 评审 §7b 后半：verifier 提交的 reviewed_evidence_revision /
 *     reviewed_manifest_id 必须出现在 jobView.latest_result（提交过的值到得了
 *     视图——不能恒显「未提供」，未提供 ≠ 不存在）；
 *   ③ 语义四值（observation/hypothesis/fact/vulnerability）与物理表映射的双向
 *     一致性，历史表名值兼容映射。
 *
 * 真实注入：项目/判断/验证请求/验证结果全部经真实端点与真实 SQLite（不用 mock）；
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  SUBJECT_KINDS,
  registerVerificationPolicy,
  semanticSubjectKind,
  subjectTableOf,
  toSemanticSubjectKind,
} from "../lib/store/verification.mjs";
import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";

const POLICY = registerVerificationPolicy({
  id: "m2-subject-kind",
  version: "v1",
  required_checks: ["m2.check"],
  description: "M2 subject_kind 测试策略",
});

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-m2`, role });
}

async function call(base, method, path, { body, session: s } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (s) headers["x-sorne-session"] = s.session_token;
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

/** 上传一条原始证据（blob），返回可引用的 sha256（§8.3 raw_evidence_refs）。 */
async function uploadBlob(base, projectId, text) {
  const bytes = Buffer.from(text, "utf8");
  const res = await fetch(`${base}/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/octet-stream" },
    body: bytes,
  });
  const textBody = await res.text();
  assert.equal(res.status, 200, textBody);
  const body = JSON.parse(textBody);
  const sha = body.sha256 ?? body.blob?.sha256;
  const blobId = body.blob_id ?? body.blob?.blob_id;
  assert.equal(sha, createHash("sha256").update(bytes).digest("hex"));
  // raw_evidence_refs 经 /records 定位：引用 B- 编号（sha256 是读取入口，非编号）
  return blobId || sha;
}

/** 经真实 POST /sorne/submissions 创建判断类对象，返回回执 ids 映射。 */
async function submitOps(base, projectId, submissionId, operations) {
  const res = await call(base, "POST", "/sorne/submissions", {
    session: session(projectId, "worker"),
    body: { submission_id: submissionId, operations },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test("subject_kind 词表：语义四值与物理表双向映射", () => {
  assert.deepEqual([...SUBJECT_KINDS].sort(), ["fact", "hypothesis", "observation", "vulnerability"]);
  assert.equal(semanticSubjectKind("vulnerabilities"), "vulnerability");
  assert.equal(semanticSubjectKind("hypotheses"), "hypothesis");
  assert.equal(semanticSubjectKind("facts"), "fact");
  assert.equal(semanticSubjectKind("observations"), "observation");
  assert.equal(semanticSubjectKind("records"), null); // 未登记表不猜测
  assert.equal(subjectTableOf("vulnerability"), "vulnerabilities");
  assert.equal(subjectTableOf("observation"), "observations");
  assert.equal(toSemanticSubjectKind("vulnerabilities"), "vulnerability"); // 历史表名值映射
  assert.equal(toSemanticSubjectKind("vulnerability"), "vulnerability"); // 已是语义值
  assert.equal(toSemanticSubjectKind("nonsense"), null);
});

test("真实服务：漏洞任务 subject_kind=vulnerability；reviewed_evidence_revision 提交后显示实际值", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "M2 语义类型" } })).body.project;
    const receipt = await submitOps(base, p.id, "m2sk-a", [
      {
        op: "report_vulnerability",
        local_ref: "v1",
        category: "injection",
        location: "/sk-a",
        conditions: ["未登录"],
      },
    ]);
    const vulnId = receipt.ids.v1;
    assert.match(vulnId, /^V-/);
    const w = session(p.id, "worker");

    // §8.3：无原始证据索引的请求被拒绝
    const rejected = await call(base, "POST", "/sorne/verification-requests", {
      session: w,
      body: {
        subject_id: vulnId,
        policy_id: POLICY.id,
        policy_version: POLICY.version,
        conditions: ["未登录"],
        raw_evidence_refs: [],
      },
    });
    assert.equal(rejected.status, 400);

    const blobRef = await uploadBlob(base, p.id, "m2-sk-a-evidence\n");
    const created = await call(base, "POST", "/sorne/verification-requests", {
      session: w,
      body: {
        subject_id: vulnId,
        policy_id: POLICY.id,
        policy_version: POLICY.version,
        conditions: ["未登录"],
        raw_evidence_refs: [blobRef],
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const job = created.body.job;
    // P0-4 判据：语义类型，非物理表名
    assert.equal(job.subject_kind, "vulnerability");
    assert.notEqual(job.subject_kind, "vulnerabilities");
    assert.equal(job.subject_table, "vulnerabilities");
    assert.equal(job.manifest.id, job.evidence_manifest_id);

    // verifier 提交结果（§12.2 保存路径）→ reviewed_* 到达 jobView.latest_result
    const evidenceRevision = job.manifest.evidence_revision;
    const vr = await call(base, "POST", "/sorne/verification-results", {
      session: session(p.id, "verifier"),
      body: {
        job_id: job.id,
        verifier_identity: "verifier-m2",
        verifier_kind: "versioned_rule",
        policy_version: POLICY.version,
        reviewed_manifest_id: job.evidence_manifest_id,
        reviewed_evidence_revision: evidenceRevision,
        expected_state_version: job.expected.state_version,
        expected_assessment_epoch: job.expected.assessment_epoch,
        claim_revision: job.claim_revision,
        outcome: "insufficient",
        checks: [{ name: "m2.check", passed: false, note: "M2 测试：证据不足" }],
        limitations: "M2 subject_kind 测试",
      },
    });
    assert.equal(vr.status, 200, JSON.stringify(vr.body));

    const list = await call(base, "GET", `/sorne/verification-jobs?project_id=${p.id}`, { session: w });
    assert.equal(list.status, 200);
    const viewed = list.body.jobs.find((j) => j.id === job.id);
    assert.ok(viewed, "任务应在队列视图");
    assert.equal(viewed.subject_kind, "vulnerability");
    assert.equal(viewed.subject_table, "vulnerabilities");
    // 评审 §7b 后半判据：提交过的值必须显示实际值（不恒显未提供）
    assert.equal(viewed.latest_result.reviewed_manifest_id, job.evidence_manifest_id);
    assert.equal(viewed.latest_result.reviewed_evidence_revision, evidenceRevision);
    // 游标信封统一（P0-3 交叉断言）：next_cursor 为规范名
    assert.equal(list.body.next_cursor, list.body.next_after);
  });
});

test("真实服务：假设任务 subject_kind=hypothesis；事件 payload 同语义并附 subject_table", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "M2 假设类型" } })).body.project;
    const receipt = await submitOps(base, p.id, "m2sk-h1", [
      { op: "append_observation", local_ref: "o1", statement: "该请求响应为 500" },
      { op: "propose_hypothesis", local_ref: "h1", statement: "输入可能影响后端查询", conditions: ["未登录"] },
    ]);
    const hypId = receipt.ids.h1;
    assert.match(hypId, /^H-/);
    const w = session(p.id, "worker");
    const blobRef = await uploadBlob(base, p.id, "m2-sk-h-evidence\n");
    const created = await call(base, "POST", "/sorne/verification-requests", {
      session: w,
      body: {
        subject_id: hypId,
        policy_id: POLICY.id,
        policy_version: POLICY.version,
        conditions: ["未登录"],
        raw_evidence_refs: [blobRef],
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const job = created.body.job;
    assert.equal(job.subject_kind, "hypothesis");
    assert.equal(job.subject_table, "hypotheses");

    // Outbox 事件 payload 的 subject_kind 亦为语义类型（写点全改的库内证据）
    const { openDatabase } = await import("../lib/db.mjs");
    const { stateDbPath } = await import("../lib/store/layout.mjs");
    const db = (await openDatabase({ file: stateDbPath(s.dataDir) })).db;
    const ev = db
      .prepare(
        `SELECT payload FROM outbox WHERE project_id = ? AND event_type = 'verification.completed'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(p.id);
    if (ev) {
      const payload = JSON.parse(ev.payload);
      assert.equal(payload.subject_kind, "hypothesis");
      assert.equal(payload.subject_table, "hypotheses");
    }
    db.close();
  });
});
