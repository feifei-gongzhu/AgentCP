/**
 * 骨架冒烟测试（起步即绿；施工期只增不删）。
 *
 * 覆盖：
 *   1. 插件入口形状与路由注册；
 *   2. 真实 HTTP：health 实装、信任边界（回环 + 同源 Origin）、
 *      404、501 桩、UI manifest/页面静态路由；
 *   3. 存储底座：临时库迁移到 schema_version=1，核心表与 §6.3 索引存在；
 *   4. client.js 无头冒烟：模块注册、settings.section 注入、外壳可渲染；
 *   5. 全部 UI 页面模块形状合法且可渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { name, inject, apply, __test__ } from "../index.js";
import { listMigrations, openDatabase } from "../lib/db.mjs";
import { createDispatcher } from "../lib/router.mjs";
import { readRawBody } from "../lib/http.mjs";
import { makeTempDir, withTestServer } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "lib", "ui", "pages");

/* ── 1. 插件入口形状 ──────────────────────────────────────────────── */

test("插件入口：name=sorne，inject=[webServer]，apply 为函数", () => {
  assert.equal(name, "sorne");
  assert.deepEqual(inject, ["webServer"]);
  assert.equal(typeof apply, "function");
});

test("apply 在 mock ctx 上注册 /sorne 前缀路由", () => {
  const registered = [];
  apply({
    webServer: { register: (o) => (registered.push(o), () => {}) },
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => fn(),
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, "/sorne");
});

/* ── 2. 真实 HTTP（随机端口 + 临时数据目录） ──────────────────────── */

test("GET /sorne/health 实装可用", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("GET", "/sorne/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "sorne");
    assert.ok(typeof body.version === "string" && body.version.length > 0);
  }));

test("未实装端点桩返回 501 NOT_IMPLEMENTED 并标注负责模块（44 端点已全实装，桩机制经工厂直测）", async () => {
  // A1–F2 已实装蓝图 §5 全部 44 端点，路由面不再存在 501 桩可指
  // （A1→B2→C1→D1→E2→F2→F1 的指向链在 F1 落地后终止）。
  // 本用例语义保持「未施工端点桩返回 501 信封并标注负责模块」，
  // 改经 lib/stub.mjs 桩工厂直测（路由装载语义由其余用例覆盖）。
  const { stub } = await import("../lib/stub.mjs");
  const s = stub("F1", "GET", "/sorne/example", "§example 示例");
  await assert.rejects(
    () => s.handler(),
    (err) => {
      assert.equal(err.code, "NOT_IMPLEMENTED");
      assert.equal(err.status, 501);
      assert.equal(err.extra.module, "F1");
      assert.equal(err.extra.endpoint, "GET /sorne/example");
      assert.equal(err.extra.spec, "§example 示例");
      return true;
    },
  );
});

test("回环同源请求通过信任边界到达端点本体（44 端点已全实装，以真实端点业务响应验证）", () =>
  withTestServer(async ({ request }) => {
    // 本用例语义是「信任边界放行回环同源请求到端点本体」；无 501 桩可指后，
    // 以用户面真实端点验证：同源回环 POST 通过 Origin 检查到达 A1 处理器，
    // 由端点本体返回业务校验错误（400 BAD_REQUEST）而非边界 403。
    const { status, body } = await request("POST", "/sorne/projects", { body: {} });
    assert.equal(status, 400);
    assert.equal(body.code, "BAD_REQUEST");
  }));

test("变更请求缺少 Origin → 403 TRUST_DENIED", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("POST", "/sorne/submissions", {
      body: {}, origin: null,
    });
    assert.equal(status, 403);
    assert.equal(body.code, "TRUST_DENIED");
  }));

test("变更请求 Origin 与 Host 不同源 → 403 TRUST_DENIED", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("POST", "/sorne/submissions", {
      body: {}, origin: "http://evil.example",
    });
    assert.equal(status, 403);
    assert.equal(body.code, "TRUST_DENIED");
  }));

test("未注册路由 → 404 NOT_FOUND（JSON 信封）", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("GET", "/sorne/does-not-exist");
    assert.equal(status, 404);
    assert.equal(body.code, "NOT_FOUND");
  }));

/* ── 2b. dispatcher 单元级回归（信任顺序 / rawBody） ──────────────── */

function mockReq({ method = "GET", url = "/sorne/health", remoteAddress = "127.0.0.1", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

function mockRes() {
  const res = {
    headersSent: false,
    status: 0,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.headersSent = true;
      this.body = body ?? "";
    },
  };
  return res;
}

test("信任检查先于路由匹配：非回环连接对已知/未知路径一致返回 403（不泄露路由）", async () => {
  const dispatch = createDispatcher({
    routes: [{ method: "GET", path: "/sorne/health", async handler() { return { ok: true }; } }],
  });
  const pctx = { logger: { warn() {} } };
  const known = mockRes();
  await dispatch(pctx, mockReq({ remoteAddress: "10.0.0.9", url: "/sorne/health" }), known);
  assert.equal(known.status, 403);
  assert.equal(JSON.parse(known.body).code, "TRUST_DENIED");
  const unknown = mockRes();
  await dispatch(pctx, mockReq({ remoteAddress: "10.0.0.9", url: "/sorne/nope" }), unknown);
  assert.equal(unknown.status, 403);
  assert.equal(JSON.parse(unknown.body).code, "TRUST_DENIED");
  // 带转发头的回环连接同样拒绝
  const forwarded = mockRes();
  await dispatch(
    pctx,
    mockReq({ headers: { "x-forwarded-for": "1.2.3.4" }, url: "/sorne/health" }),
    forwarded,
  );
  assert.equal(forwarded.status, 403);
});

test("rawBody 路由：dispatcher 不预读流，超过 256KiB 的原始字节可达 handler", async () => {
  const dispatch = createDispatcher({
    routes: [
      {
        method: "POST",
        path: "/sorne/evidence/blobs",
        rawBody: true,
        async handler(pctx, req, res, m) {
          const buf = await readRawBody(req, 1024 * 1024 * 1024);
          return { len: buf.length, hasBody: m.body === undefined };
        },
      },
    ],
  });
  const req = mockReq({
    method: "POST",
    url: "/sorne/evidence/blobs",
    headers: { origin: "http://127.0.0.1:1", host: "127.0.0.1:1" },
  });
  const res = mockRes();
  const done = dispatch({ logger: { warn() {} } }, req, res);
  const payload = Buffer.alloc(300 * 1024, 0x61); // 300KiB > 256KiB JSON 上限
  // dispatcher 先 await 路由表；等监听器挂好（微任务排空）再推送流数据。
  await new Promise((r) => setImmediate(r));
  req.emit("data", payload);
  req.emit("end");
  await done;
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.len, 300 * 1024);
  assert.equal(body.hasBody, true);
});

test("GET /sorne/ui/manifest 与 lib/ui/pages 目录扫描一致（页面全集断言按 BLUEPRINT-UI §2.5② 移至终验）", () =>
  withTestServer(async ({ request }) => {
    const { status, body } = await request("GET", "/sorne/ui/manifest");
    assert.equal(status, 200);
    const diskIds = readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith(".page.mjs"))
      .map((f) => f.replace(/\.page\.mjs$/, ""))
      .sort();
    const ids = body.pages.map((p) => p.id).sort();
    assert.deepEqual(ids, diskIds, "manifest 应与页面目录一一对应（施工期页面集合随模块竣工演进）");
    const overview = body.pages.find((p) => p.id === "overview");
    if (overview) assert.equal(overview.file, "/sorne/ui/pages/overview.page.mjs");
    const changes = body.pages.find((p) => p.id === "changes");
    if (changes) assert.equal(changes.file, "/sorne/ui/pages/changes.page.mjs");
  }));

test("GET /sorne/ui/pages/{file} 提供页面模块源；非法文件名 404", () =>
  withTestServer(async ({ request }) => {
    // 页面集合随 M3–M6 重构演进（旧页逐个删除），故从 manifest 取当前存在的第一个页面，
    // 不钉死某个具体页面文件（BLUEPRINT-UI §2.5②：全集断言移至终验）。
    const manifest = await request("GET", "/sorne/ui/manifest");
    assert.equal(manifest.status, 200);
    assert.ok(Array.isArray(manifest.body.pages) && manifest.body.pages.length > 0, "manifest 至少有一个页面");
    const first = manifest.body.pages[0];
    const ok = await request("GET", first.file);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type"), /text\/javascript/);
    assert.match(ok.body.raw, /export default/);

    const bad = await request("GET", "/sorne/ui/pages/..%2F..%2Fpackage.json");
    assert.equal(bad.status, 404);
  }));

/* ── 3. 存储底座 ─────────────────────────────────────────────────── */

test("openDatabase：临时库迁移到最新 schema_version，§6.2 核心表与 §6.3 索引存在", async () => {
  const dir = makeTempDir("sorne-db-smoke-");
  const store = await openDatabase({ file: join(dir, "state", "sorne.sqlite") });
  const latestVersion = (await listMigrations()).at(-1).version;
  try {
    assert.ok(latestVersion >= 7);
    assert.equal(store.schemaVersion, latestVersion);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    // §6.2 全部逻辑表均已建（抽查关键 12 张 + 全量计数见 BLUEPRINT §4）
    for (const t of [
      "projects", "scope_revisions", "assets", "resources", "blobs", "captures",
      "observations", "hypotheses", "facts", "vulnerabilities", "relations",
      "intents", "attempts", "tool_calls", "verification_jobs",
      "verification_results", "evidence_manifests", "evidence_memberships",
      "submissions", "outbox", "consumer_receipts", "subscriptions", "snapshots",
      "checkpoints", "plan_runs", "plan_revisions", "orchestration_decisions",
      "orchestration_actions", "worker_reports", "report_receipts",
      "report_revisions", "id_sequences", "reading_node_aliases",
      "reading_branch_overrides", "reading_bookmarks", "material_read_logs",
      "extraction_batches", "extraction_items",
      "check_records", "judgement_corrections",
      "branch_summaries",
      "branch_shelving",
    ]) {
      assert.ok(tables.includes(t), `缺少表 ${t}`);
    }
    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    for (const ix of [
      "idx_relations_from", "idx_relations_to", "idx_outbox_page",
      "idx_outbox_pending", "idx_intents_dispatch", "idx_intents_resume",
      "idx_attempts_active_assignment",
    ]) {
      assert.ok(indexes.includes(ix), `缺少索引 ${ix}`);
    }
    // snapshots.kind 允许 planner_view（§15.3 Planner 视图落点）
    await store.runSerial((db) => {
      db.prepare(
        "INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
      ).run("PRJ-SMK", "冒烟项目", new Date().toISOString(), "smoke");
      db.prepare(
        `INSERT INTO snapshots (id, project_id, kind, snapshot_commit_seq, content_ref,
         schema_version, created_at, created_by, created_seq)
         VALUES (?, ?, 'planner_view', 1, 'mem://p', 1, ?, ?, 1)`,
      ).run("SNAP-P1", "PRJ-SMK", new Date().toISOString(), "smoke");
    });
    // 迁移幂等：再次 migrate 不重复应用
    assert.equal(await store.migrate(), latestVersion);
  } finally {
    store.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("资产层级迁移保留跨规范化版本的历史资产及其外键引用", async () => {
  const dir = makeTempDir();
  const file = join(dir, "sorne.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT)");
      for (const migration of (await listMigrations()).filter(({ version }) => version < 12)) {
        migration.up(legacy);
        legacy.prepare("INSERT INTO schema_version VALUES (?, '', '')").run(migration.version);
      }
      legacy.exec(`
        INSERT INTO projects (id, name, created_at, created_by)
        VALUES ('PRJ-OLD', '历史项目', '2026-01-01', 'test');
        INSERT INTO assets
          (id, project_id, asset_type, canonicalization_version, canonical_key,
           original_input, created_at, created_by, created_seq)
        VALUES ('A-OLD1', 'PRJ-OLD', 'domain', 'v1', 'example.test', 'example.test', '', 'test', 1),
               ('A-OLD2', 'PRJ-OLD', 'domain', 'v2', 'example.test', 'example.test', '', 'test', 2);
        CREATE TABLE legacy_asset_refs (asset_id TEXT REFERENCES assets(id));
        INSERT INTO legacy_asset_refs VALUES ('A-OLD2');
      `);
    } finally {
      legacy.close();
    }
    const upgraded = await openDatabase({ file });
    try {
      assert.ok(upgraded.schemaVersion >= 14);
      assert.deepEqual(upgraded.db.prepare("SELECT id FROM assets ORDER BY id").all().map(({ id }) => id), ["A-OLD1", "A-OLD2"]);
      assert.equal(upgraded.db.prepare("SELECT asset_id FROM legacy_asset_refs").get().asset_id, "A-OLD2");
      assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发 openDatabase 同一新库：单飞返回同一受控句柄，迁移只应用一次", async () => {
  const dir = makeTempDir("sorne-db-race-");
  const file = join(dir, "state", "sorne.sqlite");
  const latestVersion = (await listMigrations()).at(-1).version;
  const [a, b] = await Promise.all([openDatabase({ file }), openDatabase({ file })]);
  try {
    // 同进程内同文件共享同一句柄（单一串行写队列）；跨进程由 BEGIN IMMEDIATE
    // + 事务内版本复查兜底（lib/db.mjs）。
    assert.equal(a, b);
    assert.equal(a.schemaVersion, latestVersion);
    assert.equal(await a.migrate(), latestVersion);
  } finally {
    a.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSerial：串行短事务提交与回滚", async () => {
  const dir = makeTempDir("sorne-db-txn-");
  const store = await openDatabase({ file: join(dir, "state", "sorne.sqlite") });
  try {
    await store.runSerial((db) => {
      db.prepare(
        "INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
      ).run("PRJ-T1", "冒烟项目", new Date().toISOString(), "smoke");
    });
    const row = store.db.prepare("SELECT name FROM projects WHERE id = ?").get("PRJ-T1");
    assert.equal(row.name, "冒烟项目");

    await assert.rejects(
      () =>
        store.runSerial((db) => {
          db.prepare(
            "INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
          ).run("PRJ-T2", "回滚项目", new Date().toISOString(), "smoke");
          throw new Error("故意失败");
        }),
      /故意失败/,
    );
    const gone = store.db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id = ?").get("PRJ-T2");
    assert.equal(gone.c, 0, "回滚后不应留下半截写入");
  } finally {
    store.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4. client.js 无头冒烟（无浏览器、无 React 运行时） ───────────── */

async function loadClientModule() {
  const entryRef = { current: null };
  globalThis.window = { __ModuleLoader__: { load: (entry) => { entryRef.current = entry; } } };
  await import(pathToFileURL(join(HERE, "..", "client.js")).href);
  return entryRef.current;
}

test("client.js：注册 __ModuleLoader__ 模块并注入 settings.section，外壳可渲染", async () => {
  const entry = await loadClientModule();
  assert.ok(entry);
  assert.equal(entry.id, "sorne");

  const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
  const React = {
    createElement: h,
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect: () => {},
    Component: class { constructor(props) { this.props = props; } },
  };
  const mod = entry.factory((n) => (n === "react" ? React : {}));
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject));

  const injected = [];
  const registered = [];
  mod.apply({
    slots: {
      inject: (slot, factory) => { injected.push({ slot, dispose: factory() }); },
      register: (options) => { registered.push(options); return { options }; },
    },
  });
  assert.equal(injected.length, 1);
  assert.equal(injected[0].slot, "settings.section");
  assert.equal(injected[0].dispose.options.id, "sorne");

  // M1 外壳重写后的无头等价断言（原 WorkbenchShell 钩子已随旧外壳移除）：
  // 断言对象不变——外壳以「Sorne 持续探索工作台」注册进 settings.section，
  // 且 __test__ 暴露可渲染外壳入口（真实渲染走查归 ui-shell / npm run ui）。
  assert.equal(registered.length, 1);
  assert.equal(typeof registered[0].label, "function");
  assert.equal(registered[0].label(), "Sorne 持续探索工作台");
  const runtime = mod.__test__.createShellRuntime({ React, h });
  for (const hook of ["Shell", "SornePanel", "Topbar"]) {
    assert.equal(typeof runtime[hook], "function", `__test__ 缺少 ${hook}`);
  }
});

/* ── 5. 页面模块形状 ─────────────────────────────────────────────── */

test("全部页面模块：形状合法（id/title/order/render）且可渲染", async () => {
  const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
  const React = {
    createElement: h,
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect: () => {},
    // 页面模块（A3 起）允许以 React.Component 类组件收敛有状态部分；
    // 本用例只断言可渲染形状，不实例化组件，空类即可满足 extends。
    Component: class Component {},
    PureComponent: class PureComponent {},
  };
  const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith(".page.mjs"));
  assert.ok(files.length >= 1, "页面目录应至少有一个页面模块（页面集合随 BLUEPRINT-UI §2.5 施工演进，全集断言在终验）");
  for (const f of files) {
    const mod = await import(pathToFileURL(join(PAGES_DIR, f)).href);
    const def = mod.default;
    assert.ok(def && typeof def.id === "string", `${f} 缺 id`);
    assert.ok(typeof def.title === "string" && def.title, `${f} 缺中文标题`);
    assert.equal(typeof def.render, "function", `${f} 缺 render`);
    const tree = def.render({ React, h, api: async () => ({}) });
    assert.ok(tree && typeof tree === "object", `${f} render 未返回元素树`);
    /* 页面两种模式：A3 式静态头 + 类组件（渲染树含标题文本）；M3 起的
       类组件延迟渲染页（标题在组件实例内，本骨架宿主不实例化——标题断言
       由各模块专属测试承担，如 test/ui-onboarding.test.mjs）。 */
    const hasTitle = new RegExp(def.title).test(JSON.stringify(tree, null, 0).replace(/"type":\s*null/g, '"type":null'));
    let hasComponent = false;
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.type === "function") hasComponent = true;
      const kids = node.props && node.props.children;
      if (Array.isArray(kids)) kids.forEach(walk);
      else if (kids && typeof kids === "object") walk(kids);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    })(tree);
    assert.ok(hasTitle || hasComponent, `${f} 渲染树既不含标题也无组件元素（形状非法）`);
  }
});
