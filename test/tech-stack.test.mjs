/**
 * 分层技术栈画像测试（lib/store/tech-stack.mjs + 投影/资产目录接入）。
 *
 * 背景：技术栈原先按「每条指纹一条资产」平铺，用户会看到多个并列的「通达OA」。
 * 现状：资产记录仍是唯一事实，读时归并为「产品 → 版本 → 证据」三层树；本测试锁定：
 *   - 归一化：产品/版本/入口/模板/版本未知从自由文本中拆出，同一产品合并；
 *   - 展示树：4 个产品 / 5 个版本节点 / 10 条原始条目（同产品合并 6 条）；
 *   - AI 供给面：asset_map / planner_view / recon 都能读到同一棵树；
 *   - 资产目录：技术栈不再按站点平铺重复条目。
 *
 * 真实注入：真实端点 + 真实 SQLite + 临时数据目录（无 mock 存储）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { buildTechStack, normalizeTechAsset, renderTechStackLines } from "../lib/store/tech-stack.mjs";

const BASE_ROWS = [
  ["A-0002", "product", "通达OA"],
  ["A-0003", "product", "nginx"],
  ["A-0004", "technology", "PHP"],
  ["A-0005", "technology", "通达OA (Tongda2000 MYOA) Web 登录入口"],
  ["A-0006", "technology", "nginx（版本未披露）"],
  ["A-0007", "product", "通达OA (Tongda MYOA) 2015版模板"],
  ["A-0008", "product", "通达OA 版本未知"],
  ["A-0009", "product", "nginx 版本未知"],
  ["A-0010", "product", "PHP 版本未知"],
  ["A-0011", "product", "jQuery 3.x 版本未知"],
].map(([id, asset_type, canonical_key], index) => ({
  id,
  asset_type,
  canonical_key,
  original_input: `O-${String(index + 1).padStart(4, "0")}`,
  scope_status: "pending",
  created_seq: index + 1,
}));

test("归一化：产品/版本/入口/模板/版本未知从自由文本拆出，且不产生第二套产品名", () => {
  const rows = BASE_ROWS.map((r) => normalizeTechAsset(r));
  const byId = new Map(rows.map((r) => [r.asset_id, r]));

  assert.equal(byId.get("A-0002").product, "通达OA");
  assert.equal(byId.get("A-0002").unknown_version, true, "未写版本 = 版本未知（显式标注，不猜测）");

  // 入口是描述，不是产品名
  assert.equal(byId.get("A-0005").product, "通达OA");
  assert.equal(byId.get("A-0005").descriptor, "Web 登录入口");
  assert.deepEqual(byId.get("A-0005").aliases, ["Tongda2000 MYOA"]);

  // 2015 版模板：版本 2015 + 描述「模板」，别名保留
  assert.equal(byId.get("A-0007").product, "通达OA");
  assert.equal(byId.get("A-0007").version, "2015");
  assert.equal(byId.get("A-0007").unknown_version, false);
  assert.deepEqual(byId.get("A-0007").aliases, ["Tongda MYOA"]);

  // 版本未披露 / 版本未知都是未知版本，不是新版本
  assert.equal(byId.get("A-0006").product, "nginx");
  assert.equal(byId.get("A-0006").unknown_version, true);
  assert.equal(byId.get("A-0009").product, "nginx");
  assert.equal(byId.get("A-0009").unknown_version, true);

  // jQuery 3.x：版本号保留，版本未知标记不覆盖已识别版本
  assert.equal(byId.get("A-0011").product, "jQuery");
  assert.equal(byId.get("A-0011").version, "3.x");
  assert.equal(byId.get("A-0011").unknown_version, false);

  // 显式「产品@版本」约定（新写入规范）
  const at = normalizeTechAsset({ id: "A-0200", asset_type: "product", canonical_key: "通达OA@2015", created_seq: 20 });
  assert.equal(at.product, "通达OA");
  assert.equal(at.version, "2015");
  const atUnknown = normalizeTechAsset({ id: "A-0201", asset_type: "product", canonical_key: "nginx@unknown", created_seq: 21 });
  assert.equal(atUnknown.product, "nginx");
  assert.equal(atUnknown.unknown_version, true);
});

test("展示树：10 条指纹归并为 4 个产品 / 5 个版本节点 / 同产品合并 6 条；版本未知显式", () => {
  const tree = buildTechStack(BASE_ROWS);
  assert.deepEqual(tree.summary, {
    products: 4,
    version_nodes: 5,
    raw_assets: 10,
    merged_rows: 6,
    unknown_version_nodes: 3,
    truncated_products: 0,
  });
  assert.equal(tree.products.length, 4);
  const tongda = tree.products.find((p) => p.product === "通达OA");
  assert.ok(tongda);
  assert.deepEqual(tongda.aliases, ["Tongda2000 MYOA", "Tongda MYOA"]);
  assert.equal(tongda.primary_asset_id, "A-0002");
  assert.deepEqual(tongda.versions.map((v) => v.label), ["版本 2015", "版本未知"]);
  assert.deepEqual(tongda.versions[0].asset_ids, ["A-0007"]);
  assert.deepEqual(tongda.versions[1].asset_ids, ["A-0002", "A-0005", "A-0008"]);

  const nginx = tree.products.find((p) => p.product === "nginx");
  assert.equal(nginx.versions.length, 1);
  assert.equal(nginx.versions[0].unknown_version, true);
  assert.deepEqual(nginx.versions[0].asset_ids, ["A-0003", "A-0006", "A-0009"]);

  const jquery = tree.products.find((p) => p.product === "jQuery");
  assert.deepEqual(jquery.versions.map((v) => v.label), ["版本 3.x"]);

  // 线索文本（给模型/文档的摘要节点）：产品 + 版本 + 资产编号，不铺开全部字段
  const lines = renderTechStackLines(tree, { maxChars: 2000 });
  assert.match(lines, /产品 4 · 版本节点 5 · 原始条目 10/);
  assert.match(lines, /- 通达OA（别名：Tongda2000 MYOA、Tongda MYOA）/);
  assert.match(lines, /版本 2015（1）：A-0007/);
  assert.match(lines, /版本未知（3）：A-0002、A-0005、A-0008/);
});

test("归一化的边界：大小写合并、非技术资产忽略、上限显式标记", () => {
  const tree = buildTechStack([
    { id: "A-1", asset_type: "product", canonical_key: "NGINX", created_seq: 1 },
    { id: "A-2", asset_type: "product", canonical_key: "nginx", created_seq: 2 },
    { id: "A-3", asset_type: "service", canonical_key: "https://example.test/", created_seq: 3 },
  ]);
  assert.equal(tree.summary.products, 1);
  assert.equal(tree.summary.raw_assets, 2, "非 product/technology 资产不计入技术栈");
  assert.deepEqual(tree.products[0].asset_ids, ["A-1", "A-2"]);

  const limited = buildTechStack([
    { id: "A-1", asset_type: "product", canonical_key: "P1", created_seq: 1 },
    { id: "A-2", asset_type: "product", canonical_key: "P2", created_seq: 2 },
    { id: "A-3", asset_type: "product", canonical_key: "P3", created_seq: 3 },
  ], { productLimit: 2 });
  assert.equal(limited.products.length, 2);
  assert.equal(limited.summary.truncated_products, 1, "超出上限显式标记，不静默截断");
});

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-tech-stack`, role });
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

test("真实服务：asset_map / planner_view / asset-tree 都输出同一棵分层技术栈树（产品→版本→证据）", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const created = await call(base, "POST", "/sorne/projects", { body: { name: "技术栈画像" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const project = created.body.project;
    const worker = session(project.id, "worker");

    const operations = BASE_ROWS.map((row, index) => ({
      op: "register_asset",
      local_ref: "a" + index,
      asset_type: row.asset_type,
      canonicalization_version: "v1",
      canonical_key: row.canonical_key,
      original_input: row.original_input,
    }));
    const submitted = await call(base, "POST", "/sorne/submissions", {
      session: worker,
      body: { submission_id: "SUB-tech-stack", operations },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body).slice(0, 400));

    // 1) asset_map 快照：分层树 + Markdown 摘要
    const snap = await call(base, "GET", `/sorne/snapshots/asset-map?project_id=${project.id}`);
    assert.equal(snap.status, 200, JSON.stringify(snap.body).slice(0, 300));
    const envelope = snap.body.snapshot ?? snap.body;
    const tech = envelope.content.tech_stack;
    assert.ok(tech, "asset_map 内容应含 tech_stack");
    assert.equal(tech.summary.products, 4);
    assert.equal(tech.summary.version_nodes, 5);
    assert.equal(tech.summary.raw_assets, 10);
    assert.equal(tech.summary.merged_rows, 6);
    const tongda = tech.products.find((p) => p.product === "通达OA");
    assert.ok(tongda, "应有通达OA 产品节点");
    assert.deepEqual(tongda.versions.map((v) => v.label), ["版本 2015", "版本未知"]);
    assert.equal(tongda.versions[0].items[0].id, "A-0007");
    assert.ok(tongda.versions[0].items[0].original_input.startsWith("O-"), "叶节点保留证据来源");
    assert.match(envelope.markdown, /技术栈画像（产品 → 版本 → 证据）/);

    // 2) planner_view：AI 供给面同一棵树（不是扁平的 10 条重复产品）
    const planner = await call(base, "GET", `/sorne/snapshots/planner_view?project_id=${project.id}`);
    assert.equal(planner.status, 200, JSON.stringify(planner.body).slice(0, 300));
    const plannerTech = (planner.body.snapshot ?? planner.body).content.asset_skeleton.tech_stack;
    assert.equal(plannerTech.summary.products, 4);
    assert.equal(plannerTech.summary.raw_assets, 10);

    // 3) 资产目录：技术栈跨站点返回，不再按站点平铺
    const tree = await call(base, "GET", `/sorne/projects/${project.id}/asset-tree`);
    assert.equal(tree.status, 200, JSON.stringify(tree.body).slice(0, 300));
    assert.equal(tree.body.tech_stack.summary.products, 4);
    assert.ok(Array.isArray(tree.body.sites));
    for (const site of tree.body.sites) {
      assert.equal("tech" in site, false, "技术栈不再作为站点下的平铺数组");
    }

    // 4) recon 摘要（Planner/Orchestrator 开场）也能读到分层画像
    const recon = await import("../lib/agents/recon.mjs");
    const summary = await recon.buildReconSummary({ dataDir: s.dataDir, logger: { info() {}, warn() {} } }, project.id);
    assert.ok(summary.tech_stack, "recon 摘要应含 tech_stack");
    assert.equal(summary.tech_stack.summary.products, 4);
    assert.match(summary.tech_stack.lines, /通达OA/);
  });
});
