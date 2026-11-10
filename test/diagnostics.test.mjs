/**
 * M2 —— 系统诊断聚合测试（蓝图 §2.6-4 / §d-6）。
 *
 * 覆盖：
 *   - 全局与单项目形体（generated_at / llm / health / projects 四态分组 /
 *     project 十块：plan/intents/attempts/verification/reports/messages/outbox/
 *     projection/evidence + 高水位）；
 *   - 计数与库内事实一致（造 2 个 pending 验证任务 → pending_jobs=2；
 *     造未处理汇报 → unhandled_worker_reports；造受阻意图 → blocked_ids）；
 *   - unknown 工具调用置顶并带纪律警示（规范 §10.2 原文）；
 *   - 未知项目 404 不泄露存在性；
 *   - projection 未投影记 null（不冒充 0）。
 *
 * 真实注入：真实端点 + 真实 SQLite；并行安全（mkdtemp + 随机端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";

const POLICY = registerVerificationPolicy({
  id: "m2-diag",
  version: "v1",
  required_checks: ["m2.check"],
  description: "M2 诊断测试策略",
});

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-diag`, role });
}

async function call(base, method, path, { body, session: s } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (s) headers["x-sorne-session"] = s.session_token;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test("全局聚合：generated_at/llm/health/projects 四态分组；llm 未配置不冒充可用", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    await call(base, "POST", "/sorne/projects", { body: { name: "诊断全局" } });
    const res = await call(base, "GET", "/sorne/diagnostics");
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const body = res.body;
    assert.ok(body.generated_at);
    assert.equal(body.llm.configured, false);
    assert.equal(body.llm.runtime, "agents:not-configured", "runtime 为 agents.describe() 原文");
    assert.match(body.llm.note, /绝不以「服务正常」暗示/);
    assert.equal(body.health.ok, true);
    assert.equal(body.health.service, "sorne");
    assert.ok(body.health.db.schema_version >= 5);
    assert.ok("outbox" in body.health && "projects" in body.health);
    assert.equal(body.projects.active, 1);
    assert.equal(body.projects.waiting_for_change, 0);
    assert.equal(body.projects.paused, 0);
    assert.equal(body.projects.stopped, 0);
    assert.ok(!("project" in body), "全局面不含单项目块");
  });
});

test("单项目聚合：计数与库内事实一致；unknown 工具调用置顶；未投影记 null", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "诊断单项目" } })).body.project;
    const w = session(p.id, "worker");

    // 造 2 个 pending 验证任务（blob + 2 个条件快照绕开去重键）
    const sub = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "diag-v",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "diag", location: "/d" }],
      },
    });
    const vulnId = sub.body.ids.v;
    const up = await fetch(`${base}/sorne/evidence/blobs?project_id=${p.id}&representation=raw_body`, {
      method: "POST", headers: { origin: base }, body: "diag",
    });
    const blobId = JSON.parse(await up.text()).blob_id;
    for (let i = 0; i < 2; i += 1) {
      const r = await call(base, "POST", "/sorne/verification-requests", {
        session: w,
        body: {
          subject_id: vulnId,
          policy_id: POLICY.id,
          policy_version: POLICY.version,
          conditions: [`diag-cond-${i}`],
          raw_evidence_refs: [blobId],
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }

    // 造未处理汇报与受阻意图（直写受控库行——诊断面为只读聚合，夹具同 D1 先例）
    const { getStore, closeStore } = await import("../lib/store/record-service.mjs");
    const store = await getStore({ dataDir: s.dataDir });
    store.runSerial((db) => {
      const now = new Date().toISOString();
      // 受阻意图 → 其 Attempt → unknown 工具调用（真实外键链，规范 §10.2）
      db.prepare(
        `INSERT INTO intents (id, project_id, question, kind, status, created_at, created_by, created_seq,
           updated_seq, state_version)
         VALUES ('I-DIAG-B', ?, '受阻方向', 'investigate', 'blocked', ?, 'w', 2, 0, 1)`,
      ).run(p.id, now);
      db.prepare(
        `INSERT INTO attempts (id, project_id, intent_id, assignment_id, worker_id, fencing_token,
           status, created_at, created_by, created_seq)
         VALUES ('ATT-DIAG', ?, 'I-DIAG-B', 'ASM-DIAG', 'w', 1, 'suspended', ?, 'w', 3)`,
      ).run(p.id, now);
      db.prepare(
        `INSERT INTO tool_calls (id, project_id, attempt_id, tool_name, status, created_at, created_by, created_seq)
         VALUES ('TC-DIAG-U', ?, 'ATT-DIAG', 'probe', 'unknown', ?, 'w', 4)`,
      ).run(p.id, now);
      db.prepare(
        `INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, content,
           delivery_status, handling_status, created_at, created_by, created_seq)
         VALUES ('WR-DIAG-1', ?, 'I-DIAG-B', 'ATT-DIAG', 'handoff', '{}', 'delivered', 'pending', ?, 'w', 5)`,
      ).run(p.id, now);
      return null;
    });

    const res = await call(base, "GET", `/sorne/diagnostics?project_id=${p.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
    const proj = res.body.project;
    assert.equal(proj.status, "active");
    assert.equal(proj.verification.pending_jobs, 2, "造 2 个 pending 任务 → 计数 2");
    assert.ok(proj.verification.oldest_wait_seconds >= 0);
    assert.equal(proj.reports.unhandled_worker_reports, 1);
    assert.deepEqual(proj.intents.blocked_ids, ["I-DIAG-B"]);
    assert.equal(proj.attempts.unknown_tool_calls.length, 1);
    assert.equal(proj.attempts.unknown_tool_calls[0].id, "TC-DIAG-U");
    assert.match(proj.attempts.unknown_note, /须先检查外部现状再决定重试，不得当作已完成或已失败/);
    assert.equal(proj.messages.pending_user, 0);
    assert.equal(proj.outbox.pending >= 1, true, "事件应计入待投递");
    assert.ok(proj.outbox.oldest_pending_age_s >= 0);
    assert.equal(proj.projection.asset_map, null, "未投影记 null，不冒充 0 滞后");
    assert.equal(proj.projection.planner_view, null);
    assert.ok(proj.high_watermark >= 1);
    assert.ok("staged_blobs" in proj.evidence);
    await closeStore({ dataDir: s.dataDir });
  });
});

test("未知项目 404 不泄露存在性；诊断端点无分页信封", async () => {
  await withTestServer(async (s) => {
    const res = await call(s.base, "GET", "/sorne/diagnostics?project_id=PRJ-9999");
    assert.equal(res.status, 404);
    assert.match(res.body.message, /项目不存在/);
    assert.ok(!("next_cursor" in res.body));
  });
});
