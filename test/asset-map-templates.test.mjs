/**
 * M2 —— asset_map 接口模板维度测试（蓝图 §d-10 / §1.5 资产页「接口」块）。
 *
 * 覆盖：
 *   - 经 D2 `propose_endpoint_template` 操作造模板（dedup.mjs:875 注册的操作；
 *     §7.2 模板是可修正判断）；
 *   - asset_map 快照含 endpoint_templates 分组（candidate/confirmed 分列、
 *     split/withdrawn 折叠计数、展开入口，沿 §15.1 快照纪律）；
 *   - 折叠/展开入口与样本上限（不静默截断）；
 *   - 不改动既有折叠/边界语义（test/projection.test.mjs 回归网保持绿）。
 *
 * 真实注入：真实端点 + 真实 SQLite；并行安全（mkdtemp + 随机端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-tmpl`, role });
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

/** 造服务资产 + HTTP 资源样本，再 propose_endpoint_template（D2 去重路径）。 */
const seedTemplate = async (base, projectId, key, { status, pathPrefix = "users" } = {}) => {
  if (!seedTemplate.samples) seedTemplate.samples = new Map();
  const w = session(projectId, "worker");
  const reg = await call(base, "POST", "/sorne/submissions", {
    session: w,
    body: {
      submission_id: `tmpl-reg-${key}`,
      operations: [{ op: "register_service_asset", local_ref: "svc", url: `https://${key}.example.test/` }],
    },
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const serviceId = reg.body.ids.svc;
  const resIds = [];
  for (let i = 0; i < 2; i += 1) {
    // 数字路径样本折叠出同一模板（§7.2 数字折叠 → /api/users/{id} 形态）
    const r = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: `tmpl-res-${key}-${i}`,
        operations: [{ op: "register_http_resource", local_ref: "res", url: `https://${key}.example.test/api/${pathPrefix}/${1000 + i}` }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    resIds.push(r.body.ids.res);
  }
  const propose = await call(base, "POST", "/sorne/submissions", {
    session: w,
    body: {
      submission_id: `tmpl-propose-${key}`,
      operations: [{
        op: "propose_endpoint_template",
        local_ref: "t",
        service_asset_id: serviceId,
        method: "GET",
        resource_ids: resIds,
      }],
    },
  });
  assert.equal(propose.status, 200, JSON.stringify(propose.body));
  const templateId = propose.body.ids.t;
  seedTemplate.samples.set(templateId, resIds);
  if (status && status !== "candidate") {
    const revise = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: `tmpl-revise-${key}`,
        operations: [{ op: "revise_endpoint_template", template_id: templateId, action: "confirm", reason: "M2 测试确认", expected_state_version: 1 }],
      },
    });
    assert.equal(revise.status, 200, JSON.stringify(revise.body));
  }
  return templateId;
};

test("asset_map 快照含 endpoint_templates 分组：candidate/confirmed 分列、折叠计数与展开入口", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "模板维度" } })).body.project;
    const candidateId = await seedTemplate(base, p.id, "tmpl-a", { pathPrefix: "users" });
    const confirmedId = await seedTemplate(base, p.id, "tmpl-b", { status: "confirmed", pathPrefix: "orders" });

    const snap = await call(base, "GET", `/sorne/snapshots/asset-map?project_id=${p.id}`);
    assert.equal(snap.status, 200, JSON.stringify(snap.body).slice(0, 200));
    const envelope = snap.body.snapshot ?? snap.body;
    const templates = envelope.content?.endpoint_templates;
    assert.ok(templates, "asset_map 快照应含 endpoint_templates 维度");
    assert.equal(templates.total, 2);
    assert.equal(templates.by_status.candidate.total, 1);
    assert.equal(templates.by_status.confirmed.total, 1);
    assert.equal(templates.by_status.candidate.items[0].id, candidateId);
    assert.equal(templates.by_status.confirmed.items[0].id, confirmedId);
    assert.match(templates.by_status.candidate.items[0].path_template, /\{n\}/, "数字折叠模板（dedup 词表 {n}）");
    assert.ok("method" in templates.by_status.candidate.items[0] && "service_asset_id" in templates.by_status.candidate.items[0]);
    assert.match(templates.expand.how, /\/sorne\/records\//, "展开入口给出编号读取路径");
    assert.match(templates.note, /候选接口族|§7\.2/, "模板可信状态语义标注（可确认/拆分/撤回）");

    // split/withdrawn 折叠计数（折叠不删记录）
    const w = session(p.id, "worker");
    const split = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "tmpl-split",
        operations: [{
          op: "revise_endpoint_template",
          template_id: candidateId,
          action: "split",
          reason: "M2 测试拆分",
          expected_state_version: 1,
          // §7.2 拆分即修正折叠：新模板路径与被拆模板不同（同路径会撞唯一约束——
          // 拆分的业务语义是「数字折叠错了，重挂为另一形态」）
          split_targets: [{ resource_ids: seedTemplate.samples.get(candidateId) ?? [], path_template: "/api/users/{id}" }],
        }],
      },
    });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    const snap2 = await call(base, "GET", `/sorne/snapshots/asset-map?project_id=${p.id}`);
    const templates2 = (snap2.body.snapshot ?? snap2.body).content.endpoint_templates;
    // 拆分后：被拆模板移出 candidate（折叠为计数），拆分目标成为新 candidate（§7.2 误折叠可拆分）
    assert.equal(templates2.folded.split, 1, "被拆模板折叠为计数");
    assert.equal(templates2.by_status.candidate.total, 1, "拆分目标成为新 candidate");
    assert.equal(templates2.by_status.candidate.items[0].path_template, "/api/users/{id}");
    assert.match(templates2.folded.note, /折叠不删记录/);

    // Markdown 渲染不因新维度崩坏（快照文件/视图照常生成）
    assert.ok(envelope.markdown.includes("资产组") || envelope.markdown.length > 0);
  });
});
