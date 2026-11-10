/**
 * B1 —— 投影与记录读取测试（规范 §15.1–§15.4 §11.2；蓝图 §7 场景 13/15）。
 *
 * 覆盖蓝图 §7 中 B1 主责场景：
 *   - 场景 13（快照生成期间出现新发现 → 快照或后续事件覆盖该发现，无间隙）：
 *     纯黑盒并发竞争：真实 HTTP 提交与快照请求并发交错，逐快照核对无间隙不变量
 *     （边界前资产全在内容中；边界后资产必有边界后事件可重放）；
 *   - 场景 15（折叠分支的前提失效 → 仍触发依赖处理）：折叠节点的 requires 边
 *     全量投影 + 撤回产生 dependency.changed 事件（边界之后可重放）。
 * 另覆盖阶段 B 完成标准：每条视图内容可追到持久记录（/records/{id} 全量回读）；
 * Map 可完全重建（同库两次生成 + 真实重启后生成 content 全等）。
 *
 * 订阅边界：一律走 B2 的 §2.7 冻结签名 openSubscriptionBoundary（真实实现）；
 * 本文件不安装任何生产代码测试钩子（终审整改：原 __installBoundaryOpenerForTests
 * 注入钩子已从 projection.mjs 移除，场景 13 改为纯黑盒并发竞争演练）。
 *
 * 并行安全：独立 mkdtemp 临时目录 + 随机端口（helpers.mjs / 本文件 bootServer），
 * 不留后台进程、不触碰 ~/.sorne。事务、重启与磁盘故障均真实注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { apply } from "../index.js";
import { issueSession } from "../lib/store/sessions.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { makeTempDir } from "./helpers.mjs";

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/* ── 本文件私有 HTTP 工具（helpers.request 不支持会话头/原始字节体） ── */

async function call(base, method, path, { body, session, rawBody } = {}) {
  const headers = { origin: base };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (rawBody !== undefined) headers["content-type"] = "application/octet-stream";
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

/** 重启演练/显式数据目录服务器：关闭时不删目录（模拟进程退出再拉起）。 */
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
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

async function withServer(dataDir, fn) {
  const s = await bootServer(dataDir);
  try {
    return await fn(s.base);
  } finally {
    await s.close();
  }
}

/* ── 种子工具 ─────────────────────────────────────────────────────── */

async function createProject(base, { name = "投影测试项目", scope_rules } = {}) {
  const { status, body } = await call(base, "POST", "/sorne/projects", {
    body: scope_rules ? { name, scope_rules } : { name },
  });
  assert.equal(status, 200, `创建项目失败：${JSON.stringify(body)}`);
  return body.project.id;
}

async function submitOps(base, session, submissionId, operations) {
  const { status, body } = await call(base, "POST", "/sorne/submissions", {
    body: { submission_id: submissionId, operations },
    session,
  });
  assert.equal(status, 200, `提交 ${submissionId} 失败：${JSON.stringify(body)}`);
  return body;
}

function workerSession(projectId, actor = "w-proj") {
  return issueSession({ project_id: projectId, actor, role: "worker" });
}

function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 上传并固定 Blob + 登记采集（经 A2 真实端点），返回 { blob, capture }。 */
async function seedCapture(base, projectId, { toolCallId, url, method = "GET", bodyText, conditionSnapshotId }) {
  const text = bodyText ?? `body-of-${toolCallId}`;
  const up = await call(base, "POST", `/sorne/evidence/blobs?project_id=${encodeURIComponent(projectId)}&representation=raw_body`, {
    rawBody: Buffer.from(text, "utf8"),
  });
  assert.equal(up.status, 200, `Blob 上传失败：${JSON.stringify(up.body)}`);
  const cap = await call(base, "POST", "/sorne/captures", {
    body: {
      project_id: projectId,
      tool_call_id: toolCallId,
      request_url_exact: url,
      method,
      response_body_blob: sha256Of(text),
      observed_at: new Date().toISOString(),
      condition_snapshot_id: conditionSnapshotId,
    },
  });
  assert.equal(cap.status, 200, `采集登记失败：${JSON.stringify(cap.body)}`);
  return { blob: up.body, capture: cap.body };
}

/** 直接种子（intents/goals/attempts/tool_calls/plan_*：对应端点属 C1/C2/E1，尚未实装）。 */
async function seedRows(dataDir, projectId, rows) {
  const store = await getStore({ dataDir });
  await store.runSerial((db) => {
    const high = db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(projectId).n - 1;
    const now = new Date().toISOString();
    for (const row of rows) {
      if (row.table === "goals") {
        db.prepare(
          "INSERT INTO goals (id, project_id, parent_goal_id, statement, status, created_at, created_by, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(row.id, projectId, row.parent ?? null, row.statement, row.status ?? "open", now, "seed", high);
      } else if (row.table === "intents") {
        db.prepare(
          `INSERT INTO intents (id, project_id, goal_id, question, rationale, kind, target_asset_ids,
             basis_refs, prerequisite_refs, scope_revision, condition_requirements, success_criteria,
             deliverables, priority, budget, resume_conditions, status, state_version, plan_revision,
             created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(
          row.id,
          projectId,
          row.goal_id ?? null,
          row.question,
          row.rationale ?? "",
          row.kind ?? "investigate",
          JSON.stringify(row.target_asset_ids ?? []),
          JSON.stringify(row.basis_refs ?? []),
          JSON.stringify(row.prerequisite_refs ?? []),
          row.scope_revision ?? null,
          JSON.stringify(row.condition_requirements ?? []),
          row.success_criteria ?? "",
          JSON.stringify(row.deliverables ?? []),
          row.priority ?? 0,
          JSON.stringify(row.budget ?? {}),
          JSON.stringify(row.resume_conditions ?? []),
          row.status ?? "proposed",
          row.plan_revision ?? null,
          now,
          "seed",
          high,
        );
      } else if (row.table === "attempts") {
        db.prepare(
          `INSERT INTO attempts (id, project_id, intent_id, assignment_id, worker_id, fencing_token,
             lease_expires_at, status, recovery_note, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          projectId,
          row.intent_id,
          row.assignment_id ?? row.id,
          row.worker_id ?? "w-seed",
          row.fencing_token ?? Math.floor(Math.random() * 1e6),
          row.lease_expires_at ?? null,
          row.status ?? "leased",
          row.recovery_note ?? "",
          now,
          "seed",
          high,
        );
      } else if (row.table === "tool_calls") {
        db.prepare(
          `INSERT INTO tool_calls (id, project_id, attempt_id, tool_name, status, error, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, projectId, row.attempt_id, row.tool_name ?? "http", row.status ?? "planned", row.error ?? "", now, "seed", high);
      } else if (row.table === "plan_runs") {
        db.prepare(
          "INSERT INTO plan_runs (id, project_id, input_boundary, status, created_at, created_by, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(row.id, projectId, String(high), row.status ?? "received", now, "seed", high);
      } else if (row.table === "plan_revisions") {
        db.prepare(
          `INSERT INTO plan_revisions (id, project_id, plan_run_id, revision, received_status, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, projectId, row.plan_run_id, row.revision ?? "1", row.received_status ?? "accepted", now, "seed", high);
      } else if (row.table === "vulnerabilities") {
        db.prepare(
          `INSERT INTO vulnerabilities (id, project_id, asset_id, location, category, status, review,
             conditions, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, projectId, row.asset_id ?? null, row.location ?? "", row.category, row.status ?? "confirmed", row.review ?? "clear", JSON.stringify(row.conditions ?? []), now, "seed", high);
      } else if (row.table === "facts") {
        db.prepare(
          `INSERT INTO facts (id, project_id, statement, status, created_at, created_by, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, projectId, row.statement, row.status ?? "verified", now, "seed", high);
      } else {
        throw new Error(`未知种子表：${row.table}`);
      }
    }
  });
}

/** 富种子项目：范围版本 + 资产/观察/假设/疑似漏洞/关系/采集/意图/尝试/工具调用。 */
async function seedRichProject(base, dataDir, { name = "富种子项目" } = {}) {
  const projectId = await createProject(base, {
    name,
    scope_rules: { allow: ["*.seed.test"], deny: [], pending: [] },
  });
  const session = workerSession(projectId);

  // 采集（真实 A2 流程）→ 观察挂采集
  const { capture } = await seedCapture(base, projectId, {
    toolCallId: "tc-seed-1",
    url: "https://api.seed.test/v1/users",
    conditionSnapshotId: "COND-UNAUTH",
  });

  const sub1 = await submitOps(base, session, "seed-1", [
    { op: "register_asset", local_ref: "svc", asset_type: "service", canonicalization_version: "v1", canonical_key: "https://api.seed.test", source_note: "JS 引用" },
    { op: "register_asset", local_ref: "host", asset_type: "host", canonicalization_version: "v1", canonical_key: "api.seed.test" },
    { op: "append_observation", local_ref: "obs", capture_id: capture.capture_id, statement: "该请求响应为 500", conditions: ["身份=未登录"] },
    { op: "propose_hypothesis", local_ref: "hyp", statement: "输入可能影响后端查询", conditions: ["身份=未登录"] },
    { op: "report_vulnerability", local_ref: "vuln", asset_id: "svc", category: "SQL注入", location: "/v1/users?debug=1", conditions: ["身份=未登录"] },
    { op: "add_relation", from: "host", type: "discovered_from", to: "svc" },
    { op: "add_relation", from: "obs", type: "supports", to: "hyp" },
    { op: "add_relation", from: "obs", type: "targets", to: "svc" },
    { op: "add_relation", from: "hyp", type: "supports", to: "vuln" },
  ]);
  const ids = sub1.ids;

  await seedRows(dataDir, projectId, [
    { table: "goals", id: "G-9001", statement: "确认 api.seed.test 的注入面" },
    {
      table: "intents",
      id: "I-9001",
      goal_id: "G-9001",
      question: "未登录条件下 /v1/users 的 debug 参数是否可注入？",
      kind: "investigate",
      target_asset_ids: [ids.svc],
      basis_refs: [ids.obs],
      condition_requirements: ["身份=未登录"],
      budget: { max_tool_calls: 20 },
      status: "running",
      priority: 5,
    },
  ]);
  // targets 边：意图 → 资产（拓扑/覆盖统计）
  await submitOps(base, session, "seed-2", [
    { op: "add_relation", from: "I-9001", type: "targets", to: ids.svc },
  ]);
  await seedRows(dataDir, projectId, [
    { table: "attempts", id: "ATT-9001", intent_id: "I-9001", status: "running", lease_expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { table: "attempts", id: "ATT-9002", intent_id: "I-9001", status: "failed", recovery_note: "网络超时，不能据此认定接口不存在" },
    { table: "tool_calls", id: "TC-9001", attempt_id: "ATT-9001", status: "unknown", tool_name: "http_probe", error: "进程中断，外部操作结果未知" },
    { table: "tool_calls", id: "TC-9002", attempt_id: "ATT-9002", status: "failed", tool_name: "http_probe", error: "ETIMEDOUT" },
  ]);

  return { projectId, session, ids: { ...ids, capture: capture.capture_id, intent: "I-9001" } };
}

/* ── §15.1/§15.2 快照合同 ─────────────────────────────────────────── */

test("快照合同（§15.1/§15.2）：§15.1 全字段 + 真实订阅边界四元组 + 持久化", async () => {
  const dir = makeTempDir("sorne-b1-contract-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const { status, body } = await call(base, "GET", `/sorne/snapshots/asset_map?project_id=${seed.projectId}`);
      assert.equal(status, 200);
      // §15.1：每份 Map 包含 snapshot_id、schema_version、snapshot_commit_seq、
      // 生成时间、投影范围、折叠/省略说明及展开入口
      for (const field of ["snapshot_id", "schema_version", "snapshot_commit_seq", "generated_at", "projection_scope", "folding_notes", "content", "markdown"]) {
        assert.ok(field in body, `快照缺少字段 ${field}`);
      }
      assert.ok(body.snapshot_id.startsWith(`SNAP-${seed.projectId}-`));
      assert.equal(body.schema_version, 1);
      // §15.2：同返 subscription_id / subscription_revision / resume_cursor
      assert.equal(body.subscription.available, true);
      assert.ok(body.subscription.subscription_id);
      assert.ok(Number.isInteger(body.subscription.subscription_revision));
      assert.ok(typeof body.subscription.resume_cursor === "string" && body.subscription.resume_cursor.length > 0);
      assert.ok(body.content_commit_seq >= body.snapshot_commit_seq);
      // 持久化：snapshots 行 + maps/ 文件（§5.2）
      const store = await getStore({ dataDir: dir });
      const row = store.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(body.snapshot_id);
      assert.ok(row, "snapshots 表缺少快照行");
      assert.equal(row.kind, "asset_map");
      assert.equal(row.snapshot_commit_seq, body.snapshot_commit_seq);
      assert.ok(existsSync(join(dir, row.content_ref)), `content 文件未落盘：${row.content_ref}`);
      assert.ok(existsSync(join(dir, "projects", seed.projectId, "maps", "asset-map.md")), "最新入口 asset-map.md 未落盘");
      assert.ok(existsSync(join(dir, "projects", seed.projectId, "maps", "snapshots", body.snapshot_id, "map.md")));
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kind 归一化与非法 kind（400）", async () => {
  const dir = makeTempDir("sorne-b1-kind-");
  try {
    await withServer(dir, async (base) => {
      const projectId = await createProject(base);
      const alias = await call(base, "GET", `/sorne/snapshots/asset-map?project_id=${projectId}`);
      assert.equal(alias.status, 200);
      assert.equal(alias.body.kind, "asset_map");
      const bad = await call(base, "GET", `/sorne/snapshots/nope?project_id=${projectId}`);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, "BAD_REQUEST");
      const missing = await call(base, "GET", "/sorne/snapshots/asset_map");
      assert.equal(missing.status, 400);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Map 可完全重建（§15.1/§21 阶段 B）：同库两次生成与真实重启后生成 content 全等", async () => {
  const dir = makeTempDir("sorne-b1-rebuild-");
  try {
    let first;
    {
      const s = await bootServer(dir);
      try {
        await seedRichProject(s.base, dir);
        const r = await call(s.base, "GET", `/sorne/snapshots/planner_view?project_id=${(await getProjectId(dir))}`);
        first = r.body.content;
      } finally {
        await s.close();
      }
    }
    // 真实重启注入：关闭受控句柄（等同进程退出），新进程内重新生成
    await closeStore({ dataDir: dir });
    {
      const s = await bootServer(dir);
      try {
        const pid = await getProjectId(dir);
        const r = await call(s.base, "GET", `/sorne/snapshots/planner_view?project_id=${pid}`);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.content, first, "重启后重建的 content 与首份不一致（Map 必须可完全重建）");
      } finally {
        await s.close();
      }
    }
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

async function getProjectId(dataDir) {
  const store = await getStore({ dataDir });
  return store.db.prepare("SELECT id FROM projects ORDER BY created_at LIMIT 1").get().id;
}

test("每条视图内容可追到持久记录：快照内全部编号经 GET /records/{id} 回读成功", async () => {
  const dir = makeTempDir("sorne-b1-trace-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const refs = new Set();
      for (const kind of ["asset_map", "exploration_map", "planner_view"]) {
        const { status, body } = await call(base, "GET", `/sorne/snapshots/${kind}?project_id=${seed.projectId}`);
        assert.equal(status, 200, kind);
        collectIds(body.content, refs, 4000);
      }
      assert.ok(refs.size >= 5, `视图内编号过少：${[...refs].join(",")}`);
      for (const id of refs) {
        if (/^(EVT-|evt-)/.test(id)) continue; // 事件编号走 /changes（B2）
        const r = await call(base, "GET", `/sorne/records/${encodeURIComponent(id)}?project_id=${seed.projectId}`);
        assert.equal(r.status, 200, `视图编号 ${id} 无法回读到持久记录`);
        assert.equal(r.body.record.id, id);
      }
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 从视图中收集形如正式编号（前缀-数字[-数字]）的字符串（深度与数量有界）。 */
function collectIds(node, out, depth) {
  if (depth <= 0 || out.size > 2000) return;
  if (typeof node === "string") {
    if (/^(?:[A-Z]{1,4}|ATT)-[A-Za-z0-9-]+\d$/.test(node)) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, out, depth - 1);
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectIds(value, out, depth - 1);
  }
}


function lateAssetIds(store, projectId, boundarySeq) {
  return store.db
    .prepare("SELECT id FROM assets WHERE project_id = ? AND created_seq > ?")
    .all(projectId, boundarySeq)
    .map((r) => r.id);
}

function lateAssetCount(store, projectId, boundarySeq) {
  return lateAssetIds(store, projectId, boundarySeq).length;
}

/* ── §20.3 场景 13：快照生成期间出现新发现，无间隙（纯黑盒并发竞争） ── */

test("场景 13（纯黑盒）：快照与提交并发竞争 → 无间隙不变量逐快照成立（边界前全在内容；边界后必有可重放事件）", async () => {
  const dir = makeTempDir("sorne-b1-sc13-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const store = await getStore({ dataDir: dir });
      const shots = [];

      /* 多轮交错：每轮 3 笔真实提交与 2 次快照请求真并发（HTTP 全链路）。
         快照内部「订阅边界事务 → 内容读视图 → 落盘」之间存在真实窗口，
         并发提交可落在窗口内/外——任何交错都必须满足无间隙不变量。 */
      for (let round = 0; round < 5; round += 1) {
        const jobs = [];
        for (let i = 0; i < 3; i += 1) {
          jobs.push(
            submitOps(base, seed.session, `sc13-${round}-${i}`, [
              { op: "register_asset", local_ref: `a${round}_${i}`, asset_type: "host", canonicalization_version: "v1", canonical_key: `sc13-${round}-${i}.seed.test` },
            ]),
          );
        }
        for (let i = 0; i < 2; i += 1) {
          jobs.push(
            call(base, "GET", `/sorne/snapshots/asset_map?project_id=${seed.projectId}`).then((r) => {
              shots.push(r);
              return r;
            }),
          );
        }
        await Promise.all(jobs);
      }
      assert.ok(shots.length >= 10, `应取得 ≥10 个并发快照（实际 ${shots.length}）`);

      for (const { status, body } of shots) {
        assert.equal(status, 200);
        /* 不变量 1：内容读视图不早于订阅边界（否则拒绝发布，§15.1/§15.2）。 */
        assert.ok(
          body.content_commit_seq >= body.snapshot_commit_seq,
          `不变量 1 破坏：内容视图（${body.content_commit_seq}）早于边界（${body.snapshot_commit_seq}）`,
        );
        /* 不变量 2：截至内容边界的全部资产都在快照内容中（快照不漏已提交发现）。 */
        const due = store.db
          .prepare("SELECT id FROM assets WHERE project_id = ? AND created_seq <= ?")
          .all(seed.projectId, body.content_commit_seq)
          .map((r) => r.id);
        const shown = new Set();
        for (const g of body.content.groups) {
          for (const a of g.assets) shown.add(a.id);
          for (const id of g.folded?.sample_ids || []) shown.add(id);
        }
        for (const id of due) {
          assert.ok(shown.has(id), `资产 ${id} 已提交至内容边界（${body.content_commit_seq}）但不在快照中（内容间隙）`);
        }
        /* 不变量 3：晚于「订阅边界」的每个资产都存在 commit_seq > 边界的
           asset.discovered 事件——客户端从 resume_cursor 重放即可覆盖，
           快照+增量不漏消息（§15.2；事件经 GET /change-log 可读）。 */
        const lateAssets = store.db
          .prepare("SELECT id FROM assets WHERE project_id = ? AND created_seq > ?")
          .all(seed.projectId, body.snapshot_commit_seq)
          .map((r) => r.id);
        for (const id of lateAssets) {
          const ev = store.db
            .prepare(
              `SELECT 1 FROM outbox WHERE project_id = ? AND event_type = 'asset.discovered'
                 AND commit_seq > ? AND subject_ids LIKE ? LIMIT 1`,
            )
            .get(seed.projectId, body.snapshot_commit_seq, `%${id}%`);
          assert.ok(ev, `资产 ${id} 晚于边界（${body.snapshot_commit_seq}）却无边界后 asset.discovered 事件（重放间隙）`);
        }
      }

      /* 竞争覆盖面（穷尽可达交错）：快照内部「订阅边界事务 → 内容读视图」之间
         没有 awaits（readView 为同步 BEGIN..COMMIT），并发提交只能落在
         ① 边界事务之前（created_seq ≤ 边界 ≤ 内容边界 → 不变量 2 覆盖）或
         ② 内容读取之后（created_seq > 内容边界 ≥ 边界 → 不变量 3 覆盖：
            事件 commit_seq > 边界，可从 resume_cursor 重放）——两类交错都被
            上面的逐快照断言真实命中并验证（无间隙由结构保证 + 断言穷尽）。
         原测试钩子（__installBoundaryOpenerForTests）注入的「边界后、内容前」
         窗口在真实实现中不可达，已随钩子一并移除（终审整改）。 */
      assert.ok(
        shots.some((s) => lateAssetCount(store, seed.projectId, s.body.snapshot_commit_seq) > 0),
        "不变量 3 从未被行使（无任何快照观测到边界后资产，竞争构造失效）",
      );

      /* 增量重放面（黑盒）：任取一个早快照的订阅边界，晚于该边界的全部
         asset.discovered 事件可经只读变化流读出（§14.3/§15.2 重放入口）。 */
      const early = shots[0].body;
      const log = await call(base, "GET", `/sorne/change-log?project_id=${seed.projectId}`);
      assert.equal(log.status, 200);
      assert.ok(Array.isArray(log.body.events), "变化流只读视图应可读");
      const replayable = new Set(
        log.body.events.filter((e) => e.commit_seq > early.snapshot_commit_seq && e.event_type === "asset.discovered")
          .flatMap((e) => e.subject_ids),
      );
      for (const id of lateAssetIds(store, seed.projectId, early.snapshot_commit_seq)) {
        assert.ok(replayable.has(id), `资产 ${id} 未出现在边界之后的可重放事件中`);
      }
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── §20.3 场景 15：折叠分支的前提失效仍触发依赖处理 ───────────────── */

test("场景 15：折叠节点的 requires 前提全量投影；撤回产生边界后 dependency.changed，依赖处理不被折叠隐藏", async () => {
  const dir = makeTempDir("sorne-b1-fold-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const store = await getStore({ dataDir: dir });

      // 老分支：意图以某资产为前提（requires 边较早建立，之后该资产无新活动）
      await submitOps(base, seed.session, "fold-1", [
        { op: "add_relation", from: "I-9001", type: "requires", to: seed.ids.svc, requires_state: "scope_status=allowed", conditions: "执行前提" },
      ]);
      const edgeRow = store.db
        .prepare("SELECT * FROM relations WHERE project_id = ? AND relation_type = 'requires' AND to_id = ?")
        .get(seed.projectId, seed.ids.svc);
      assert.ok(edgeRow, "requires 边未建立");
      const highSeq = store.db.prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(seed.projectId).n - 1;

      // fold_since 越过该边提交（act < fold_since 的资产折叠）→ svc 折叠
      const snap1 = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${seed.projectId}&fold_since=${highSeq + 1}`);
      assert.equal(snap1.status, 200);
      const group = snap1.body.content.asset_skeleton.groups.find((g) =>
        g.assets.some((a) => a.id === seed.ids.svc) || (g.folded?.sample_ids || []).includes(seed.ids.svc),
      );
      assert.ok(group?.folded, "资产未被折叠");
      assert.ok(group.folded.count >= 1);
      assert.ok(group.folded.sample_ids.includes(seed.ids.svc), "折叠桶样本应含目标资产");
      assert.ok(group.folded.expand && typeof group.folded.expand.how === "string", "折叠桶缺少展开入口");
      // 折叠节点仍参与依赖检查：requires 边全量出现在 folded_dependencies
      const deps = snap1.body.content.folded_dependencies.filter((d) => d.relation_id === edgeRow.id);
      assert.equal(deps.length, 1, "折叠分支的 requires 前提边未被全量投影");
      assert.equal(deps[0].to.id, seed.ids.svc);
      assert.equal(deps[0].requires_state, "scope_status=allowed");
      assert.ok(snap1.body.folding_notes.some((n) => n.section === "folded_dependencies"));

      // 前提失效：真实撤回（A1 retract_relation → dependency.changed 同事务事件）
      await submitOps(base, seed.session, "fold-2", [
        { op: "retract_relation", id: edgeRow.id, expected_valid_from_seq: edgeRow.valid_from_seq },
      ]);
      const depEvent = store.db
        .prepare(
          `SELECT * FROM outbox WHERE project_id = ? AND commit_seq > ? AND event_type = 'dependency.changed' LIMIT 1`,
        )
        .get(seed.projectId, snap1.body.snapshot_commit_seq);
      assert.ok(depEvent, "快照边界之后没有 dependency.changed 事件（折叠分支的前提失效未进入事件流）");
      const payload = JSON.parse(depEvent.payload);
      assert.equal(payload.relation_id, edgeRow.id);

      // 新快照：撤回后生效边不再列为依赖，但撤回状态可经 /records 追溯
      const snap2 = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${seed.projectId}&fold_since=${highSeq + 1}`);
      assert.equal(snap2.status, 200);
      assert.ok(!snap2.body.content.folded_dependencies.some((d) => d.relation_id === edgeRow.id));
      const rel = await call(base, "GET", `/sorne/records/${edgeRow.id}?project_id=${seed.projectId}`);
      assert.equal(rel.status, 200);
      assert.ok(rel.body.record.retracted_at, "撤回未体现在持久记录");

      // 展开入口有效：按折叠桶给出的 unfold_fold_since 重新请求后整组展开
      const unfoldSince = group.folded.unfold_fold_since;
      const snap3 = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${seed.projectId}&fold_since=${unfoldSince}`);
      const group3 = snap3.body.content.asset_skeleton.groups.find((g) => g.asset_type === group.asset_type);
      assert.ok(group3.assets.some((a) => a.id === seed.ids.svc), "按展开入口提高 fold_since 后未见该资产");
      assert.ok(!group3.folded || !group3.folded.sample_ids.includes(seed.ids.svc));
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── §15.3 Planner 视图七要素 ─────────────────────────────────────── */

test("planner_view（§15.3）：分组骨架/活跃受阻/等待验证/确认漏洞/覆盖缺口/预算/自上次规划变化", async () => {
  const dir = makeTempDir("sorne-b1-planner-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      // 补充受阻方向、已接收计划基线与基线后事件
      await seedRows(dir, seed.projectId, [
        { table: "intents", id: "I-9002", goal_id: "G-9001", question: "登录后条件下的调用面？", status: "blocked", resume_conditions: ["获得有效账户"] },
        { table: "vulnerabilities", id: "V-9001", asset_id: seed.ids.svc, category: "越权", status: "confirmed", review: "clear" },
        { table: "plan_runs", id: "PRUN-9001", status: "received" },
        { table: "plan_revisions", id: "PR-9001", plan_run_id: "PRUN-9001", revision: "3", received_status: "accepted" },
      ]);
      const baselineHigh = (await getStore({ dataDir: dir })).db
        .prepare("SELECT next_commit_seq AS n FROM projects WHERE id = ?").get(seed.projectId).n - 1;
      await submitOps(base, seed.session, "after-plan-1", [
        { op: "append_observation", local_ref: "obs2", statement: "登录后出现新接口 /v1/admin", conditions: ["身份=登录"] },
      ]);

      const { status, body } = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${seed.projectId}`);
      assert.equal(status, 200);
      const c = body.content;
      // 1) 分组资产骨架
      assert.ok(c.asset_skeleton.groups.length >= 2, "资产未按类型分组");
      // 2) 活跃与受阻方向
      assert.ok(c.directions.active.some((i) => i.id === "I-9001"));
      assert.ok(c.directions.blocked.some((i) => i.id === "I-9002" && i.resume_conditions.length === 1));
      // 3) 等待验证线索（worker 建立的疑似漏洞 + 开放假设）
      assert.ok(c.awaiting_verification.suspected_vulnerabilities.some((v) => v.id === seed.ids.vuln));
      assert.ok(c.awaiting_verification.testing_or_open_hypotheses.some((h) => h.id === seed.ids.hyp));
      // 4) 确认漏洞（含复核状态与「不代表持续存在」提示）
      const confirmed = c.confirmed_vulnerabilities.find((v) => v.id === "V-9001");
      assert.ok(confirmed && confirmed.review === "clear");
      // 5) 覆盖缺口
      assert.ok(typeof c.coverage_gaps.unobserved_assets.count === "number");
      assert.ok(c.coverage_gaps.intents_without_attempts.ids.includes("I-9002"), "无尝试意图未列入覆盖缺口");
      // 6) 预算（程序供给用量；语义留 AI）
      const budgetRow = c.budgets.directions.find((d) => d.intent_id === "I-9001");
      assert.ok(budgetRow, "方向预算缺 I-9001");
      assert.equal(budgetRow.attempts, 2);
      assert.equal(budgetRow.tool_calls, 2);
      assert.equal(budgetRow.unknown_tool_calls, 1);
      assert.deepEqual(budgetRow.budget, { max_tool_calls: 20 });
      // 7) 自上次已接收规划以来的变化
      const ch = c.changes_since_last_plan;
      assert.equal(ch.baseline.plan_revision_id, "PR-9001");
      assert.equal(ch.since_commit_seq, baselineHigh);
      assert.ok((ch.event_counts["observation.appended"] ?? 0) >= 1, "基线后事件未计入变化");
      assert.ok(ch.recent_events.some((e) => e.event_type === "observation.appended"));
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planner_view：无已接收计划基线时自项目起点起算并显式说明", async () => {
  const dir = makeTempDir("sorne-b1-nobaseline-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const { status, body } = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${seed.projectId}`);
      assert.equal(status, 200);
      assert.equal(body.content.changes_since_last_plan.baseline, null);
      assert.equal(body.content.changes_since_last_plan.since_commit_seq, 0);
      assert.ok(body.content.changes_since_last_plan.total_events > 0);
      assert.match(body.content.changes_since_last_plan.note, /尚无已接收计划修订/);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── §15.1 exploration_map ────────────────────────────────────────── */

test("exploration_map：方向/依据/漏洞/未解决问题与关系边；超限显式省略计数", async () => {
  const dir = makeTempDir("sorne-b1-expl-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const { status, body } = await call(base, "GET", `/sorne/snapshots/exploration_map?project_id=${seed.projectId}`);
      assert.equal(status, 200);
      const c = body.content;
      const dirGroup = c.directions.find((d) => d.goal_id === "G-9001");
      assert.ok(dirGroup?.intents.some((i) => i.id === "I-9001" && i.basis_refs.includes(seed.ids.obs)), "方向未含依据编号");
      assert.ok(c.judgements.vulnerabilities.items.some((v) => v.id === seed.ids.vuln && v.review === "clear"));
      assert.ok(c.unresolved.open_hypotheses.ids.includes(seed.ids.hyp), "开放假设未列入未解决问题");
      assert.ok(c.unresolved.suspected_vulnerabilities.ids.includes(seed.ids.vuln));
      assert.ok(c.edges.some((e) => e.relation_type === "supports" && e.from === seed.ids.hyp && e.to === seed.ids.vuln));
      // 省略说明：视图不静默截断（此处未超限，omitted 为 0/undefined）
      assert.equal(c.judgements.hypotheses.omitted, 0);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── §15.4 Worker 视图（/contexts/{intentId}） ────────────────────── */

test("worker 视图（§15.4）：1–2 跳邻居 + 全部强制项；超跳数前提（requires 边与 prerequisite_refs）仍包含", async () => {
  const dir = makeTempDir("sorne-b1-worker-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const store = await getStore({ dataDir: dir });
      // farA：与意图有 requires 边（边使端点可达，但其状态仍属强制项）；
      // farB：无任何边的孤立判断，仅经意图合同的 prerequisite_refs 引用（真正超出跳数）
      const sub = await submitOps(base, seed.session, "worker-1", [
        { op: "propose_hypothesis", local_ref: "fara", statement: "前提判断 A", conditions: ["环境=预发"] },
        { op: "propose_hypothesis", local_ref: "farb", statement: "前提判断 B（无边孤立）", conditions: ["环境=预发"] },
      ]);
      const farA = sub.ids.fara;
      const farB = sub.ids.farb;
      await seedRows(dir, seed.projectId, [
        {
          table: "intents",
          id: "I-9003",
          question: "前提引用检查用意图",
          status: "proposed",
          target_asset_ids: [seed.ids.svc],
          prerequisite_refs: [farB],
        },
      ]);
      await submitOps(base, seed.session, "worker-2", [
        { op: "add_relation", from: "I-9001", type: "requires", to: farA, requires_state: "supported", conditions: "判断前提" },
      ]);

      const { status, body } = await call(base, "GET", `/sorne/contexts/I-9001?project_id=${seed.projectId}&hops=2`);
      assert.equal(status, 200);
      const v = body.worker_view;
      // 快照合同字段（context 快照）
      assert.ok(body.snapshot_id && Number.isInteger(body.snapshot_commit_seq));
      assert.equal(body.subscription.available, true);
      // 强制项 1：目标/范围/执行约束
      assert.equal(v.target_and_scope.intent.id, "I-9001");
      assert.equal(v.target_and_scope.goal.id, "G-9001");
      assert.ok(v.target_and_scope.scope.rules, "范围版本未随附");
      assert.deepEqual(v.target_and_scope.intent.budget, { max_tool_calls: 20 });
      // 强制项 2：requires 前提边全量列出，端点状态取自库
      const prereq = v.prerequisites.find((p) => p.to.id === farA);
      assert.ok(prereq, "requires 前提被省略");
      assert.equal(prereq.requires_state, "supported");
      assert.equal(prereq.to.kind, "hypotheses");
      assert.equal(prereq.to.status, "open");
      // 邻居跳数：意图/资产为 0；观察在 1–2 跳内
      const hopsById = new Map(v.neighbors.nodes.map((n) => [n.id, n.hop]));
      assert.equal(hopsById.get("I-9001"), 0);
      assert.ok(v.neighbors.nodes.some((n) => n.kind === "observations" && n.hop <= 2));
      // 超出跳数的强制前提：I-9003 的 prerequisite_refs 指向无边孤立判断 farB，
      // 任何跳数都不可能出现在邻居里，但前提状态仍必须随附（§15.4）
      const ctx3 = await call(base, "GET", `/sorne/contexts/I-9003?project_id=${seed.projectId}&hops=2`);
      assert.equal(ctx3.status, 200);
      const v3 = ctx3.body.worker_view;
      const refB = v3.prerequisite_refs.find((r) => r.id === farB);
      assert.ok(refB, "prerequisite_refs 引用的超跳数前提未随附");
      assert.equal(refB.kind, "hypotheses");
      assert.equal(refB.status, "open");
      assert.ok(!new Map(v3.neighbors.nodes.map((n) => [n.id, n.hop])).has(farB), "无边孤立节点不应进入邻居闭包");
      // 强制项 3：身份条件（观察条件 + 采集条件快照）
      assert.ok(v.identity_conditions.record_conditions.some((r) => r.id === seed.ids.obs && r.conditions.includes("身份=未登录")));
      assert.ok(v.identity_conditions.capture_condition_snapshots.some((x) => x.condition_snapshot_id === "COND-UNAUTH"));
      // 强制项 4：撤回/争议/范围变化（先真实撤回一条边）
      await submitOps(base, seed.session, "worker-3", [
        { op: "add_relation", from: "I-9001", type: "related_to", to: seed.ids.host },
      ]);
      const relatedEdge = store.db
        .prepare("SELECT * FROM relations WHERE project_id = ? AND relation_type = 'related_to' AND from_id = 'I-9001'")
        .get(seed.projectId);
      await submitOps(base, seed.session, "worker-4", [
        { op: "retract_relation", id: relatedEdge.id, expected_valid_from_seq: relatedEdge.valid_from_seq },
      ]);
      const again = await call(base, "GET", `/sorne/contexts/I-9001?project_id=${seed.projectId}&hops=2`);
      const retr = again.body.worker_view.retractions_disputes_scope_changes.retracted_relations;
      assert.ok(retr.some((e) => e.id === relatedEdge.id), "撤回未进入强制项");
      assert.ok(again.body.worker_view.retractions_disputes_scope_changes.scope_revisions.length >= 1, "范围版本历史未随附");
      // 强制项 5：尝试/失败/待解决问题/证据索引
      const af = again.body.worker_view.attempts_and_failures;
      assert.ok(af.attempts.some((a) => a.id === "ATT-9002" && a.status === "failed"));
      assert.ok(af.problem_tool_calls.some((t) => t.id === "TC-9001" && t.status === "unknown"));
      assert.ok(again.body.worker_view.unresolved_questions.some((h) => h.id === seed.ids.hyp));
      const ev = again.body.worker_view.evidence_index.find((x) => x.observation_id === seed.ids.obs);
      assert.ok(ev && ev.capture_id === seed.ids.capture && ev.response_body_blob.sha256.length === 64, "证据索引缺采集/Blob");
      assert.ok(ev.read_paths.bytes.includes("/sorne/evidence/blobs/"));
      // 默认不送原始字节
      assert.equal(again.body.worker_view.evidence_access.bytes_path_template.includes("{sha256}"), true);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker 视图超预算分层读取（§15.4）：not_provided 明示未提供项，计数与库一致，强制项不降级", async () => {
  const dir = makeTempDir("sorne-b1-budget-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      // 一条 requires 前提：验证强制项在超预算降级下保留
      await submitOps(base, seed.session, "budget-1", [
        { op: "add_relation", from: "I-9001", type: "requires", to: seed.ids.hyp, requires_state: "supported" },
      ]);
      const { status, body } = await call(
        base,
        "GET",
        `/sorne/contexts/I-9001?project_id=${seed.projectId}&max_chars=2000`,
      );
      assert.equal(status, 200);
      const v = body.worker_view;
      assert.ok(Array.isArray(v.not_provided) && v.not_provided.length > 0, "超预算时必须明示未提供内容");
      for (const n of v.not_provided) {
        assert.ok(n.section && n.withheld && n.read_via, `not_provided 条目不完整：${JSON.stringify(n)}`);
      }
      // 「未显示」≠「不存在」：被省略的证据索引计数与库内一致
      const evNote = v.not_provided.find((n) => n.section === "evidence_index");
      assert.ok(evNote, "证据索引未列入未提供清单");
      const store = await getStore({ dataDir: dir });
      const withCapture = store.db
        .prepare("SELECT COUNT(*) AS c FROM observations WHERE project_id = ? AND capture_id IS NOT NULL")
        .get(seed.projectId).c;
      assert.equal(evNote.count, withCapture, "未提供计数与库内不一致（静默截断）");
      assert.equal(v.evidence_index.length, 0);
      // 强制项不参与降级：前提与目标/范围仍在
      assert.ok(v.prerequisites.length >= 1);
      assert.equal(v.target_and_scope.intent.id, "I-9001");
      assert.ok(body.not_provided.every((n) => typeof n.note === "string"));
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker 视图：意图不存在 404；hops 越界 400", async () => {
  const dir = makeTempDir("sorne-b1-ctx404-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const nf = await call(base, "GET", `/sorne/contexts/I-NOPE?project_id=${seed.projectId}`);
      assert.equal(nf.status, 404);
      const bad = await call(base, "GET", `/sorne/contexts/I-9001?project_id=${seed.projectId}&hops=5`);
      assert.equal(bad.status, 400);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── §11.2 GET /records/{id} ──────────────────────────────────────── */

test("records：各类型编号读取 + 证据索引（观察→采集→Blob；判断→证据成员）", async () => {
  const dir = makeTempDir("sorne-b1-records-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const pid = seed.projectId;
      const asset = await call(base, "GET", `/sorne/records/${seed.ids.svc}?project_id=${pid}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.body.record.kind, "assets");
      assert.ok(asset.body.record.counts.intents_targeting >= 1);

      const obs = await call(base, "GET", `/sorne/records/${seed.ids.obs}?project_id=${pid}`);
      assert.equal(obs.status, 200);
      assert.equal(obs.body.evidence_index[0].capture_id, seed.ids.capture);
      assert.equal(obs.body.evidence_index[0].response_body_blob.sha256, sha256Of("body-of-tc-seed-1"));

      const vuln = await call(base, "GET", `/sorne/records/${seed.ids.vuln}?project_id=${pid}`);
      assert.equal(vuln.status, 200);
      // 证据集成员是直接边端点：obs supports hyp、hyp supports vuln → vuln 的成员是 hyp
      assert.ok(
        vuln.body.evidence_index.some((m) => m.member_id === seed.ids.hyp && m.stance === "supports"),
        "漏洞证据索引缺 supports 成员",
      );
      const hyp = await call(base, "GET", `/sorne/records/${seed.ids.hyp}?project_id=${pid}`);
      assert.ok(hyp.body.evidence_index.some((m) => m.member_id === seed.ids.obs), "假设证据索引缺观察成员");

      const rel = await call(base, "GET", `/sorne/records/${seed.ids.obs}?project_id=${pid}`);
      assert.ok(Array.isArray(rel.body.relations.edges) && rel.body.relations.edges.length > 0);

      for (const [path, expectKind] of [
        [`/sorne/records/I-9001?project_id=${pid}`, "intents"],
        [`/sorne/records/G-9001?project_id=${pid}`, "goals"],
        [`/sorne/records/ATT-9001?project_id=${pid}`, "attempts"],
        [`/sorne/records/${seed.ids.capture}?project_id=${pid}`, "captures"],
        [`/sorne/records/${seed.ids.hyp}?project_id=${pid}`, "hypotheses"],
      ]) {
        const r = await call(base, "GET", path);
        assert.equal(r.status, 200, path);
        assert.equal(r.body.record.kind, expectKind, path);
      }
      // 采集紧凑视图给出详情入口（分层读取）
      const cap = await call(base, "GET", `/sorne/records/${seed.ids.capture}?project_id=${pid}`);
      assert.equal(cap.body.record.detail_path, `/sorne/captures/${seed.ids.capture}`);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records：不存在/跨项目 404（不泄露存在性）；会话跨项目 403；blob 编号可读", async () => {
  const dir = makeTempDir("sorne-b1-rec404-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const other = await createProject(base, { name: "另一项目" });
      const nf = await call(base, "GET", `/sorne/records/A-9999?project_id=${seed.projectId}`);
      assert.equal(nf.status, 404);
      const cross = await call(base, "GET", `/sorne/records/${seed.ids.svc}?project_id=${other}`);
      assert.equal(cross.status, 404, "跨项目读取应 404 且不泄露存在性");
      const otherSession = issueSession({ project_id: other, actor: "w-other", role: "worker" });
      const denied = await call(base, "GET", `/sorne/records/${seed.ids.svc}?project_id=${seed.projectId}`, {
        session: otherSession,
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, "TRUST_DENIED");
      // Blob 编号（A2 的 B-PRJ-xxxx 形态）
      const store = await getStore({ dataDir: dir });
      const blobRow = store.db.prepare("SELECT * FROM blobs WHERE project_id = ? LIMIT 1").get(seed.projectId);
      const blob = await call(base, "GET", `/sorne/records/${blobRow.id}?project_id=${seed.projectId}`);
      assert.equal(blob.status, 200);
      assert.equal(blob.body.record.kind, "blobs");
      assert.ok(blob.body.record.read_path.includes(blobRow.sha256));
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 故障注入与鉴权 ───────────────────────────────────────────────── */

test("磁盘故障注入：maps 目录不可写时不发布半成品快照、不落 snapshots 行", async () => {
  const dir = makeTempDir("sorne-b1-disk-");
  try {
    await withServer(dir, async (base) => {
      const projectId = await createProject(base);
      // 真实注入：以普通文件占据项目目录路径，令 maps/ 的 mkdir 失败（ENOTDIR）
      const projDir = join(dir, "projects", projectId);
      mkdirSync(join(dir, "projects"), { recursive: true });
      writeFileSync(projDir, "占据项目目录路径的普通文件", "utf8");
      const { status, body } = await call(base, "GET", `/sorne/snapshots/asset_map?project_id=${projectId}`);
      assert.ok(status >= 500, `应失败而非伪造成功：${status}`);
      assert.equal(body.code, "INTERNAL_ERROR");
      const store = await getStore({ dataDir: dir });
      const rows = store.db.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE project_id = ?").get(projectId).c;
      assert.equal(rows, 0, "失败时不得留下快照行");
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("鉴权：无 project_id → 400；user/worker 会话均可只读；未知项目 404", async () => {
  const dir = makeTempDir("sorne-b1-auth-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const noPid = await call(base, "GET", "/sorne/snapshots/asset_map");
      assert.equal(noPid.status, 400);
      const userRead = await call(base, "GET", `/sorne/records/${seed.ids.svc}?project_id=${seed.projectId}`);
      assert.equal(userRead.status, 200);
      const workerRead = await call(
        base,
        "GET",
        `/sorne/snapshots/planner_view?project_id=${seed.projectId}`,
        { session: seed.session },
      );
      assert.equal(workerRead.status, 200);
      const nfProject = await call(base, "GET", "/sorne/snapshots/asset_map?project_id=PRJ-NOPE");
      assert.equal(nfProject.status, 404);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── B2 集成（条件执行）：默认装配真实 openSubscriptionBoundary ────── */

test("B2 集成：lib/store/changes.mjs 实装 openSubscriptionBoundary 后默认装配生效", async (t) => {
  const mod = await import("../lib/store/changes.mjs");
  if (typeof mod.openSubscriptionBoundary !== "function") {
    t.skip("B2 尚未实装 openSubscriptionBoundary（§2.7 冻结签名）；快照边界语义已由本文件的真实边界实现验证");
    return;
  }
  const dir = makeTempDir("sorne-b1-b2int-");
  try {
    await withServer(dir, async (base) => {
      const seed = await seedRichProject(base, dir);
      const { status, body } = await call(base, "GET", `/sorne/snapshots/asset_map?project_id=${seed.projectId}`);
      assert.equal(status, 200);
      assert.equal(body.subscription.available, true, "B2 已实装但默认装配未生效");
      assert.ok(body.subscription.subscription_id);
    });
  } finally {
    await closeStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});
