/**
 * M2 —— 项目列表 summary 扩展测试（蓝图 §2.6-5 / §d-9；评审 §4d「GET /projects 无分页」）。
 *
 * 覆盖：
 *   - summary 五列真实（造未处理汇报/待验证/受阻意图后断言计数；最近进展来自
 *     真实事件；全部「按已加载数据推导」口径标注）；
 *   - cursor 真分页（limit=1 两页取全且不重复）；
 *   - 不带 include=summary 时保持旧形体（兼容既有调用方）。
 *
 * 真实注入：真实端点 + 真实 SQLite；并行安全（mkdtemp + 随机端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { getStore, closeStore } from "../lib/store/record-service.mjs";

const POLICY = registerVerificationPolicy({
  id: "m2-projsum",
  version: "v1",
  required_checks: ["m2.check"],
  description: "M2 项目摘要测试策略",
});

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-ps`, role });
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

test("summary 五列真实：状态/最近进展/待处理计数来自库内事实；游标真分页；旧形体兼容", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p1 = (await call(base, "POST", "/sorne/projects", { body: { name: "摘要项目一", description: "目标" } })).body.project;
    const p2 = (await call(base, "POST", "/sorne/projects", { body: { name: "摘要项目二", description: "目标" } })).body.project;
    const w = session(p1.id, "worker");

    // 造待验证（2 个 pending 任务）
    const sub = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "ps-v",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "ps", location: "/ps" }],
      },
    });
    const vulnId = sub.body.ids.v;
    const up = await fetch(`${base}/sorne/evidence/blobs?project_id=${p1.id}&representation=raw_body`, {
      method: "POST", headers: { origin: base }, body: "ps",
    });
    const blobId = JSON.parse(await up.text()).blob_id;
    for (let i = 0; i < 2; i += 1) {
      const r = await call(base, "POST", "/sorne/verification-requests", {
        session: w,
        body: {
          subject_id: vulnId,
          policy_id: POLICY.id,
          policy_version: POLICY.version,
          conditions: [`ps-cond-${i}`],
          raw_evidence_refs: [blobId],
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }

    // 造未处理汇报 + 受阻意图（真实外键链，直写受控库行）
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO intents (id, project_id, question, kind, status, created_at, created_by, created_seq, updated_seq, state_version)
         VALUES ('I-PS-B', ?, '受阻方向', 'investigate', 'blocked', ?, 'w', 2, 0, 1)`,
      ).run(p1.id, now);
      db.prepare(
        `INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, content, delivery_status, handling_status, created_at, created_by, created_seq)
         VALUES ('WR-PS-1', ?, 'I-PS-B', 'ATT-PS', 'handoff', '{}', 'delivered', 'pending', ?, 'w', 3)`,
      ).run(p1.id, now);
      return null;
    });

    const sum = await call(base, "GET", "/sorne/projects?include=summary&limit=1");
    assert.equal(sum.status, 200, JSON.stringify(sum.body));
    assert.equal(sum.body.projects.length, 1, "limit=1 → 第一页一条");
    assert.equal(sum.body.has_more, true);
    assert.ok(sum.body.next_cursor);
    const row1 = sum.body.projects[0];
    assert.equal(row1.id, p1.id, "按 created_seq 排序：第一页是首项目");
    assert.equal(row1.status, "active");
    assert.ok(row1.latest_progress, "最近进展来自真实事件");
    assert.match(row1.latest_progress, /asset\.discovered|vulnerability\.state_changed|message\.|scope\.|project/);
    assert.ok(row1.last_activity_at);
    assert.equal(row1.pending.pending_verification, 2, "造 2 个 pending 任务 → 计数 2");
    assert.equal(row1.pending.unhandled_reports, 1);
    assert.equal(row1.pending.blocked_intents, 1);
    assert.match(sum.body.note, /按已加载数据推导/);

    // 第二页：cursor 续读不重复
    const page2 = await call(base, "GET", `/sorne/projects?include=summary&limit=1&cursor=${encodeURIComponent(sum.body.next_cursor)}`);
    assert.equal(page2.status, 200);
    assert.equal(page2.body.projects.length, 1);
    assert.equal(page2.body.projects[0].id, p2.id);
    assert.equal(page2.body.has_more, false);
    assert.equal(page2.body.next_cursor, null);

    // 非法 cursor 明确报错
    const bad = await call(base, "GET", "/sorne/projects?include=summary&cursor=bogus");
    assert.equal(bad.status, 400);

    // 旧形体兼容（无 include=summary）
    const legacy = await call(base, "GET", "/sorne/projects");
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.projects));
    assert.equal(legacy.body.projects.length, 2);
    assert.ok(!("next_cursor" in legacy.body));
    assert.ok(!("pending" in legacy.body.projects[0]), "旧形体不混入 summary 字段");
    await closeStore({ dataDir: s.dataDir });
  });
});
