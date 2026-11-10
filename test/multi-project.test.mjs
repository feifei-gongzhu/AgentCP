/**
 * 跨项目编号完整性回归测试（规范 §6.1/§6.3；0004 迁移）。
 *
 * 背景（第 1 轮打磨修复的缺陷）：所有业务表 id 是全局 TEXT PRIMARY KEY，而
 * id_sequences 曾按 (project_id, kind) 取号——凡编号形如 `PREFIX-nnnn`（不内嵌
 * 项目编号）的实体（SUBS/SR/A/O/H/V/F/R/EM/ATT/TC/WR/ASM），第二个项目首写
 * 即与第一个项目撞全局主键：多项目快照/范围版本/提交/派发全部 500
 * （UNIQUE constraint failed: subscriptions.id 等）。
 *
 * 覆盖：
 *   1. 端到端：≥3 个项目各自快照（SUBS）、范围版本（SR）、worker 提交
 *      （A/O/H/V/R/EM）、派发（ATT/ASM）、汇报（WR）、工具调用（TC）全部 200，
 *      且跨项目编号互不重复；
 *   2. fencing token 的唯一域是 (project_id, fencing_token)（DDL）——各项目
 *      首 token 仍为 2（项目内单调语义不受全局化影响）；
 *   3. 0004 迁移对历史库的抬基线：按 0001→0003 手工建库并注入历史行与旧
 *      项目作用域序列后，经正常 openDatabase 路径应用 0004，`_global` 序列
 *      = max(历史已用最大号, 旧序列水位) + 1；随后新写入不与历史编号冲突。
 *
 * 并行安全：独立 mkdtemp 临时目录 + listen(0) 随机端口；不留后台进程、不触碰
 * ~/.sorne。真实注入：全部走真实 HTTP 路由与真实 SQLite（无 mock 事务）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore } from "../lib/store/record-service.mjs";
import { openDatabase } from "../lib/db.mjs";
import { makeTempDir, withTestServer } from "./helpers.mjs";

/* ── helpers.request 不支持会话头（冻结文件）；本文件自带会话版 call ── */

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

function mustOk(res, what) {
  assert.equal(
    res.status,
    200,
    `${what} 应 200，实际 ${res.status}：${JSON.stringify(res.body)}`,
  );
  assert.notEqual(res.body && res.body.code, "INTERNAL_ERROR", `${what} 不得内部错误`);
  return res.body;
}

/* ── 1. 端到端：三个项目各自全链路首写，不撞全局主键 ────────────────── */

test("跨项目编号：多项目快照/范围/提交/派发/汇报全部成功且编号全局不重复", () =>
  withTestServer(async (base) => {
    const projectIds = [];
    for (const name of ["批次甲", "批次乙", "批次丙"]) {
      const created = mustOk(
        await call(base.base, "POST", "/sorne/projects", { body: { name } }),
        `创建项目 ${name}`,
      );
      projectIds.push(created.project.id);
    }
    assert.equal(new Set(projectIds).size, 3, "项目编号应互不相同");

    const allIds = new Set();
    const note = (id, what) => {
      assert.ok(id, `${what} 应返回编号`);
      assert.ok(!allIds.has(id), `${what} 编号跨项目重复：${id}`);
      allIds.add(id);
    };

    const attemptIds = [];
    const fencingTokens = [];
    for (const projectId of projectIds) {
      /* 快照（SUBS-nnnn，经 B2 openSubscriptionBoundary） */
      for (const kind of ["asset_map", "exploration_map", "planner_view"]) {
        const snap = mustOk(
          await call(base.base, "GET", `/sorne/snapshots/${kind}?project_id=${encodeURIComponent(projectId)}`),
          `项目 ${projectId} 快照 ${kind}`,
        );
        assert.ok(snap.subscription && snap.subscription.subscription_id);
        note(snap.subscription.subscription_id, `项目 ${projectId} ${kind} 订阅`);
      }

      /* 范围版本（SR-nnnn） */
      const sr = mustOk(
        await call(base.base, "POST", "/sorne/scope-revisions", {
          body: { project_id: projectId, rules: { allow: ["*.example.test"], deny: [], pending: [] } },
        }),
        `项目 ${projectId} 范围版本`,
      );
      note(sr.scope_revision.id, `项目 ${projectId} 范围版本`);

      /* worker 提交：A/O/H/V + supports 关系（R + EM） */
      const worker = issueSession({ project_id: projectId, actor: `w-${projectId}`, role: "worker" });
      const sub = mustOk(
        await call(base.base, "POST", "/sorne/submissions", {
          body: {
            submission_id: `sub-${projectId}`,
            operations: [
              { op: "register_asset", local_ref: "a1", asset_type: "domain", canonicalization_version: "v1", canonical_key: `${projectId}.example.test` },
              { op: "append_observation", local_ref: "o1", statement: `${projectId} 的首个观察` },
              { op: "propose_hypothesis", local_ref: "h1", statement: `${projectId} 的首个假设` },
              { op: "report_vulnerability", local_ref: "v1", category: "xss", asset_id: "a1" },
              { op: "add_relation", from: "o1", type: "supports", to: "h1" },
            ],
          },
          session: worker,
        }),
        `项目 ${projectId} worker 提交`,
      );
      note(sub.ids.a1, `项目 ${projectId} 资产`);
      note(sub.ids.o1, `项目 ${projectId} 观察`);
      note(sub.ids.h1, `项目 ${projectId} 假设`);
      note(sub.ids.v1, `项目 ${projectId} 漏洞`);
      assert.ok(Array.isArray(sub.accepted_operations));
      const rel = sub.accepted_operations.find((o) => o.op === "add_relation");
      assert.ok(rel && rel.id, "add_relation 应返回关系编号");
      note(rel.id, `项目 ${projectId} 关系边`);

      /* 派发（ATT/ASM，不传 assignment_id 走自动编号）与汇报（WR） */
      const planner = issueSession({ project_id: projectId, actor: `p-${projectId}`, role: "planner" });
      const runtime = issueSession({ project_id: projectId, actor: `r-${projectId}`, role: "runtime" });
      const plan = mustOk(
        await call(base.base, "POST", "/sorne/plan-revisions", {
          body: {
            submission_id: `plan-${projectId}`,
            plan_revision: "r1",
            intents: [
              { op: "create", local_ref: "i1", question: `${projectId} 的首个意图`, kind: "investigate", rationale: "多项目回归", success_criteria: "任何可核验产出", target_asset_ids: [sub.ids.a1] },
            ],
          },
          session: planner,
        }),
        `项目 ${projectId} 计划提交`,
      );
      note(plan.ids.i1, `项目 ${projectId} 意图`);

      const dispatch = mustOk(
        await call(base.base, "POST", "/sorne/attempts", {
          body: { intent_id: plan.ids.i1, worker_id: `w-${projectId}` },
          session: runtime,
        }),
        `项目 ${projectId} 派发`,
      );
      note(dispatch.attempt.id, `项目 ${projectId} Attempt`);
      note(dispatch.assignment_id, `项目 ${projectId} 执行分配`);
      attemptIds.push(dispatch.attempt.id);
      fencingTokens.push(dispatch.fencing_token);

      const progress = mustOk(
        await call(base.base, "POST", `/sorne/attempts/${encodeURIComponent(dispatch.attempt.id)}/progress`, {
          body: { kind: "progress", note: "多项目回归汇报" },
          session: worker,
        }),
        `项目 ${projectId} 进展汇报`,
      );
      note(progress.report_id, `项目 ${projectId} worker 汇报`);

      /* 工具调用（TC-nnnn；范围已配置允许 *.example.test） */
      const tool = mustOk(
        await call(base.base, "POST", "/sorne/tool-calls", {
          body: {
            action: "register",
            attempt_id: dispatch.attempt.id,
            fencing_token: dispatch.fencing_token,
            tool_name: "http_probe",
            args: { url: `https://${projectId}.example.test/x` },
          },
          session: worker,
        }),
        `项目 ${projectId} 工具调用登记`,
      );
      note(tool.tool_call.id, `项目 ${projectId} 工具调用`);
    }

    /* fencing token 唯一域是 (project_id, fencing_token)：各项目首 token 均为 2
       （id_sequences 首分配值 2），项目内单调语义不受全局实体序列影响。 */
    assert.deepEqual(fencingTokens, [2, 2, 2], "各项目首个 fencing token 应为 2（项目作用域）");
  }));

/* ── 2. 0004 迁移：历史库抬基线后新写入不与历史编号冲突 ──────────────── */

test("迁移 0004：历史库（0001→0003）注入旧编号后，_global 序列抬到历史水位之上且续号不撞", async () => {
  const dir = makeTempDir("sorne-mig0004-");
  const file = join(dir, "state", "sorne.sqlite");
  const legacy = [
    { kind: "project", id: "PRJ-0002", seq: 3 },
    { kind: "subscription", id: "SUBS-0005", seq: 6 },
    { kind: "scope_revision", id: "SR-0004", seq: 5 },
    { kind: "asset", id: "A-0007", seq: 8 },
    { kind: "observation", id: "O-0003", seq: 4 },
    { kind: "hypothesis", id: "H-0002", seq: 3 },
    { kind: "vulnerability", id: "V-0002", seq: 3 },
    { kind: "fact", id: "F-0002", seq: 3 },
    { kind: "relation", id: "R-0009", seq: 10 },
    { kind: "membership", id: "EM-0002", seq: 3 },
    { kind: "attempt", id: "ATT-0003", seq: 4 },
    { kind: "tool_call", id: "TC-0004", seq: 5 },
    { kind: "worker_report", id: "WR-0006", seq: 7 },
    { kind: "assignment", id: "ASM-0009", seq: 10 },
  ];

  try {
    /* 手工建库到 schema v3，注入历史行与旧的项目作用域序列水位。 */
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "state"), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA journal_mode=WAL");
    raw.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL)",
    );
    for (const mod of [
      await import("../lib/db/migrations/0001-core-schema.mjs"),
      await import("../lib/db/migrations/0002-submissions-identity-domain.mjs"),
      await import("../lib/db/migrations/0003-intent-state-history.mjs"),
    ]) {
      mod.up(raw);
      raw
        .prepare("INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)")
        .run(mod.version, mod.description, new Date().toISOString());
    }
    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO projects (id, name, status, next_commit_seq, created_at, created_by, created_seq, state_version) VALUES ('PRJ-0002', '历史项目', 'active', 9, ?, 'user', 1, 1)",
    ).run(now);
    const insert = {
      intents: "INSERT INTO intents (id, project_id, question, kind, created_at, created_by, created_seq) VALUES ('I-PRJ-0002-0002', 'PRJ-0002', '历史意图', 'investigate', ?, 'legacy', 2)",
      subscriptions: "INSERT INTO subscriptions (id, project_id, consumer_id, focus, relation_rules, scope, subscription_revision, last_cursor, status, created_at, created_by, created_seq, state_version) VALUES ('SUBS-0005', 'PRJ-0002', 'legacy', '{}', '[]', '{}', 1, '', 'active', ?, 'legacy', 1, 1)",
      scope_revisions: "INSERT INTO scope_revisions (id, project_id, revision, rules, created_at, created_by, created_seq) VALUES ('SR-0004', 'PRJ-0002', '4', '{}', ?, 'legacy', 4)",
      assets: "INSERT INTO assets (id, project_id, asset_type, canonicalization_version, canonical_key, original_input, created_at, created_by, created_seq) VALUES ('A-0007', 'PRJ-0002', 'domain', 'v1', 'legacy.example.test', 'legacy.example.test', ?, 'legacy', 7)",
      observations: "INSERT INTO observations (id, project_id, statement, created_at, created_by, created_seq) VALUES ('O-0003', 'PRJ-0002', '历史观察', ?, 'legacy', 3)",
      hypotheses: "INSERT INTO hypotheses (id, project_id, statement, created_at, created_by, created_seq) VALUES ('H-0002', 'PRJ-0002', '历史假设', ?, 'legacy', 2)",
      vulnerabilities: "INSERT INTO vulnerabilities (id, project_id, category, created_at, created_by, created_seq) VALUES ('V-0002', 'PRJ-0002', 'xss', ?, 'legacy', 2)",
      facts: "INSERT INTO facts (id, project_id, statement, created_at, created_by, created_seq) VALUES ('F-0002', 'PRJ-0002', '历史事实', ?, 'legacy', 2)",
      relations: "INSERT INTO relations (id, project_id, from_id, to_id, relation_type, valid_from_seq, created_at, created_by, created_seq) VALUES ('R-0009', 'PRJ-0002', 'O-0003', 'H-0002', 'supports', 9, ?, 'legacy', 9)",
      evidence_memberships: "INSERT INTO evidence_memberships (id, project_id, subject_id, member_kind, member_id, stance, created_at, created_by, created_seq) VALUES ('EM-0002', 'PRJ-0002', 'H-0002', 'observations', 'O-0003', 'supports', ?, 'legacy', 2)",
      attempts: "INSERT INTO attempts (id, project_id, intent_id, assignment_id, worker_id, fencing_token, status, created_at, created_by, created_seq, state_version) VALUES ('ATT-0003', 'PRJ-0002', 'I-PRJ-0002-0002', 'ASM-0009', 'legacy-w', 2, 'completed', ?, 'legacy', 3, 1)",
      tool_calls: "INSERT INTO tool_calls (id, project_id, attempt_id, tool_name, status, created_at, created_by, created_seq) VALUES ('TC-0004', 'PRJ-0002', 'ATT-0003', 'http_probe', 'succeeded', ?, 'legacy', 4)",
      worker_reports: "INSERT INTO worker_reports (id, project_id, intent_id, attempt_id, kind, task_question, created_at, created_by, created_seq) VALUES ('WR-0006', 'PRJ-0002', 'I-PRJ-0002-0002', 'ATT-0003', 'progress', '历史汇报', ?, 'legacy', 6)",
    };
    for (const sql of Object.values(insert)) raw.prepare(sql).run(now);
    for (const { kind, seq } of legacy) {
      raw.prepare("INSERT INTO id_sequences (project_id, kind, next_val) VALUES ('PRJ-0002', ?, ?)").run(kind, seq);
    }
    raw.close();

    /* 正常打开路径应用 0004：_global 序列 = max(历史最大号+1, 旧序列水位, 2)。 */
    const store = await openDatabase({ file });
    assert.ok(store.schemaVersion >= 7, "应应用到 0007（阶段 2：主动阅读）");
    for (const { kind, id, seq } of legacy) {
      const used = Number(/-(\d+)$/.exec(id)[1]);
      const expected = Math.max(used + 1, seq, 2);
      const row = store.db
        .prepare("SELECT next_val AS n FROM id_sequences WHERE project_id = '_global' AND kind = ?")
        .get(kind);
      assert.equal(row.n, expected, `kind=${kind} 的 _global 序列应抬到 ${expected}`);
    }
    store.close();
    await closeStore({ dataDir: dir });

    /* 迁移后续号不与历史编号冲突：同目录起真实服务，创建新项目并首写各实体。 */
    await withTestServer(async (base) => {
      const created = mustOk(
        await call(base.base, "POST", "/sorne/projects", { body: { name: "迁移后项目" } }),
        "迁移后创建项目",
      );
      const projectId = created.project.id;
      assert.equal(projectId, "PRJ-0003", "项目序列应从历史 PRJ-0002 之上续号");

      const snap = mustOk(
        await call(base.base, "GET", `/sorne/snapshots/asset_map?project_id=${encodeURIComponent(projectId)}`),
        "迁移后快照",
      );
      assert.equal(snap.subscription.subscription_id, "SUBS-0006", "订阅序列应从历史 SUBS-0005 之上续号");

      const sr = mustOk(
        await call(base.base, "POST", "/sorne/scope-revisions", {
          body: { project_id: projectId, rules: { allow: ["*.example.test"], deny: [], pending: [] } },
        }),
        "迁移后范围版本",
      );
      assert.equal(sr.scope_revision.id, "SR-0005", "范围序列应从历史 SR-0004 之上续号");

      const worker = issueSession({ project_id: projectId, actor: "w-new", role: "worker" });
      const sub = mustOk(
        await call(base.base, "POST", "/sorne/submissions", {
          body: {
            submission_id: "sub-new-1",
            operations: [
              { op: "register_asset", local_ref: "a1", asset_type: "domain", canonicalization_version: "v1", canonical_key: "new.example.test" },
              { op: "append_observation", local_ref: "o1", statement: "迁移后观察" },
            ],
          },
          session: worker,
        }),
        "迁移后 worker 提交",
      );
      assert.equal(sub.ids.a1, "A-0008", "资产序列应从历史 A-0007 之上续号");
      assert.equal(sub.ids.o1, "O-0004", "观察序列应从历史 O-0003 之上续号");
    }, { dataDir: dir });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});
