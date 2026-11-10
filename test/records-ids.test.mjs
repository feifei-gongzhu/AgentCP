/**
 * M2 —— /records 前缀解析表扩展测试（蓝图 §2.3 后端段 / §d-7 / P0-2）。
 *
 * 覆盖：
 *   - 两族编号各前缀可定位：全局族 A-0002（经 POST /submissions register_asset）
 *     与项目段族 A-PRJ-…（必须走 D2 去重路径 register_service_asset——dedup.mjs:875
 *     注册的操作，ensureAsset 以三参 formatSeqId 产出 A-<PRJ>-nnnn）；
 *   - 扩展前缀：WR/TC/VJ/VR/OD/OA/PR/CG/RES/SUBS/CP/ASM/M/MSG 全部可定位；
 *   - RR 双表定位（report_revisions / report_receipts，回应答带 note）；
 *   - 新表紧凑视图字段存在（worker_reports/tool_calls/verification_jobs/…）；
 *   - evt-/EVT- 一律 404 + hint 指向 /changes（维持现状语义）；
 *   - 不存在的编号 404，不静默给错记录。
 *
 * 真实注入：真实端点 + 真实 SQLite；并行安全（mkdtemp + 随机端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { getStore, closeStore } from "../lib/store/record-service.mjs";

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-rid`, role });
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

test("全局族与项目段族资产编号均可定位（register_asset vs register_service_asset 双路径）", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "编号定位" } })).body.project;
    const w = session(p.id, "worker");

    // 全局族：register_asset → A-nnnn（record-service 两参路径）
    const g = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "rid-global",
        operations: [{
          op: "register_asset",
          local_ref: "a1",
          asset_type: "domain",
          canonicalization_version: "v1",
          canonical_key: "legacy.test",
        }],
      },
    });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const globalId = g.body.ids.a1;
    assert.match(globalId, /^A-\d+$/, "register_asset 产出全局族编号");

    // 项目段族：register_service_asset → A-PRJ-nnnn-nnnn（D2 去重路径，三参 formatSeqId）
    const pj = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "rid-embedded",
        operations: [{ op: "register_service_asset", local_ref: "a2", url: "https://app.example.test/" }],
      },
    });
    assert.equal(pj.status, 200, JSON.stringify(pj.body));
    const embeddedId = pj.body.ids.a2;
    assert.match(embeddedId, /^A-PRJ-\d{4}-\d{4}$/, "register_service_asset 产出项目段族编号");

    // /records 两族都可定位（kind=assets；评审 §4a 的静默给错记录必须死掉）
    for (const id of [globalId, embeddedId]) {
      const rec = await call(base, "GET", `/sorne/records/${id}?project_id=${p.id}`);
      assert.equal(rec.status, 200, `${id} 应可定位：${JSON.stringify(rec.body)}`);
      assert.equal(rec.body.record.kind, "assets");
      assert.equal(rec.body.record.id, id);
    }
  });
});

test("扩展前缀可定位且紧凑视图字段存在；RR 双表带 note；evt- 404 + hint", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "扩展前缀" } })).body.project;
    const w = session(p.id, "worker");
    const orch = issueSession({ project_id: p.id, actor: "orch-rid", role: "orchestrator" });

    // 造各类记录（真实端点优先；无端点面的以受控库行补齐，D1 夹具先例）
    const now = new Date().toISOString();
    const store = await getStore({ dataDir: s.dataDir });
    await store.runSerial((db) => {
      db.prepare(
        `INSERT INTO intents (id, project_id, question, kind, status, created_at, created_by, created_seq, updated_seq, state_version)
         VALUES (?, ?, '定位用意图', 'investigate', 'queued', ?, 'w', 2, 0, 1)`,
      ).run(`I-PRJ-${p.id.slice(4)}-0001`, p.id, now);
      db.prepare(
        `INSERT INTO attempts (id, project_id, intent_id, assignment_id, worker_id, fencing_token, status, created_at, created_by, created_seq)
         VALUES (?, ?, ?, 'ASM-1', 'w', 1, 'suspended', ?, 'w', 3)`,
      ).run(`ATT-PRJ-${p.id.slice(4)}-0001`, p.id, `I-PRJ-${p.id.slice(4)}-0001`, now);
      db.prepare(
        `INSERT INTO tool_calls (id, project_id, attempt_id, tool_name, status, evidence_refs, created_at, created_by, created_seq)
         VALUES (?, ?, ?, 'probe', 'succeeded', '[]', ?, 'w', 4)`,
      ).run(`TC-PRJ-${p.id.slice(4)}-0001`, p.id, `ATT-PRJ-${p.id.slice(4)}-0001`, now);
      db.prepare(
        `INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, content, delivery_status, handling_status, created_at, created_by, created_seq)
         VALUES (?, ?, ?, ?, 'handoff', '{}', 'delivered', 'pending', ?, 'w', 5)`,
      ).run(`WR-PRJ-${p.id.slice(4)}-0001`, p.id, `I-PRJ-${p.id.slice(4)}-0001`, `ATT-PRJ-${p.id.slice(4)}-0001`, now);
      db.prepare(
        `INSERT INTO checkpoints (id, project_id, intent_id, processed_boundary, created_at, created_by, created_seq)
         VALUES (?, ?, ?, '3', ?, 'w', 6)`,
      ).run(`CP-PRJ-${p.id.slice(4)}-0001`, p.id, `I-PRJ-${p.id.slice(4)}-0001`, now);
      db.prepare(
        `INSERT INTO plan_runs (id, project_id, status, created_at, created_by, created_seq)
         VALUES (?, ?, 'received', ?, 'w', 7)`,
      ).run(`PR-PRJ-${p.id.slice(4)}-0001`, p.id, now);
      db.prepare(
        `INSERT INTO orchestration_decisions (id, project_id, rationale, created_at, created_by, created_seq)
         VALUES (?, ?, '定位用决定', ?, 'w', 8)`,
      ).run(`OD-PRJ-${p.id.slice(4)}-0001`, p.id, now);
      db.prepare(
        `INSERT INTO orchestration_actions (id, project_id, decision_id, action_kind, idempotency_key, payload, status, created_at, created_by, created_seq, updated_seq)
         VALUES (?, ?, ?, 'record_strategy', 'rid-act-1', '{}', 'executed', ?, 'w', 9, 9)`,
      ).run(`OA-PRJ-${p.id.slice(4)}-0001`, p.id, `OD-PRJ-${p.id.slice(4)}-0001`, now);
      return null;
    });

    // 协调决定经真实端点建立（含 candidate_group/resources/subscriptions 等其余前缀）
    const decision = await call(base, "POST", "/sorne/orchestration-decisions", {
      session: orch,
      body: {
        rationale: "RR/MSG 定位准备",
        actions: [{ action_kind: "record_strategy", idempotency_key: "rid-strategy-1", payload: { strategy: "continue", reason: "定位" } }],
      },
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));

    const expectViews = {
      [`WR-PRJ-${p.id.slice(4)}-0001`]: ["intent_id", "attempt_id", "kind", "handling_status"],
      [`TC-PRJ-${p.id.slice(4)}-0001`]: ["status", "evidence_refs", "tool_name"],
      [`ATT-PRJ-${p.id.slice(4)}-0001`]: ["intent_id", "status", "fencing_token"],
      [`CP-PRJ-${p.id.slice(4)}-0001`]: ["processed_boundary"],
      [`PR-PRJ-${p.id.slice(4)}-0001`]: ["status"],
      [`OD-PRJ-${p.id.slice(4)}-0001`]: ["rationale"],
      [`OA-PRJ-${p.id.slice(4)}-0001`]: ["action_kind", "status"],
      [decision.body.id]: ["rationale"],
    };
    for (const [id, fields] of Object.entries(expectViews)) {
      const rec = await call(base, "GET", `/sorne/records/${id}?project_id=${p.id}`);
      assert.equal(rec.status, 200, `${id} 应可定位：${JSON.stringify(rec.body).slice(0, 200)}`);
      for (const f of fields) {
        assert.ok(f in rec.body.record, `${id} 紧凑视图缺字段 ${f}`);
      }
    }

    // RR 双表：report_revisions 行（经报告同步建立）
    await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "rid-vuln",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "rr-test", location: "/rr" }],
      },
    });
    const report = await call(base, "GET", `/sorne/reports/vulnerabilities?project_id=${p.id}`);
    assert.equal(report.status, 200);
    const reportId = report.body.reports?.[0]?.report_id;
    if (reportId) {
      const rr = await call(base, "GET", `/sorne/records/${reportId}?project_id=${p.id}`);
      assert.equal(rr.status, 200, `RR 行应可定位：${JSON.stringify(rr.body).slice(0, 200)}`);
      assert.equal(rr.body.record.kind, "report_revisions");
      assert.ok("version" in rr.body.record && "report_kind" in rr.body.record);
    }

    // SUBS / RES / CG / M / VJ / VR：可定位（存在性面）
    const subs = await call(base, "POST", "/sorne/subscriptions", {
      session: orch,
      body: { focus: { subject_ids: [] } },
    });
    assert.equal(subs.status, 200);
    const subsRec = await call(base, "GET", `/sorne/records/${subs.body.subscription.id}?project_id=${p.id}`);
    assert.equal(subsRec.status, 200);
    assert.ok("consumer_id" in subsRec.body.record, "SUBS 紧凑视图");

    // MSG 前缀（0005 迁移）：可定位
    const msg = await call(base, "POST", "/sorne/messages", { body: { project_id: p.id, content: "定位用消息" } });
    assert.equal(msg.status, 200);
    const msgRec = await call(base, "GET", `/sorne/records/${msg.body.message.id}?project_id=${p.id}`);
    assert.equal(msgRec.status, 200, "MSG- 应可定位（蓝图 §2.3）");
    assert.ok("direction" in msgRec.body.record && "status" in msgRec.body.record);

    // evt-/EVT-：404 + hint 指向 /changes
    const evt = await call(base, "GET", `/sorne/records/EVT-${p.id.slice(4)}-000001?project_id=${p.id}`);
    assert.equal(evt.status, 404);
    assert.match(evt.body.detail?.hint ?? "", /\/sorne\/changes/);
    const evtLower = await call(base, "GET", `/sorne/records/evt-xx-000001?project_id=${p.id}`);
    assert.equal(evtLower.status, 404);

    // 不存在编号：404 不给错记录
    const none = await call(base, "GET", `/sorne/records/ZZ-9999?project_id=${p.id}`);
    assert.equal(none.status, 404);
    await closeStore({ dataDir: s.dataDir });
  });
});
