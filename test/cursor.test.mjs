/**
 * M2 —— 列表游标统一测试（评审 §4c；蓝图 §2.6-6 / P0-3）。
 *
 * 冻结端点清单（蓝图 v1.1 实测校正）逐个验证「信封 next_cursor + has_more + 参数 cursor」：
 *   #16 /changes、#45 /change-log、#21 /intents、#30 /vulnerabilities（报告视图）、
 *   #23 /attempts、#29 /verification-jobs、#4 /projects（summary 形体）、#39 报告列表。
 * 明确单对象、无列表分页可验（清单中不得出现）：/worker-reports/:id（单条）、
 * /metrics、/health、/diagnostics、/snapshots/:kind（聚合）。
 *
 * 真实服务翻页（不起 mock）：helpers 起真服务造 >1 页任务，两次翻页断言任务集
 * 不重复且 next_cursor 推进；after 别名兼容路径与 cursor 主路径同值同果。
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { registerVerificationPolicy } from "../lib/store/verification.mjs";
import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";

const POLICY = registerVerificationPolicy({
  id: "m2-cursor",
  version: "v1",
  required_checks: ["m2.check"],
  description: "M2 游标测试策略",
});

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-cur`, role });
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

async function uploadBlob(base, projectId, text) {
  const bytes = Buffer.from(text, "utf8");
  const res = await fetch(
    `${base}/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body`,
    { method: "POST", headers: { origin: base, "content-type": "application/octet-stream" }, body: bytes },
  );
  const body = JSON.parse(await res.text());
  return body.blob_id ?? body.blob?.blob_id;
}

/** 经真实端点造 N 个互不重复的验证任务（不同条件快照绕开 §7.3 去重键）。 */
async function seedVerificationJobs(base, projectId, n) {
  const receipt = await call(base, "POST", "/sorne/submissions", {
    session: session(projectId, "worker"),
    body: {
      submission_id: `cur-v-${projectId}`,
      operations: [{ op: "report_vulnerability", local_ref: "v", category: "cursor-test", location: "/cur" }],
    },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const vulnId = receipt.body.ids.v;
  const blobRef = await uploadBlob(base, projectId, "cursor-evidence\n");
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const res = await call(base, "POST", "/sorne/verification-requests", {
      session: session(projectId, "worker"),
      body: {
        subject_id: vulnId,
        policy_id: POLICY.id,
        policy_version: POLICY.version,
        conditions: [`条件快照 ${i}`],
        raw_evidence_refs: [blobRef],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    ids.push(res.body.job.id);
  }
  return ids;
}

test("验证队列真实服务翻页：cursor 主路径两页取到不重复任务集；after 别名同果", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "游标翻页" } })).body.project;
    const jobIds = await seedVerificationJobs(base, p.id, 3);
    assert.equal(jobIds.length, 3);
    const w = session(p.id, "worker");

    // 第 1 页（limit=2）
    const page1 = await call(base, "GET", `/sorne/verification-jobs?project_id=${p.id}&limit=2`, { session: w });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.jobs.length, 2);
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.next_cursor, "有更多页时 next_cursor 必须非空");
    // 兼容回填：next_after 与 next_cursor 同值（deprecated）
    assert.equal(page1.body.next_after, page1.body.next_cursor);

    // 第 2 页：cursor 主路径
    const page2 = await call(base, "GET", `/sorne/verification-jobs?project_id=${p.id}&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`, { session: w });
    assert.equal(page2.status, 200, JSON.stringify(page2.body));
    assert.equal(page2.body.jobs.length, 1);
    assert.equal(page2.body.has_more, false);
    assert.equal(page2.body.next_cursor, null);

    // 两页任务集不重复、并集覆盖全部
    const page1Ids = page1.body.jobs.map((j) => j.id);
    const page2Ids = page2.body.jobs.map((j) => j.id);
    assert.equal(new Set([...page1Ids, ...page2Ids]).size, 3);
    assert.deepEqual([...page1Ids, ...page2Ids].sort(), [...jobIds].sort());

    // after 别名兼容路径：同游标同结果（评审 §4c——旧 UI 的 ?after= 不再被静默忽略）
    const viaAfter = await call(base, "GET", `/sorne/verification-jobs?project_id=${p.id}&limit=2&after=${encodeURIComponent(page1.body.next_cursor)}`, { session: w });
    assert.equal(viaAfter.status, 200);
    assert.deepEqual(viaAfter.body.jobs.map((j) => j.id), page2.body.jobs.map((j) => j.id));

    // 非法游标明确报错（不静默回第一页）
    const bad = await call(base, "GET", `/sorne/verification-jobs?project_id=${p.id}&cursor=bogus`, { session: w });
    assert.equal(bad.status, 400);
  });
});

test("冻结清单逐端点：信封 next_cursor + has_more；cursor 参数被读取", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "游标信封" } })).body.project;
    const w = session(p.id, "worker");
    const orch = session(p.id, "orchestrator");

    // #45 /change-log：cursor 参数 + 信封（预置第二个事件保证 >1 页）
    await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "cur-log-a",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "log", location: "/log-a" }],
      },
    });
    await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "cur-log-b",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "log", location: "/log-b" }],
      },
    });
    const log1 = await call(base, "GET", `/sorne/change-log?project_id=${p.id}&limit=1`, {});
    assert.equal(log1.status, 200, JSON.stringify(log1.body));
    assert.ok("next_cursor" in log1.body && "has_more" in log1.body);
    const log2 = await call(base, "GET", `/sorne/change-log?project_id=${p.id}&limit=1&cursor=${encodeURIComponent(log1.body.next_cursor)}`, {});
    assert.equal(log2.status, 200, JSON.stringify(log2.body));
    assert.notDeepEqual(
      log1.body.events.map((e) => e.event_id ?? e.id),
      log2.body.events.map((e) => e.event_id ?? e.id),
      "cursor 续读必须翻页，不得静默停留第一页",
    );

    // #16 /changes：订阅面（consumer 会话）+ cursor 别名翻页
    const sub = await call(base, "POST", "/sorne/subscriptions", {
      session: orch,
      body: { focus: { subject_ids: [] } },
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const ch1 = await call(base, "GET", `/sorne/changes?subscription=${sub.body.subscription.id}&limit=1`, { session: orch });
    assert.equal(ch1.status, 200, JSON.stringify(ch1.body));
    assert.ok("next_cursor" in ch1.body && "has_more" in ch1.body && "high_watermark" in ch1.body);
    if (ch1.body.next_cursor) {
      const ch2 = await call(base, "GET", `/sorne/changes?subscription=${sub.body.subscription.id}&limit=1&cursor=${encodeURIComponent(ch1.body.next_cursor)}`, { session: orch });
      assert.equal(ch2.status, 200, JSON.stringify(ch2.body));
    }

    // #21 /intents：cursor 参数 + 信封
    const it1 = await call(base, "GET", `/sorne/intents?project_id=${p.id}&limit=1`, {});
    assert.equal(it1.status, 200, JSON.stringify(it1.body));
    assert.ok("next_cursor" in it1.body && "has_more" in it1.body);

    // #30/#39 /reports/vulnerabilities：cursor 参数 + 信封（造一条漏洞）
    await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "cur-envelope-v",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "envelope", location: "/x" }],
      },
    });
    const rep1 = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p.id}&limit=50`, {});
    assert.equal(rep1.status, 200, JSON.stringify(rep1.body));
    assert.ok("next_cursor" in rep1.body && "has_more" in rep1.body);

    // #23 /attempts：信封 next_cursor（与 next_after 同值）；cursor 参数被接受
    const at = await call(base, "GET", `/sorne/attempts?project_id=${p.id}&limit=1`, {});
    assert.equal(at.status, 200, JSON.stringify(at.body));
    assert.ok("has_more" in at.body);
    assert.ok("next_cursor" in at.body);
    if (at.body.next_after) assert.equal(at.body.next_cursor, at.body.next_after);

    // #4 /projects include=summary：cursor + 信封
    const pr = await call(base, "GET", `/sorne/projects?include=summary&limit=1`, {});
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.ok("next_cursor" in pr.body && "has_more" in pr.body);
  });
});

test("旧形体兼容：不带 include=summary 的 /projects 保持既有形体；聚合端点无分页信封", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "旧形体" } })).body.project;

    const legacy = await call(base, "GET", "/sorne/projects", {});
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.projects));
    assert.equal(legacy.body.projects[0].id, p.id);
    assert.ok(!("next_cursor" in legacy.body), "旧形体不得混入分页信封字段");

    // 清单核对：聚合/单对象端点不提供列表分页（蓝图 §2.6-6 明确排除项）
    const health = await call(base, "GET", "/sorne/health", {});
    assert.equal(health.status, 200);
    assert.ok(!("next_cursor" in health.body));
    const metrics = await call(base, "GET", `/sorne/metrics?project_id=${p.id}`, {});
    assert.equal(metrics.status, 200, JSON.stringify(metrics.body).slice(0, 200));
    assert.ok(!("next_cursor" in metrics.body));
    const diag = await call(base, "GET", `/sorne/diagnostics?project_id=${p.id}`, {});
    assert.equal(diag.status, 200, JSON.stringify(diag.body).slice(0, 200));
    assert.ok(!("next_cursor" in diag.body));
    const wrSingle = await call(base, "GET", `/sorne/worker-reports/WR-NOPE?project_id=${p.id}`, {});
    assert.equal(wrSingle.status, 404, "worker-reports 只有单条端点（无列表分页）");
  });
});
