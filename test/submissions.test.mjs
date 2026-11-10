/**
 * A1 —— 幂等提交与统一记录服务测试（规范 §5.1 §6.1 §11.1 §11.3 §13 §16.4 §17 §20.1 §20.3）。
 *
 * 覆盖蓝图 §7 中 A1 主责场景：1（并发同资产）、2（重复发送）、3（同 ID 异内容）、
 * 10（无关备注不推进版本）、12（提交后通知前重启，A1 侧：Outbox 完整保留）、
 * 19（漏洞即时持久化可引用、状态不被提交提升）、24（回执丢失后恢复），
 * 以及 §21 阶段 A 完成标准（并发提交、重复请求、提交中断后可恢复、历史证据不被覆盖）。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer），
 * 不留后台进程、不触碰 ~/.sorne。事务与重启故障用真实注入，不用 mock。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { openDatabase } from "../lib/db.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import {
  closeStore,
  getStore,
  registerSubmissionOps,
  submit,
} from "../lib/store/record-service.mjs";
import { makeTempDir, withTestServer } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有 HTTP 工具（helpers.request 不支持会话头，helpers 为冻结文件） ── */

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

/** 重启演练专用服务器：显式 dataDir，关闭时不删除目录（模拟进程退出再拉起）。 */
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

async function createProject(base, { name = "测试项目", scope_rules } = {}) {
  const res = await call(base, "POST", "/sorne/projects", { body: { name, scope_rules } });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function workerSession(projectId, actor = "w1") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}

/** 直接读取库内行（与服务器同一受控句柄；断言后应 closeStore 释放）。 */
async function openRows(dataDir) {
  const store = await getStore({ dataDir });
  return store.db;
}

const ASSET = {
  op: "register_asset",
  local_ref: "a",
  asset_type: "domain",
  canonicalization_version: "v1",
  canonical_key: "target.test",
};

/* ── 故障注入操作：真实写入后抛错，验证整组回滚（§11.3 逻辑依赖组） ── */

registerSubmissionOps("test/submissions", [
  {
    name: "__test_explode_after_write",
    kind: "append",
    roles: ["worker"],
    handler(ctx) {
      ctx.db
        .prepare(
          `INSERT INTO observations (id, project_id, capture_id, anchor, statement, conditions,
             created_at, created_by, created_seq)
           VALUES ('O-TEST-BOOM', ?, NULL, '{}', '注入标记：不应存在', '[]', ?, ?, ?)`,
        )
        .run(ctx.projectId, ctx.now, ctx.actor, ctx.commitSeq);
      throw new Error("注入：业务写入后崩溃");
    },
  },
]);

/* ── 项目 / 生命周期 / 范围（§16.4/§17） ──────────────────────────── */

test("项目：创建（含初始范围版本）/列表/详情；未带范围时详情 scope=null", () =>
  withTestServer(async (s) => {
    const withScope = await createProject(s.base, {
      name: "带范围",
      scope_rules: { allow: ["*.target.test"], deny: ["evil.test"], pending: [] },
    });
    assert.equal(withScope.status, "active");
    assert.match(withScope.id, /^PRJ-\d+$/);
    const bare = await createProject(s.base, { name: "无范围" });

    const list = await call(s.base, "GET", "/sorne/projects");
    assert.equal(list.status, 200);
    assert.equal(list.body.projects.length, 2);

    const detail = await call(s.base, "GET", `/sorne/projects/${withScope.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.scope.revision, "1");
    assert.deepEqual(detail.body.scope.rules.allow, ["*.target.test"]);

    const bareDetail = await call(s.base, "GET", `/sorne/projects/${bare.id}`);
    assert.equal(bareDetail.body.scope, null);

    const missing = await call(s.base, "GET", "/sorne/projects/PRJ-9999");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "NOT_FOUND");
    await closeStore({ dataDir: s.dataDir });
  }));

test("项目：无范围时 GET /scope 明确 configured=false，不默认任意目标可操作（§17）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "无范围项目" });
    const res = await call(s.base, "GET", `/sorne/projects/${p.id}/scope`);
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.current, null);
    assert.match(res.body.note, /不得默认任意目标/);
    await closeStore({ dataDir: s.dataDir });
  }));

test("生命周期：pause/wait/stop/resume 合法迁移并推进 state_version（§16.4）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "生命周期" });
    const v0 = p.state_version;

    const wait = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "wait" } });
    assert.equal(wait.status, 200);
    assert.equal(wait.body.project.status, "waiting_for_change");
    assert.equal(wait.body.project.state_version, v0 + 1);

    const pause = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "pause" } });
    assert.equal(pause.body.project.status, "paused");

    const stop = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
    assert.equal(stop.body.project.status, "stopped");

    const resume = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "resume" } });
    assert.equal(resume.body.project.status, "active");

    // 停止不结束项目：stopped 下仍可保存已产生证据（§16.4 允许已产生证据被保存）
    const stopped = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
    assert.equal(stopped.body.project.status, "stopped");
    const session = workerSession(p.id, "w-stop");
    const saved = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-STOP-SAVE-1",
        operations: [{ op: "append_observation", local_ref: "o", statement: "停止后留档的观察" }],
      },
      session,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await closeStore({ dataDir: s.dataDir });
  }));

test("生命周期：非法迁移 PRECONDITION_INVALID；错误 expected_state_version STALE_STATE；未知动作 BAD_REQUEST", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "迁移校验" });
    const stopped = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "stop" } });
    assert.equal(stopped.status, 200);
    const currentVersion = stopped.body.project.state_version;

    const badTransition = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "pause" } });
    assert.equal(badTransition.status, 422);
    assert.equal(badTransition.body.code, "PRECONDITION_INVALID");

    const stale = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, {
      body: { action: "resume", expected_state_version: 999 },
    });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "STALE_STATE");
    assert.equal(stale.body.detail.current_state_version, currentVersion);

    const unknown = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, { body: { action: "explode" } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "BAD_REQUEST");
    await closeStore({ dataDir: s.dataDir });
  }));

test("范围版本：新增版本推进 revision、更新 current、发 scope.revised 事件；非法 rules 拒绝（§17）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "范围版本" });
    const r1 = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["a.test"], deny: [], pending: ["b.test"] }, summary: "第一版" },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.scope_revision.revision, "1");

    const r2 = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["a.test", "c.test"] }, summary: "扩大允许" },
    });
    assert.equal(r2.body.scope_revision.revision, "2");

    const scope = await call(s.base, "GET", `/sorne/projects/${p.id}/scope`);
    assert.equal(scope.body.current.id, r2.body.scope_revision.id);
    assert.equal(scope.body.history.length, 2);

    const db = await openRows(s.dataDir);
    const events = db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'scope.revised'")
      .all(p.id);
    assert.equal(events.length, 2);

    const bad = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: "不是数组" } },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "BAD_REQUEST");

    const missing = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: "PRJ-9999", rules: {} },
    });
    assert.equal(missing.status, 404);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 会话与角色（§11.1；蓝图 §8） ─────────────────────────────────── */

test("会话：无会话/过期会话/user 会话不能提交；信封自报 project_id/actor/role 拒绝", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "会话校验" });
    const envelope = {
      submission_id: "SUB-AUTH-1",
      operations: [{ op: "append_observation", local_ref: "o", statement: "x" }],
    };

    const noSession = await call(s.base, "POST", "/sorne/submissions", { body: envelope });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.body.code, "TRUST_DENIED");

    const expired = issueSession({ project_id: p.id, actor: "w-exp", role: "worker", ttl_ms: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const expiredRes = await call(s.base, "POST", "/sorne/submissions", { body: envelope, session: expired });
    assert.equal(expiredRes.status, 403);

    const userSession = issueSession({ project_id: p.id, actor: "ui", role: "user" });
    const userRes = await call(s.base, "POST", "/sorne/submissions", { body: envelope, session: userSession });
    assert.equal(userRes.status, 403);
    assert.match(userRes.body.message, /无权执行操作 append_observation/);

    const selfReported = await call(s.base, "POST", "/sorne/submissions", {
      body: { ...envelope, project_id: p.id, actor: "fake", role: "worker" },
      session: workerSession(p.id),
    });
    assert.equal(selfReported.status, 400);
    assert.match(selfReported.body.message, /由服务端会话决定/);
    await closeStore({ dataDir: s.dataDir });
  }));

test("用户面端点：worker 会话访问项目/范围/生命周期端点被拒（蓝图 §8.2）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "用户面" });
    const worker = workerSession(p.id);
    for (const [method, path, body] of [
      ["GET", "/sorne/projects", undefined],
      ["POST", "/sorne/projects", { name: "x" }],
      ["GET", `/sorne/projects/${p.id}`, undefined],
      ["POST", `/sorne/projects/${p.id}/lifecycle`, { action: "pause" }],
      ["POST", "/sorne/scope-revisions", { project_id: p.id, rules: {} }],
    ]) {
      const res = await call(s.base, method, path, { body, session: worker });
      assert.equal(res.status, 403, `${method} ${path} 应拒绝 worker 会话`);
      assert.equal(res.body.code, "TRUST_DENIED");
    }
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 幂等提交（§11.1；§20.3 场景 2/3/24） ────────────────────────── */

test("场景2：同一提交重复发送 → 返回原回执，不重复创建事件或记录", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "幂等重放" });
    const session = workerSession(p.id, "w-retry");
    const envelope = {
      submission_id: "SUB-RETRY-1",
      operations: [
        ASSET,
        { op: "append_observation", local_ref: "o", statement: "首次观察" },
      ],
    };
    const first = await call(s.base, "POST", "/sorne/submissions", { body: envelope, session });
    assert.equal(first.status, 200);
    assert.ok(first.body.result_hash);

    const replay = await call(s.base, "POST", "/sorne/submissions", { body: envelope, session });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body); // 原回执，含相同 commit_seq / result_hash

    const db = await openRows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE project_id = ?").get(p.id).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(p.id).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?").get(p.id).c, 2);
    await closeStore({ dataDir: s.dataDir });
  }));

test("场景24：库已成功但回执未达客户端 → 同 submission_id 经 HTTP 恢复原回执", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "回执丢失" });
    const session = workerSession(p.id, "w-lost");
    const envelope = {
      submission_id: "SUB-LOST-1",
      operations: [{ op: "append_observation", local_ref: "o", statement: "回执在途中丢失" }],
    };
    // 直接经记录服务提交：等价于「数据库已提交、HTTP 响应未返回客户端」
    const committed = await submit({ dataDir: s.dataDir }, { session, envelope });
    assert.ok(committed.result_hash);

    const viaHttp = await call(s.base, "POST", "/sorne/submissions", { body: envelope, session });
    assert.equal(viaHttp.status, 200);
    assert.deepEqual(viaHttp.body, committed);
    await closeStore({ dataDir: s.dataDir });
  }));

test("场景3：同 ID 配不同内容 → IDEMPOTENCY_KEY_REUSED，原提交不被覆盖", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "键复用" });
    const session = workerSession(p.id, "w-reuse");
    const original = {
      submission_id: "SUB-REUSE-1",
      operations: [{ op: "append_observation", local_ref: "o", statement: "原始内容" }],
    };
    const first = await call(s.base, "POST", "/sorne/submissions", { body: original, session });
    assert.equal(first.status, 200);

    const conflict = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-REUSE-1",
        operations: [{ op: "append_observation", local_ref: "o2", statement: "不同的内容" }],
      },
      session,
    });
    assert.equal(conflict.status, 422);
    assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(conflict.body.retryable, false);
    assert.equal(conflict.body.receipt.commit_seq, first.body.commit_seq); // 已保存内容的回执（§20.1）

    // 原样重发仍得到原回执：原提交未被覆盖
    const again = await call(s.base, "POST", "/sorne/submissions", { body: original, session });
    assert.deepEqual(again.body, first.body);
    const db = await openRows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(p.id).c, 1);
    await closeStore({ dataDir: s.dataDir });
  }));

test("身份域（§11.1）：不同 submitter 各自独立幂等，同 submission_id 互不冲突", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "身份域" });
    const w1 = workerSession(p.id, "worker-a");
    const w2 = workerSession(p.id, "worker-b");
    const envelope = (statement) => ({
      submission_id: "SUB-SAME-NAME",
      operations: [{ op: "append_observation", local_ref: "o", statement }],
    });
    const r1 = await call(s.base, "POST", "/sorne/submissions", { body: envelope("A 的观察"), session: w1 });
    const r2 = await call(s.base, "POST", "/sorne/submissions", { body: envelope("B 的观察"), session: w2 });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.body.commit_seq, r2.body.commit_seq);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 并发与 commit_seq（§14.1；§20.3 场景 1；§21 阶段 A） ─────────── */

test("场景1：两个 worker 并发提交同一精确资产 → 一个节点、两个来源、无覆盖", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "并发资产" });
    const mk = (actor, srcStatement, submissionId) => ({
      session: workerSession(p.id, actor),
      body: {
        submission_id: submissionId,
        operations: [
          { op: "append_observation", local_ref: "src", statement: srcStatement },
          { ...ASSET, local_ref: "a", discovered_from: "src" },
        ],
      },
    });
    const [ra, rb] = await Promise.all([
      call(s.base, "POST", "/sorne/submissions", mk("worker-a", "来源 A 的观察", "SUB-RACE-A")),
      call(s.base, "POST", "/sorne/submissions", mk("worker-b", "来源 B 的观察", "SUB-RACE-B")),
    ]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));

    // 一个资产节点；两位提交者拿到同一正式 ID
    assert.equal(ra.body.ids.a, rb.body.ids.a);
    // 后写入方按唯一约束归并并得到告警（先查询再插入做不到这一点）
    const mergeWarnings = [ra, rb].filter((r) => r.body.warnings.some((w) => /归并为同一节点/.test(w)));
    assert.equal(mergeWarnings.length, 1);

    const db = await openRows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM assets WHERE project_id = ?").get(p.id).c, 1);
    // 两个来源（两条观察 + 两条 discovered_from 边）无覆盖地保留（§20.3 场景 1）
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(p.id).c, 2);
    const edges = db
      .prepare("SELECT * FROM relations WHERE project_id = ? AND relation_type = 'discovered_from'")
      .all(p.id);
    assert.equal(edges.length, 2);
    // 两次发现都留痕：asset.discovered 事件各一条，first_discovery 恰一真一假
    const discovered = db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'asset.discovered'")
      .all(p.id);
    assert.equal(discovered.length, 2);
    const firstFlags = discovered.map((e) => JSON.parse(e.payload).first_discovery).sort();
    assert.deepEqual(firstFlags, [false, true]);
    await closeStore({ dataDir: s.dataDir });
  }));

test("commit_seq：并发提交获得唯一且连续的项目级提交序号（§14.1 事务内分配）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "序号" });
    const session = workerSession(p.id, "w-seq");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(s.base, "POST", "/sorne/submissions", {
          body: {
            submission_id: `SUB-SEQ-${i}`,
            operations: [{ op: "append_observation", local_ref: "o", statement: `观察 ${i}` }],
          },
          session,
        }),
      ),
    );
    for (const r of results) assert.equal(r.status, 200);
    const seqs = results.map((r) => r.body.commit_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [2, 3, 4, 5, 6, 7]); // 1 为项目创建；之后连续无重复
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 追加/修改分流与证据版本（§11.3；§20.3 场景 10） ──────────────── */

test("场景10：无关备注不推进 evidence_revision；支持/反对关系才推进", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "版本分流" });
    const session = workerSession(p.id, "w-ev");
    const hyp = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-EV-1",
        operations: [{ op: "propose_hypothesis", local_ref: "h", statement: "入口存在访问控制异常" }],
      },
      session,
    });
    const hid = hyp.body.ids.h;

    const note = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-EV-2",
        operations: [{ op: "append_observation", local_ref: "n", statement: "与判断无关的备注：脚本超时一次" }],
      },
      session,
    });
    assert.equal(note.status, 200);

    const db = await openRows(s.dataDir);
    let row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(hid);
    assert.equal(row.evidence_revision, 1, "无关备注不得推进判断对象的证据集版本（§20.3 场景 10）");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'evidence_set.revised'").get(p.id).c,
      0,
    );

    const support = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-EV-3",
        operations: [
          { op: "append_observation", local_ref: "o", statement: "该请求返回 500" },
          { op: "add_relation", local_ref: "rel", from: "o", type: "supports", to: hid },
        ],
      },
      session,
    });
    assert.equal(support.status, 200);
    row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(hid);
    assert.equal(row.evidence_revision, 2);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'evidence_set.revised'").get(p.id).c,
      1,
    );
    await closeStore({ dataDir: s.dataDir });
  }));

test("证据成员重复（§12.3）：完全重复的关系去重返回，不触发复核、不推进版本", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "去重" });
    const session = workerSession(p.id, "w-dup");
    const base = {
      submission_id: "SUB-DUP-1",
      operations: [
        { op: "propose_hypothesis", local_ref: "h", statement: "待验证判断" },
        { op: "append_observation", local_ref: "o", statement: "证据观察" },
        { op: "add_relation", from: "o", type: "supports", to: "h" },
      ],
    };
    const first = await call(s.base, "POST", "/sorne/submissions", { body: base, session });
    assert.equal(first.status, 200);
    const hid = first.body.ids.h;
    const oid = first.body.ids.o;

    const dup = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-DUP-2",
        operations: [{ op: "add_relation", from: oid, type: "supports", to: hid }],
      },
      session,
    });
    assert.equal(dup.status, 200);
    assert.ok(dup.body.warnings.some((w) => /去重处理/.test(w)));

    const db = await openRows(s.dataDir);
    const row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(hid);
    assert.equal(row.evidence_revision, 2, "首次加入推进一次；重复加入不推进");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND event_type = 'evidence_set.revised'").get(p.id).c,
      1,
    );
    await closeStore({ dataDir: s.dataDir });
  }));

test("修改型（§11.3）：revise_hypothesis 与 retract_relation 校验期望版本并推进 claim_revision", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "修改型" });
    const session = workerSession(p.id, "w-mod");
    const created = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-MOD-1",
        operations: [
          { op: "propose_hypothesis", local_ref: "h", statement: "初版判断" },
          { op: "append_observation", local_ref: "o", statement: "证据" },
          { op: "add_relation", local_ref: "rel", from: "o", type: "supports", to: "h" },
        ],
      },
      session,
    });
    const hid = created.body.ids.h;
    const relId = created.body.ids.rel;
    const seq = created.body.commit_seq;

    const stale = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-MOD-2",
        operations: [{ op: "revise_hypothesis", id: hid, expected_state_version: 99, statement: "越权修改" }],
      },
      session,
    });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "STALE_STATE");

    const ok = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-MOD-3",
        operations: [{ op: "revise_hypothesis", id: hid, expected_state_version: 1, statement: "修订后的核心判断" }],
      },
      session,
    });
    assert.equal(ok.status, 200);
    const db = await openRows(s.dataDir);
    const row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(hid);
    assert.equal(row.statement, "修订后的核心判断");
    assert.equal(row.claim_revision, 2, "更改核心判断推进 claim_revision（§11.3）");
    assert.equal(row.state_version, 2);

    const staleRetract = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-MOD-4",
        operations: [{ op: "retract_relation", id: relId, expected_valid_from_seq: seq + 100 }],
      },
      session,
    });
    assert.equal(staleRetract.status, 422);
    assert.equal(staleRetract.body.code, "STALE_STATE");

    const evBefore = db.prepare("SELECT evidence_revision AS e FROM hypotheses WHERE id = ?").get(hid).e;
    const retract = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-MOD-5",
        operations: [{ op: "retract_relation", id: relId, expected_valid_from_seq: seq }],
      },
      session,
    });
    assert.equal(retract.status, 200);
    const relRow = db.prepare("SELECT * FROM relations WHERE id = ?").get(relId);
    assert.ok(relRow.retracted_at, "撤回时间已记录");
    const evAfter = db.prepare("SELECT evidence_revision AS e FROM hypotheses WHERE id = ?").get(hid).e;
    assert.equal(evAfter, evBefore + 1, "证据撤回推进 evidence_revision（§12.1）");
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 引用校验与原子性（§11.3；§20.1） ─────────────────────────────── */

test("INVALID_REFERENCE：引用缺失时整组回滚，无半截记录（§11.3 逻辑依赖组）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "引用" });
    const session = workerSession(p.id, "w-ref");
    const res = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-REF-1",
        operations: [
          { op: "append_observation", local_ref: "o", statement: "应被回滚的观察" },
          { op: "add_relation", from: "o", type: "supports", to: "H-9999" },
        ],
      },
      session,
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_REFERENCE");

    const db = await openRows(s.dataDir);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(p.id).c, 0, "同组操作全部回滚");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE project_id = ?").get(p.id).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?").get(p.id).c, 0);
    await closeStore({ dataDir: s.dataDir });
  }));

test("attempt_id 引用不存在的执行尝试 → INVALID_REFERENCE", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "attempt引用" });
    const res = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-ATT-1",
        attempt_id: "ATT-9999",
        operations: [{ op: "append_observation", local_ref: "o", statement: "x" }],
      },
      session: workerSession(p.id),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_REFERENCE");
    await closeStore({ dataDir: s.dataDir });
  }));

test("故障注入：操作真实写入后抛错 → 事务整体回滚，库内无提交痕迹", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "注入" });
    const session = workerSession(p.id, "w-boom");
    const before = await call(s.base, "GET", "/sorne/health");

    const res = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-BOOM-1",
        operations: [
          { op: "append_observation", local_ref: "o", statement: "前置观察" },
          { op: "__test_explode_after_write" },
        ],
      },
      session,
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, "INTERNAL_ERROR");

    const db = await openRows(s.dataDir);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM observations WHERE statement = '注入标记：不应存在'").get().c,
      0,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ?").get(p.id).c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE id = ?").get("SUB-BOOM-1").c, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?").get(p.id).c,
      before.body.outbox.total,
      "无新增事件",
    );
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 漏洞即时持久化（§8.2；§20.3 场景 19） ────────────────────────── */

test("场景19：疑似漏洞即时持久化可被引用；worker 无法借提交确认（状态不被提升）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "漏洞持久化" });
    const session = workerSession(p.id, "w-vuln");
    const created = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-VULN-1",
        operations: [
          ASSET,
          { op: "report_vulnerability", local_ref: "v", category: "broken_access_control", asset_id: "a", location: "/api/login" },
        ],
      },
      session,
    });
    assert.equal(created.status, 200);
    const vid = created.body.ids.v;
    assert.match(vid, /^V-\d+$/);

    // 「上下文压缩」后：漏洞已在库，后续提交仍可按正式 ID 引用（§20.3 场景 19）
    const ref = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-VULN-2",
        operations: [
          { op: "append_observation", local_ref: "o", statement: "补充观察" },
          { op: "add_relation", from: "o", type: "supports", to: vid },
        ],
      },
      session,
    });
    assert.equal(ref.status, 200, JSON.stringify(ref.body));

    // worker 的操作目录里没有确认类操作：试图确认 → 未知操作被拒（§8.2/§2.6）
    const confirm = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-VULN-3",
        operations: [{ op: "confirm_vulnerability", id: vid }],
      },
      session,
    });
    assert.equal(confirm.status, 400);
    assert.equal(confirm.body.code, "BAD_REQUEST");

    const db = await openRows(s.dataDir);
    const row = db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(vid);
    assert.equal(row.status, "suspected", "状态以库为准，不被提交内容提升");
    assert.equal(row.evidence_revision, 2);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── requires 边与依赖事件（§9.2） ─────────────────────────────────── */

test("requires 边的新增/撤回产生 dependency.changed 事件（§9.2）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "依赖事件" });
    const session = workerSession(p.id, "w-dep");
    const created = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-DEP-1",
        operations: [
          { op: "propose_hypothesis", local_ref: "h", statement: "下游判断" },
          { op: "report_vulnerability", local_ref: "v", category: "injection" },
          { op: "add_relation", local_ref: "rel", from: "h", type: "requires", to: "v", requires_state: "V-0001 在条件 C-01 下 confirmed 且 review=clear" },
        ],
      },
      session,
    });
    assert.equal(created.status, 200);
    const retract = await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-DEP-2",
        operations: [{ op: "retract_relation", id: created.body.ids.rel, expected_valid_from_seq: created.body.commit_seq }],
      },
      session,
    });
    assert.equal(retract.status, 200);

    const db = await openRows(s.dataDir);
    const events = db
      .prepare("SELECT * FROM outbox WHERE project_id = ? AND event_type = 'dependency.changed' ORDER BY commit_seq, event_index")
      .all(p.id);
    assert.equal(events.length, 2);
    assert.equal(JSON.parse(events[0].payload).change, "added");
    assert.equal(JSON.parse(events[1].payload).change, "retracted");
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 历史不覆盖（§11.3 追加语义；§21 阶段 A） ─────────────────────── */

test("内容相同的两次独立提交：两份记录都在，内容相同不等于同一事件（§11.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "历史不覆盖" });
    const session = workerSession(p.id, "w-hist");
    const envelope = (id) => ({
      submission_id: id,
      operations: [{ op: "append_observation", local_ref: "o", statement: "完全相同的观察内容" }],
    });
    const r1 = await call(s.base, "POST", "/sorne/submissions", { body: envelope("SUB-HIST-1"), session });
    const r2 = await call(s.base, "POST", "/sorne/submissions", { body: envelope("SUB-HIST-2"), session });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.body.ids.o, r2.body.ids.o, "两次独立提交得到两个独立编号");

    const db = await openRows(s.dataDir);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ? AND statement = ?").get(p.id, "完全相同的观察内容").c,
      2,
      "有序的采集历史分别保留，不因内容相同被去重",
    );
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 重启恢复（§13/§14.1；§20.3 场景 12 的 A1 侧） ────────────────── */

test("场景12：提交后通知前进程重启 → Outbox 待投递完整保留、回执可重放", async () => {
  const dataDir = makeTempDir("sorne-restart-");
  let boot = await bootServer(dataDir);
  try {
    const p = (await createProject(boot.base, { name: "重启演练" })).id;
    const session = issueSession({ project_id: p, actor: "w-restart", role: "worker" });
    const envelope = {
      submission_id: "SUB-RESTART-1",
      operations: [
        ASSET,
        { op: "append_observation", local_ref: "o", statement: "重启前观察" },
        { op: "propose_hypothesis", local_ref: "h", statement: "重启前假设" },
        { op: "add_relation", from: "o", type: "supports", to: "h" },
      ],
    };
    const first = await call(boot.base, "POST", "/sorne/submissions", { body: envelope, session });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.commit_seq, 2); // 1 = 项目创建

    // 模拟进程退出：停 HTTP、直接关闭受控句柄（无投递发生，事件留在 WAL 中）
    await boot.close();
    await closeStore({ dataDir });

    // 重启：同一数据根重新拉起
    boot = await bootServer(dataDir);
    const health = await call(boot.base, "GET", "/sorne/health");
    assert.equal(health.body.ok, true);
    assert.equal(health.body.outbox.pending, 5, "重启后待投递事件完整保留（资产/观察/假设/边/证据集）");

    // 幂等跨重启：同 submission_id 重放 → 原回执
    const replay = await call(boot.base, "POST", "/sorne/submissions", { body: envelope, session });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);

    // 库内核对：业务记录、回执与 Outbox 同事务保留，页序连续可扫（§14.1/§14.3）
    const check = await openDatabase({ file: join(dataDir, "state", "sorne.sqlite") });
    try {
      const sub = check.db.prepare("SELECT * FROM submissions WHERE id = ?").get("SUB-RESTART-1");
      assert.equal(sub.status, "committed");
      assert.equal(sub.commit_seq, 2);
      const rows = check.db
        .prepare("SELECT commit_seq, event_index, delivery_status FROM outbox WHERE project_id = ? ORDER BY commit_seq, event_index")
        .all(p);
      assert.equal(rows.length, 5);
      assert.deepEqual(rows.map((r) => r.event_index), [1, 2, 3, 4, 5]);
      assert.ok(rows.every((r) => r.commit_seq === 2 && r.delivery_status === "pending"));
    } finally {
      check.close();
    }
  } finally {
    await boot.close();
    await closeStore({ dataDir });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── health 扩展（蓝图 §3 A1：db/schema/outbox 检查） ─────────────── */

test("health：扩展 db/schema/outbox 检查并反映积压", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, { name: "健康检查" });
    await call(s.base, "POST", "/sorne/submissions", {
      body: {
        submission_id: "SUB-HLT-1",
        operations: [{ op: "append_observation", local_ref: "o", statement: "x" }],
      },
      session: workerSession(p.id),
    });
    const res = await call(s.base, "GET", "/sorne/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.service, "sorne");
    assert.equal(res.body.db.ok, true);
    assert.ok(res.body.db.schema_version >= 7); // 0001 核心 + … + 0007 主动阅读
    assert.ok(res.body.outbox.pending >= 1, "提交产生的事件应计入待投递");
    assert.ok(res.body.outbox.total >= res.body.outbox.pending);
    assert.equal(res.body.projects, 1);
    await closeStore({ dataDir: s.dataDir });
  }));
