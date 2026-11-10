/**
 * B2 —— 变化页与订阅测试（规范 §11.2 §14.2 §14.3 §15.2 §15.5）。
 *
 * 覆盖蓝图 §7 中 B2 主责场景：
 *   - #14 消费者重复收到事件 → 不重复产生相同调度效果；
 *   - #16 新资产通过新边关联旧任务 → 动态订阅将变化交给相关任务；
 * 以及 §12 场景 12 的 B2 配合面（重启后经变化页补投递）。
 *
 * 真实注入（§20.3 末段）：重启故障用真实「关库关服→同目录重启→重签会话」注入；
 * 事务原子性用真实 SQLite TRIGGER RAISE(ABORT) 在回执写入点注入失败；不使用 mock
 * 替代事务与恢复语义。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer），
 * 不留后台进程、不触碰 ~/.sorne。
 *
 * 注：A1 的 id_sequences 首个分配值为 2（allocateSeq 返回初始 next_val），因此
 * 新项目的首个资产编号是 A-0002；本文件一律从提交回执动态取正式编号，不硬编码。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { apply } from "../index.js";
import { issueSession, revokeSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import {
  getSubscriptionView,
  openSubscriptionBoundary,
  readChangesPage,
} from "../lib/store/changes.mjs";
import { makeTempDir, withTestServer } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有工具（helpers.request 不支持会话头，helpers 为冻结文件） ── */

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

async function createProject(base, name = "B2 测试项目") {
  const res = await call(base, "POST", "/sorne/projects", { body: { name } });
  assert.equal(res.status, 200, `创建项目失败：${JSON.stringify(res.body)}`);
  return res.body.project;
}

function workerSession(projectId, actor = "w1") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}
function orchestratorSession(projectId, actor = "orch-1") {
  return issueSession({ project_id: projectId, actor, role: "orchestrator" });
}

async function submit(base, session, submissionId, operations) {
  const res = await call(base, "POST", "/sorne/submissions", {
    body: { submission_id: submissionId, operations },
    session,
  });
  assert.equal(res.status, 200, `提交失败：${JSON.stringify(res.body)}`);
  return res.body;
}

function registerAssetOp(localRef, canonicalKey, extra = {}) {
  return {
    op: "register_asset",
    local_ref: localRef,
    asset_type: "domain",
    canonicalization_version: "v1",
    canonical_key: canonicalKey,
    ...extra,
  };
}

/** 直接读取库内行（与服务器同一受控句柄）。 */
async function openRows(dataDir) {
  const store = await getStore({ dataDir });
  return store.db;
}

async function createSubscription(base, session, body) {
  const res = await call(base, "POST", "/sorne/subscriptions", { body, session });
  assert.equal(res.status, 200, `建立订阅失败：${JSON.stringify(res.body)}`);
  return res.body.subscription;
}

async function page(base, session, subscriptionId, { after, limit } = {}) {
  const params = new URLSearchParams({ subscription: subscriptionId });
  if (after !== undefined) params.set("after", after);
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await call(base, "GET", `/sorne/changes?${params.toString()}`, { session });
  return res;
}

/* ── 1. 订阅建立与变化页基础形状（§14.3） ─────────────────────────── */

test("订阅建立返回边界四元组；变化页返回 events/next_cursor/high_watermark/has_more（§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-BASE-1", [registerAssetOp("a1", "old.test")]);
    const oldAsset = r1.ids.a1;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [oldAsset] } });
    assert.match(sub.id, /^SUBS-\d+$/);
    assert.equal(sub.subscription_revision, 1);
    assert.match(sub.resume_cursor, new RegExp(`^c:${sub.id}:1:\\d+:0$`));
    assert.equal(sub.snapshot_commit_seq, 2); // 已消耗提交序号 1(建项目)、2(首提交)
    assert.equal(sub.watch.seeds, 1);
    assert.equal(sub.focus._sorne_state, undefined); // 内部状态不外泄

    await submit(s.base, w, "S-BASE-2", [registerAssetOp("a1", "old.test")]); // 同身份再发现 → 流内事件
    const res = await page(s.base, orch, sub.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subscription_id, sub.id);
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].event_type, "asset.discovered");
    assert.deepEqual(res.body.events[0].subject_ids, [oldAsset]);
    assert.equal(res.body.has_more, false);
    assert.deepEqual(res.body.high_watermark, { commit_seq: 3, event_index: 1 });
    assert.match(res.body.next_cursor, new RegExp(`^c:${sub.id}:1:3:1$`));
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 2. 过滤流与 next_cursor 覆盖已扫描区间（§14.3） ──────────────── */

test("过滤流跳过无关事件但 next_cursor 覆盖已扫描区间，不丢失后续相关事件（§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-F-1", [registerAssetOp("a1", "watched.test")]);
    const watched = r1.ids.a1;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [watched] } });

    await submit(s.base, w, "S-F-2", [registerAssetOp("a2", "other.test")]); // 未关注
    await submit(s.base, w, "S-F-3", [
      { op: "append_observation", local_ref: "o", statement: "与订阅无关的观察" },
    ]); // subject=观察编号，未关注

    const p1 = await page(s.base, orch, sub.id);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.events.length, 0);
    assert.equal(p1.body.scanned.examined, 2);
    assert.equal(p1.body.scanned.filtered_irrelevant, 2);
    assert.equal(p1.body.has_more, false);
    // 游标覆盖已扫描区间：越过两条无关事件推进到 (4,1)
    assert.match(p1.body.next_cursor, new RegExp(`^c:${sub.id}:1:4:1$`));

    // 区间之后对已关注节点的新事件不丢失
    await submit(s.base, w, "S-F-4", [registerAssetOp("a1", "watched.test")]);
    const p2 = await page(s.base, orch, sub.id, { after: p1.body.next_cursor });
    assert.equal(p2.body.events.length, 1);
    assert.deepEqual(p2.body.events[0].subject_ids, [watched]);
    assert.equal(p2.body.scanned.examined, 1);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 3. 页上限与溢出重扫：不越过未投递的匹配事件推进（§14.3） ────── */

test("页上限截断时游标停在第 limit 个匹配事件，溢出匹配下一页补齐，无丢失无重复（§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-L-1", [registerAssetOp("a1", "one.test")]);
    const r2 = await submit(s.base, w, "S-L-2", [registerAssetOp("a2", "two.test")]);
    const r3 = await submit(s.base, w, "S-L-3", [registerAssetOp("a3", "three.test")]);

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, {
      focus: { subject_ids: [r1.ids.a1, r2.ids.a2, r3.ids.a3] },
    });
    await submit(s.base, w, "S-L-4", [registerAssetOp("a1", "one.test")]);
    await submit(s.base, w, "S-L-5", [registerAssetOp("a2", "two.test")]);
    await submit(s.base, w, "S-L-6", [registerAssetOp("a3", "three.test")]);

    const seen = [];
    let after;
    for (let i = 0; i < 4; i += 1) {
      const res = await page(s.base, orch, sub.id, { after, limit: 1 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      if (i === 0) assert.equal(res.body.scanned.overflow_deferred, 2);
      for (const ev of res.body.events) seen.push(`${ev.commit_seq}:${ev.event_index}`);
      after = res.body.next_cursor;
      if (!res.body.has_more) break;
    }
    assert.deepEqual(seen, ["5:1", "6:1", "7:1"]); // 每页一条，溢出重扫补齐，无重复
    const db = await openRows(s.dataDir);
    const deliveredRows = db
      .prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = ?")
      .get("orch-1").c;
    assert.equal(deliveredRows, 3);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 4. delivered ≠ applied 分存（§14.2/§14.3） ───────────────────── */

test("delivered 与 applied 分存：页投递只写 delivered，确认后升级 applied 且不再重投（§14.2/§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-D-1", [registerAssetOp("a1", "dual.test")]);
    const watched = r1.ids.a1;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [watched] } });
    await submit(s.base, w, "S-D-2", [registerAssetOp("a1", "dual.test")]);

    const p1 = await page(s.base, orch, sub.id);
    const ev = p1.body.events[0];
    assert.equal(ev.redelivered, false);
    let db = await openRows(s.dataDir);
    let receipt = db
      .prepare("SELECT * FROM consumer_receipts WHERE consumer_id = 'orch-1' AND event_id = ?")
      .get(ev.event_id);
    assert.equal(receipt.receipt_kind, "delivered"); // 仅投递确认

    // 未确认处理前重读 → 至少一次重投递，回执不重复（§14.2）
    const p1b = await page(s.base, orch, sub.id);
    assert.equal(p1b.body.events[0].event_id, ev.event_id);
    assert.equal(p1b.body.events[0].redelivered, true);
    receipt = db
      .prepare("SELECT * FROM consumer_receipts WHERE consumer_id = 'orch-1' AND event_id = ?")
      .get(ev.event_id);
    assert.equal(receipt.receipt_kind, "delivered");
    const attempts = db
      .prepare("SELECT delivery_attempts AS n FROM outbox WHERE event_id = ?")
      .get(ev.event_id).n;
    assert.equal(attempts, 2); // 重试可观测（§20.2 Outbox 重试）

    const ack = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, boundary: p1.body.next_cursor },
      session: orch,
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.receipt_kind, "applied");
    assert.deepEqual(ack.body.covered_event_ids, [ev.event_id]);
    assert.equal(ack.body.applied_now, 1);
    assert.equal(ack.body.already_applied, 0);
    receipt = db
      .prepare("SELECT * FROM consumer_receipts WHERE consumer_id = 'orch-1' AND event_id = ?")
      .get(ev.event_id);
    assert.equal(receipt.receipt_kind, "applied"); // 业务处理确认升级

    // 已 applied 不再重投；从快照边界重读时被 applied 过滤（跨重启同样生效）
    const p2 = await page(s.base, orch, sub.id, { after: sub.resume_cursor });
    assert.equal(p2.body.events.length, 0);
    assert.equal(p2.body.scanned.already_applied, 1);

    // 重复确认幂等：不重复产生回执行、不回退游标
    const ack2 = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, boundary: p1.body.next_cursor },
      session: orch,
    });
    assert.equal(ack2.status, 200);
    assert.equal(ack2.body.already_applied, 1);
    assert.equal(ack2.body.applied_now, 0);
    db = await openRows(s.dataDir);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = 'orch-1' AND event_id = ?")
      .get(ev.event_id).c;
    assert.equal(rows, 1);
    const subRow = db.prepare("SELECT last_cursor FROM subscriptions WHERE id = ?").get(sub.id);
    assert.equal(subRow.last_cursor, p1.body.next_cursor);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 5. §20.3 场景 14：消费者重复收到事件不重复产生效果 ───────────── */

test("场景14：消费者重复收到事件 → 回执去重、效果幂等、两消费者游标独立（§20.3 #14）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-ID-1", [registerAssetOp("a1", "idem.test")]);
    const watched = r1.ids.a1;

    const orch = orchestratorSession(p.id, "orch-A");
    const rt = issueSession({ project_id: p.id, actor: "rt-B", role: "runtime" });
    const subA = await createSubscription(s.base, orch, { focus: { subject_ids: [watched] } });
    const subB = await createSubscription(s.base, rt, { focus: { subject_ids: [watched] } });
    await submit(s.base, w, "S-ID-2", [registerAssetOp("a1", "idem.test")]);

    const pa1 = await page(s.base, orch, subA.id);
    const pa2 = await page(s.base, orch, subA.id); // 重复拉取（网络重试语义）
    assert.deepEqual(
      pa1.body.events.map((e) => e.event_id),
      pa2.body.events.map((e) => e.event_id),
    );

    const ackA = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: subA.id, boundary: pa1.body.next_cursor },
      session: orch,
    });
    assert.equal(ackA.status, 200);
    const ackA2 = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: subA.id, boundary: pa1.body.next_cursor },
      session: orch,
    });
    assert.equal(ackA2.body.applied_now, 0); // 重复确认不重复产生效果

    const db = await openRows(s.dataDir);
    // 消费者 A：单事件单回执行
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = 'orch-A'").get().c,
      1,
    );
    // 消费者 B 独立：A 的确认不影响 B 的游标与回执（§14.3 每消费者独立游标）
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = 'rt-B' AND receipt_kind = 'applied'")
        .get().c,
      0,
    );
    const subBRow = db
      .prepare("SELECT last_cursor, subscription_revision FROM subscriptions WHERE id = ?")
      .get(subB.id);
    assert.notEqual(subBRow.last_cursor, pa1.body.next_cursor); // B 尚未确认，游标未推进

    const pb = await page(s.base, rt, subB.id);
    assert.equal(pb.body.events.length, 1); // B 仍能收到事件（未被 A 的消费吞掉）
    assert.equal(pb.body.events[0].redelivered, false);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 6. §20.3 场景 16：新资产通过新边关联旧任务 → 动态订阅 ────────── */

test("场景16：新资产经新边关联已关注节点 → 发现与边事件均投递，关注集随新边扩展并跨批次生效（§20.3 #16 §15.5）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-E-1", [registerAssetOp("a1", "old.test")]);
    const oldAsset = r1.ids.a1;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [oldAsset] } });

    // 新资产经 discovered_from 关联已关注节点（同一提交：发现事件在边事件之前提交）
    const r2 = await submit(s.base, w, "S-E-2", [
      registerAssetOp("a2", "new.test", { discovered_from: oldAsset }),
    ]);
    const newAsset = r2.ids.a2;

    const p1 = await page(s.base, orch, sub.id);
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const got = p1.body.events.map((e) => `${e.event_type}@${e.commit_seq}:${e.event_index}`);
    // 发现事件(在边事件之前提交)不被过滤：新资产经边进入关注子图（§15.5）
    assert.deepEqual(got, ["asset.discovered@3:1", "relation.added@3:2"]);
    const relationEvent = p1.body.events[1];
    assert.deepEqual(relationEvent.payload.endpoints, { from: newAsset, to: oldAsset }); // 新边事件含端点信息

    // 关注集已随新边扩展（无需订阅版本推进）
    const view = await call(s.base, "GET", `/sorne/subscriptions/${sub.id}`, { session: orch });
    assert.equal(view.body.subscription.watch.grown, 1);
    assert.equal(view.body.subscription.subscription_revision, 1);

    // 链式扩展跨批次生效：新资产只与上一批动态扩展入集的节点相连
    const r3 = await submit(s.base, w, "S-E-3", [
      registerAssetOp("a3", "newer.test", { discovered_from: newAsset }),
    ]);
    assert.notEqual(r3.ids.a3, newAsset);
    const p2 = await page(s.base, orch, sub.id, { after: p1.body.next_cursor });
    const got2 = p2.body.events.map((e) => `${e.event_type}@${e.commit_seq}:${e.event_index}`);
    assert.deepEqual(got2, ["asset.discovered@4:1", "relation.added@4:2"]);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 7. 强制通知（§15.5）：范围收缩/前提撤回/执行停止无视过滤 ──────── */

test("强制通知：scope.revised / dependency.changed / resource_state.changed(用户停止) 无视 event_types 过滤投递（§15.5）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-FC-1", [
      registerAssetOp("a1", "forced.test"),
      { op: "propose_hypothesis", local_ref: "h", statement: "前提假设" },
    ]);
    const watched = r1.ids.a1;
    const hypothesis = r1.ids.h;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, {
      focus: { subject_ids: [watched], event_types: ["asset.discovered"] }, // 只关注资产发现
    });
    await submit(s.base, w, "S-FC-1B", [registerAssetOp("a1", "forced.test")]); // 同身份再发现（类型内）

    // requires 边建立与撤回（dependency.changed×2）+ 范围收缩（scope.revised）+ 用户停止（resource_state.changed）
    const rel = await submit(s.base, w, "S-FC-2", [
      { op: "add_relation", local_ref: "r", from: hypothesis, type: "requires", to: watched },
    ]);
    await submit(s.base, w, "S-FC-3", [
      { op: "retract_relation", id: rel.ids.r, expected_valid_from_seq: rel.commit_seq },
    ]);
    const scope = await call(s.base, "POST", "/sorne/scope-revisions", {
      body: { project_id: p.id, rules: { allow: ["forced.test"], deny: [] }, summary: "收缩" },
    });
    assert.equal(scope.status, 200);
    const stop = await call(s.base, "POST", `/sorne/projects/${p.id}/lifecycle`, {
      body: { action: "stop" },
    });
    assert.equal(stop.status, 200);

    const res = await page(s.base, orch, sub.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const types = res.body.events.map((e) => e.event_type);
    assert.deepEqual(types, [
      "asset.discovered", // 类型过滤内的关注节点事件正常投递
      "dependency.changed", // requires 建立（§9.2；强制）
      "dependency.changed", // requires 撤回 = 前提撤回（§15.5 强制）
      "scope.revised", // 范围收缩（§15.5 强制）
      "resource_state.changed", // 用户停止（§16.4/§15.5 执行取消语义，经 A1 事件映射；强制）
    ]);
    assert.ok(!types.includes("relation.added"));
    assert.ok(!types.includes("hypothesis.proposed"));
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 8. CURSOR_EXPIRED 与重同步（§14.3） ─────────────────────────── */

test("订阅规则变化 → 旧游标 CURSOR_EXPIRED 并给出重同步要求；新边界续读无间隙（§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-X-1", [registerAssetOp("a1", "cursor.test")]);
    const watched = r1.ids.a1;

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [watched] } });
    await submit(s.base, w, "S-X-1B", [registerAssetOp("a1", "cursor.test")]);
    const p1 = await page(s.base, orch, sub.id);
    assert.equal(p1.body.events.length, 1);

    // 显式规则变化（扩大关注集）→ 订阅版本推进
    const upd = await call(s.base, "POST", "/sorne/subscriptions", {
      body: { subscription_id: sub.id, focus: { subject_ids: [watched, "A-9999"] } },
      session: orch,
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.subscription.subscription_revision, 2);

    const stale = await page(s.base, orch, sub.id, { after: p1.body.next_cursor });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "CURSOR_EXPIRED");
    assert.equal(stale.body.retryable, false);
    assert.ok(Array.isArray(stale.body.next_requirements) && stale.body.next_requirements.length > 0);
    assert.equal(stale.body.detail.current_subscription_revision, 2);

    // 重同步：以新边界的 resume_cursor 续读（跳过区间由新快照/规则语义覆盖，不默默丢弃）
    const view = await call(s.base, "GET", `/sorne/subscriptions/${sub.id}`, { session: orch });
    const resume = view.body.subscription.resume_cursor;
    assert.match(resume, new RegExp(`^c:${sub.id}:2:\\d+:0$`));
    await submit(s.base, w, "S-X-2", [registerAssetOp("a2", "cursor2.test")]); // 无关资产（不在关注集）
    await submit(s.base, w, "S-X-3", [registerAssetOp("a1", "cursor.test")]); // 关注节点再发现
    const p2 = await page(s.base, orch, sub.id, { after: resume });
    assert.equal(p2.status, 200);
    assert.equal(p2.body.subscription_revision, 2);
    assert.deepEqual(
      p2.body.events.map((e) => e.subject_ids),
      [[watched]],
    ); // 只含新边界之后的事件
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 9. 不跳过未处理事件推进（§14.3 ack 前提） ───────────────────── */

test("确认不得跳过未处理事件：越过已扫描区间或确认未投递事件均被拒绝（§14.3）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-SK-1", [registerAssetOp("a1", "skip.test")]);

    const orch = orchestratorSession(p.id);
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [r1.ids.a1] } });
    await submit(s.base, w, "S-SK-2", [registerAssetOp("a1", "skip.test")]); // 流内事件

    const db = await openRows(s.dataDir);
    const undeliveredId = db // 边界前事件：存在但从未投递给该消费者
      .prepare("SELECT event_id FROM outbox WHERE project_id = ? ORDER BY commit_seq, event_index LIMIT 1")
      .get(p.id).event_id;

    // 未读取即确认事件集合 → 拒绝（不得跳过未处理事件，§14.3）
    const ackEvents = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, event_ids: [undeliveredId] },
      session: orch,
    });
    assert.equal(ackEvents.status, 422);
    assert.equal(ackEvents.body.code, "PRECONDITION_INVALID");
    assert.match(ackEvents.body.message, /尚未投递/);

    // 构造越界边界 token（版本正确、位置越过已扫描区间）→ 拒绝
    const ackBeyond = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, boundary: `c:${sub.id}:1:99999:1` },
      session: orch,
    });
    assert.equal(ackBeyond.status, 422);
    assert.equal(ackBeyond.body.code, "PRECONDITION_INVALID");
    assert.match(ackBeyond.body.message, /未读取的事件不能确认处理/);

    // delivered 不是合法确认种类（由服务端投递事务记录，§14.3 分存）
    const ackKind = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, receipt_kind: "delivered", boundary: sub.resume_cursor },
      session: orch,
    });
    assert.equal(ackKind.status, 400);

    // 读取后再确认 → 成功
    const p1 = await page(s.base, orch, sub.id);
    assert.equal(p1.body.events.length, 1);
    const deliveredId = p1.body.events[0].event_id;
    const ackOk = await call(s.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, event_ids: [deliveredId] },
      session: orch,
    });
    assert.equal(ackOk.status, 200, JSON.stringify(ackOk.body));
    assert.deepEqual(ackOk.body.covered_event_ids, [deliveredId]);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 10. openSubscriptionBoundary（§15.2 + §2.7 冻结签名） ────────── */

test("openSubscriptionBoundary：一致读视图内建立/更新边界，快照边界之后重放无间隙无重复（§15.2 §2.7）", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base);
    const w = workerSession(p.id);
    const r1 = await submit(s.base, w, "S-B-1", [registerAssetOp("a1", "boundary.test")]); // 边界前事件
    const watched = r1.ids.a1;
    await submit(s.base, w, "S-B-2", [registerAssetOp("a2", "unrelated.test")]); // 边界前、与订阅无关

    const pctx = { dataDir: s.dataDir };
    const focus = { subject_ids: [watched] };
    const b1 = await openSubscriptionBoundary(pctx, { projectId: p.id, focus, scope: {} });
    // §2.7 冻结签名返回形状：恰好四个字段
    assert.deepEqual(Object.keys(b1).sort(), [
      "resume_cursor",
      "snapshot_commit_seq",
      "subscription_id",
      "subscription_revision",
    ]);
    assert.equal(b1.subscription_revision, 1);

    const db = await openRows(s.dataDir);
    const maxSeq = db
      .prepare("SELECT MAX(commit_seq) AS m FROM outbox WHERE project_id = ?")
      .get(p.id).m;
    assert.ok(b1.snapshot_commit_seq >= maxSeq, `边界须覆盖已提交事件（${b1.snapshot_commit_seq} >= ${maxSeq}）`);

    // 边界之后的新事件经变化页重放；边界前事件不重复出现
    await submit(s.base, w, "S-B-3", [registerAssetOp("a3", "noise.test")]); // 边界后、无关
    await submit(s.base, w, "S-B-4", [registerAssetOp("a1", "boundary.test")]); // 边界后、相关
    const view = await getSubscriptionView(pctx, {
      session: { project_id: p.id, actor: "x", role: "planner" },
      subscriptionId: b1.subscription_id,
    });
    const boundarySession = {
      project_id: p.id,
      actor: view.subscription.consumer_id,
      role: "planner",
    };
    const pg = await readChangesPage(pctx, {
      session: boundarySession,
      subscriptionId: b1.subscription_id,
      after: b1.resume_cursor,
    });
    assert.deepEqual(
      pg.events.map((e) => `${e.event_type}@${e.commit_seq}:${e.event_index}`),
      ["asset.discovered@5:1"],
    );
    assert.equal(pg.has_more, false);

    // 同 focus 再开边界 → 更新既有订阅（版本推进）；异 focus → 新订阅
    const b2 = await openSubscriptionBoundary(pctx, { projectId: p.id, focus, scope: {} });
    assert.equal(b2.subscription_id, b1.subscription_id);
    assert.equal(b2.subscription_revision, 2);
    const b3 = await openSubscriptionBoundary(pctx, {
      projectId: p.id,
      focus: { subject_ids: ["A-9998"] },
      scope: {},
    });
    assert.notEqual(b3.subscription_id, b1.subscription_id);
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 11. 重启注入：游标/回执/订阅持久，重启后补投递（§20.3 #12 配合面） ── */

test("重启注入：关库重启后订阅/游标/回执持久，已 applied 不重投、未确认重投递、新事件补投递", async () => {
  const dataDir = makeTempDir("sorne-b2-restart-");
  let server = await bootServer(dataDir);
  const issued = [];
  try {
    const p = await createProject(server.base, "重启项目");
    const w = workerSession(p.id, "w-restart");
    issued.push(w);
    const r1 = await submit(server.base, w, "S-R-1", [registerAssetOp("a1", "restart.test")]);

    const orch = orchestratorSession(p.id, "orch-r");
    issued.push(orch);
    const sub = await createSubscription(server.base, orch, { focus: { subject_ids: [r1.ids.a1] } });
    await submit(server.base, w, "S-R-2", [registerAssetOp("a1", "restart.test")]); // 流内事件
    const p1 = await page(server.base, orch, sub.id);
    assert.equal(p1.body.events.length, 1);
    const ack = await call(server.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, boundary: p1.body.next_cursor },
      session: orch,
    });
    assert.equal(ack.status, 200);
    await submit(server.base, w, "S-R-3", [registerAssetOp("a1", "restart.test")]); // 重启前新事件

    // 真实重启注入：关服 + 关库（丢弃进程内句柄与 WAL 内存态），同目录再拉起
    await server.close();
    await closeStore({ dataDir });
    server = await bootServer(dataDir);

    // 进程内会话随重启丢失（A1 载体决策）→ 运行时重签同 actor 会话
    for (const sess of issued) revokeSession(sess.session_token);
    const orch2 = orchestratorSession(p.id, "orch-r");

    const view = await call(server.base, "GET", `/sorne/subscriptions/${sub.id}`, { session: orch2 });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.subscription.subscription_revision, 1);
    assert.equal(view.body.subscription.last_cursor, p1.body.next_cursor); // 游标持久

    // 从快照边界重读：已 applied 事件被跨重启过滤，未确认的新事件补投递（不丢、不重）
    const p2 = await page(server.base, orch2, sub.id, { after: view.body.subscription.resume_cursor });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p2.body.scanned.already_applied, 1);
    assert.equal(p2.body.events.length, 1);
    assert.equal(p2.body.events[0].commit_seq, 4);
    assert.equal(p2.body.events[0].redelivered, false);

    const ack2 = await call(server.base, "POST", "/sorne/consumer-acks", {
      body: { subscription_id: sub.id, boundary: p2.body.next_cursor },
      session: orch2,
    });
    assert.equal(ack2.status, 200);
    assert.equal(ack2.body.applied_now, 1);
  } finally {
    await server.close();
    await closeStore({ dataDir }).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ── 12. 事务原子性注入：真实 SQLite TRIGGER RAISE（§2 约束 10 消费面） ── */

test("投递事务原子性：回执写入点真实注入失败 → 无 delivered 回执、outbox 状态不推进、关注集不落库", () =>
  withTestServer(async (s) => {
    const p = await createProject(s.base, "原子性项目");
    const w = workerSession(p.id, "w-atomic");
    const r1 = await submit(s.base, w, "S-AT-1", [registerAssetOp("a1", "atomic.test")]);
    const watched = r1.ids.a1;

    const orch = orchestratorSession(p.id, "orch-atomic");
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [watched] } });
    await submit(s.base, w, "S-AT-2", [
      registerAssetOp("a2", "atomic2.test", { discovered_from: watched }),
    ]); // 流内两条事件：新资产发现 + 新边

    const db = await openRows(s.dataDir);
    const before = {
      receipts: db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts").get().c,
      pending: db
        .prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND delivery_status = 'pending'")
        .get(p.id).c,
      focusRow: db.prepare("SELECT focus, last_cursor FROM subscriptions WHERE id = ?").get(sub.id),
    };

    db.exec(`CREATE TRIGGER b2_test_abort_receipt BEFORE INSERT ON consumer_receipts
      WHEN NEW.receipt_kind = 'delivered'
      BEGIN SELECT RAISE(ABORT, '注入：投递回执写入失败'); END;`);

    const failed = await page(s.base, orch, sub.id);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, "INTERNAL_ERROR");
    assert.match(failed.body.message, /注入/);

    // 半状态不存在：回执、outbox 投递状态、动态扩展、扫描区间全部回滚
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts").get().c, before.receipts);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND delivery_status = 'pending'")
        .get(p.id).c,
      before.pending,
    );
    const after = db.prepare("SELECT focus, last_cursor FROM subscriptions WHERE id = ?").get(sub.id);
    assert.equal(after.focus, before.focusRow.focus); // 扫描区间/动态扩展未落库（整体回滚）
    assert.equal(after.last_cursor, before.focusRow.last_cursor);

    db.exec("DROP TRIGGER b2_test_abort_receipt;");
    const ok = await page(s.base, orch, sub.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.events.length, 2);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = 'orch-atomic'").get().c,
      2,
    );
    await closeStore({ dataDir: s.dataDir });
  }));

/* ── 13. 权限与访问控制（§11.2；蓝图 §8.2） ──────────────────────── */

test("权限：无会话/user 角色/跨项目/非消费者 actor 拒绝；#19 只读视图项目内可读；参数校验", () =>
  withTestServer(async (s) => {
    const p1 = await createProject(s.base, "权限项目一");
    const p2 = await createProject(s.base, "权限项目二");
    const w = workerSession(p1.id);
    const r1 = await submit(s.base, w, "S-AC-1", [registerAssetOp("a1", "acl.test")]);

    const orch = orchestratorSession(p1.id, "orch-own");
    const sub = await createSubscription(s.base, orch, { focus: { subject_ids: [r1.ids.a1] } });

    assert.equal((await page(s.base, null, sub.id)).status, 403); // 无会话
    const userSess = issueSession({ project_id: p1.id, actor: "ui", role: "user" });
    assert.equal((await page(s.base, userSess, sub.id)).status, 403); // user 非消费者角色
    const foreign = issueSession({ project_id: p2.id, actor: "orch-2", role: "orchestrator" });
    const foreignRes = await page(s.base, foreign, sub.id);
    assert.equal(foreignRes.status, 403); // 跨项目
    assert.match(foreignRes.body.message, /不一致/);
    const sameProjectOtherActor = orchestratorSession(p1.id, "orch-other");
    assert.equal((await page(s.base, sameProjectOtherActor, sub.id)).status, 403); // 非消费者本人

    // #19 只读视图：项目内任意角色可读（含 user）；跨项目拒绝；未知订阅 404
    assert.equal((await call(s.base, "GET", `/sorne/subscriptions/${sub.id}`, { session: userSess })).status, 200);
    assert.equal((await call(s.base, "GET", `/sorne/subscriptions/${sub.id}`, { session: foreign })).status, 403);
    assert.equal((await call(s.base, "GET", "/sorne/subscriptions/SUBS-9999", { session: orch })).status, 404);

    // 参数与游标校验
    const badLimit = await page(s.base, orch, sub.id, { limit: "abc" });
    assert.equal(badLimit.status, 400);
    const badCursor = await page(s.base, orch, sub.id, { after: "not-a-cursor" });
    assert.equal(badCursor.status, 400);
    const otherSubCursor = await page(s.base, orch, sub.id, { after: `c:SUBS-9999:1:1:1` });
    assert.equal(otherSubCursor.status, 400);
    const noSub = await call(s.base, "GET", "/sorne/changes", { session: orch });
    assert.equal(noSub.status, 400);
    const crossProjectCreate = await call(s.base, "POST", "/sorne/subscriptions", {
      body: { project_id: p2.id, focus: {} },
      session: orch,
    });
    assert.equal(crossProjectCreate.status, 403); // 不得跨项目建订阅
    await closeStore({ dataDir: s.dataDir });
  }));
