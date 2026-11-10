/**
 * 变化流可达性测试（GET /sorne/change-log 只读视图；B2 后端回归网）。
 *
 * 背景：§15.2 快照承诺「增量从 resume_cursor 之后重放」，但工作台此前完全
 * 不可达——(a) 没有任何页面消费变化流；(b) 消费者面 GET /changes 要求程序
 * 签发会话（x-sorne-session），浏览器 UI 无签发通道（蓝图 §8.1）。
 *
 * 覆盖：
 *   - GET /sorne/change-log（user 面，无会话可读）：事件按 (commit_seq,
 *     event_index) 有序、next_cursor/high_watermark/has_more 齐备、游标续读
 *     不跳过区间、limit 可控；
 *   - 订阅锚点：subscription=SUBS-… 时从该订阅快照边界之后起读；接受快照
 *     resume_cursor（c:…）作为 after；游标与订阅不一致 → BAD_REQUEST；
 *     订阅不属于该项目 → TRUST_DENIED；缺 project_id → BAD_REQUEST；
 *   - 只读性（查看≠消费，§14.2/§14.3）：读取前后 consumer_receipts 行数、
 *     outbox.delivery_status、订阅 last_cursor 与 focus 内部状态均不变；
 *   - 页面用例（契约/事件呈现/游标加载更多/订阅边界读取/错误与未知形状/真实服务集成）
 *     已迁往 test/ui-diagnostics.test.mjs（M4 系统诊断页 #45 变化流只读视图）；
 *     本文件保留 B2 后端用例（change-log 有序/游标/订阅锚点/只读性）。
 *
 * 并行安全：fakeApi 用例不占端口；真实服务用例走 withTestServer（独立临时
 * 目录 + listen(0)），不留后台进程、不触碰 ~/.sorne。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { getStore as getStoreRecords } from "../lib/store/record-service.mjs";


/* ── 后端：GET /sorne/change-log（user 面只读视图） ─────────────────── */

test("change-log：事件有序、next_cursor/high_watermark/has_more 齐备、游标续读不跳区间", () =>
  withTestServer(async (s) => {
    const created = await s.request("POST", "/sorne/projects", { body: { name: "变化流项目" } });
    assert.equal(created.status, 200);
    const projectId = created.body.project.id;
    // 产生多笔事件：范围版本 × 6（每笔 commit_seq 单事件）
    for (let i = 1; i <= 6; i += 1) {
      const r = await s.request("POST", "/sorne/scope-revisions", {
        body: { project_id: projectId, rules: { allow: [`v${i}.example.test`] }, summary: `v${i}` },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }

    // 无会话（user 面）可读
    const page1 = await s.request("GET", `/sorne/change-log?project_id=${projectId}&limit=2`);
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    const b1 = page1.body;
    assert.equal(b1.read_only, true);
    assert.equal(b1.project_id, projectId);
    assert.equal(b1.events.length, 2);
    for (let i = 1; i < b1.events.length; i += 1) {
      const prev = b1.events[i - 1];
      const cur = b1.events[i];
      assert.ok(
        prev.commit_seq < cur.commit_seq
          || (prev.commit_seq === cur.commit_seq && prev.event_index < cur.event_index),
        "事件应按 (commit_seq, event_index) 有序",
      );
    }
    assert.match(b1.next_cursor, /^log:\d+:\d+$/);
    assert.equal(b1.has_more, true);
    assert.ok(b1.high_watermark.commit_seq >= b1.events[b1.events.length - 1].commit_seq);
    for (const ev of b1.events) {
      assert.ok(ev.event_id && ev.event_type && typeof ev.payload === "object");
    }

    // 游标续读：接续上一页末位置，不重复、不跳过
    const page2 = await s.request(
      "GET",
      `/sorne/change-log?project_id=${projectId}&limit=10&after=${encodeURIComponent(b1.next_cursor)}`,
    );
    assert.equal(page2.status, 200);
    const seen = new Set([...b1.events, ...page2.body.events].map((e) => e.event_id));
    assert.equal(seen.size, b1.events.length + page2.body.events.length, "游标续读不得重复事件");
    // 全量读取作对照：分页读完的并集应与全量一致（不跳过区间、不漏事件）
    const full = await s.request("GET", `/sorne/change-log?project_id=${projectId}&limit=100`);
    assert.equal(full.status, 200);
    assert.deepEqual(
      [...seen].sort(),
      full.body.events.map((e) => e.event_id).sort(),
      "分页游标读完的并集应等于全量事件集",
    );
    assert.equal(page2.body.has_more, false, "读到底后 has_more=false");

    // 畸形游标 → BAD_REQUEST
    const bad = await s.request("GET", `/sorne/change-log?project_id=${projectId}&after=zzz`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "BAD_REQUEST");
  }));

test("change-log：订阅锚点从快照边界之后起读；快照 resume_cursor 可直接作 after；跨项目/缺参拒绝", () =>
  withTestServer(async (s) => {
    const created = await s.request("POST", "/sorne/projects", { body: { name: "订阅锚点项目" } });
    const projectId = created.body.project.id;
    // 边界前事件
    await s.request("POST", "/sorne/scope-revisions", {
      body: { project_id: projectId, rules: { allow: ["before.example.test"] } },
    });
    // 快照建立订阅边界
    const snap = await s.request("GET", `/sorne/snapshots/asset_map?project_id=${projectId}`);
    assert.equal(snap.status, 200);
    const subId = snap.body.subscription.subscription_id;
    const resume = snap.body.subscription.resume_cursor;
    // 边界后事件
    await s.request("POST", "/sorne/scope-revisions", {
      body: { project_id: projectId, rules: { allow: ["after.example.test"] } },
    });

    // subscription 锚点：只呈现边界之后的事件
    const bySub = await s.request("GET", `/sorne/change-log?project_id=${projectId}&subscription=${subId}`);
    assert.equal(bySub.status, 200, JSON.stringify(bySub.body));
    assert.equal(bySub.body.subscription.id, subId);
    assert.ok(bySub.body.events.length >= 1, "边界之后应有事件");
    for (const ev of bySub.body.events) {
      assert.ok(
        ev.commit_seq >= bySub.body.subscription.snapshot_commit_seq,
        "订阅锚点不得呈现快照边界之前的事件（§15.2 无间隙重放）",
      );
    }
    const all = await s.request("GET", `/sorne/change-log?project_id=${projectId}`);
    assert.ok(all.body.events.length > bySub.body.events.length, "全量流应多于边界之后的增量");

    // 快照 resume_cursor（c:…）可直接作 after（与锚点等价）
    const byCursor = await s.request(
      "GET",
      `/sorne/change-log?project_id=${projectId}&after=${encodeURIComponent(resume)}`,
    );
    assert.equal(byCursor.status, 200);
    assert.deepEqual(
      byCursor.body.events.map((e) => e.event_id),
      bySub.body.events.map((e) => e.event_id),
      "resume_cursor 与订阅锚点应呈现同一增量区间",
    );

    // 游标属于其他订阅 → BAD_REQUEST；订阅不属于该项目 → TRUST_DENIED
    const other = await s.request("POST", "/sorne/projects", { body: { name: "另一项目" } });
    const otherSnap = await s.request(
      "GET", `/sorne/snapshots/asset_map?project_id=${other.body.project.id}`);
    const otherSub = otherSnap.body.subscription.subscription_id;
    const mismatch = await s.request(
      "GET",
      `/sorne/change-log?project_id=${projectId}&subscription=${subId}&after=${encodeURIComponent(`c:${otherSub}:1:1:0`)}`,
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, "BAD_REQUEST");
    const cross = await s.request(
      "GET", `/sorne/change-log?project_id=${projectId}&subscription=${otherSub}`);
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, "TRUST_DENIED");

    // 缺 project_id → BAD_REQUEST；不存在项目 → NOT_FOUND
    const noArg = await s.request("GET", "/sorne/change-log");
    assert.equal(noArg.status, 400);
    assert.equal(noArg.body.code, "BAD_REQUEST");
    const ghost = await s.request("GET", "/sorne/change-log?project_id=PRJ-9999");
    assert.equal(ghost.status, 404);
  }));

test("change-log 只读性：不写 delivered 回执、不改 outbox 投递状态与订阅游标（查看≠消费）", () =>
  withTestServer(async (s) => {
    const created = await s.request("POST", "/sorne/projects", { body: { name: "只读性项目" } });
    const projectId = created.body.project.id;
    await s.request("POST", "/sorne/scope-revisions", {
      body: { project_id: projectId, rules: { allow: ["ro.example.test"] } },
    });
    const snap = await s.request("GET", `/sorne/snapshots/asset_map?project_id=${projectId}`);
    const subId = snap.body.subscription.subscription_id;

    const store = await getStoreRecords({ dataDir: s.dataDir });
    const before = {
      receipts: store.db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts").get().c,
      sent: store.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE delivery_status = 'sent'").get().c,
      pending: store.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE delivery_status = 'pending'").get().c,
      sub: store.db.prepare("SELECT last_cursor, focus FROM subscriptions WHERE id = ?").get(subId),
    };

    for (let i = 0; i < 3; i += 1) {
      const r = await s.request("GET", `/sorne/change-log?project_id=${projectId}&subscription=${subId}`);
      assert.equal(r.status, 200);
    }

    const after = {
      receipts: store.db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts").get().c,
      sent: store.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE delivery_status = 'sent'").get().c,
      pending: store.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE delivery_status = 'pending'").get().c,
      sub: store.db.prepare("SELECT last_cursor, focus FROM subscriptions WHERE id = ?").get(subId),
    };
    assert.equal(after.receipts, before.receipts, "只读视图不得写 consumer_receipts");
    assert.equal(after.sent, before.sent, "只读视图不得推进 outbox 投递状态");
    assert.equal(after.pending, before.pending, "只读视图不得改动待发送事件");
    assert.equal(after.sub.last_cursor, before.sub.last_cursor, "只读视图不得推进订阅 last_cursor");
    assert.equal(after.sub.focus, before.sub.focus, "只读视图不得改动订阅内部状态（扫描区间/扩展集）");
  }));

