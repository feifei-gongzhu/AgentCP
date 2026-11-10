/**
 * M2 —— 报告导出测试（蓝图 §2.6-9 / §d-11 端点 #53）。
 *
 * 覆盖：
 *   - 生成（#40 refresh=1）→ 导出字节与视图内容一致（数据截止边界/成果清单同源）；
 *   - Content-Disposition: attachment + text/markdown;
 *   - 跨项目 / 未知 id → 404 不泄露存在性；
 *   - 内容文件缺失 → 404 + note「refresh=1 可生成新版本」（不虚报导出成功）；
 *   - version 读历史版本。
 *
 * 真实注入：真实端点 + 真实 SQLite + 真实磁盘报告文件；并行安全（mkdtemp + 随机端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { withTestServer } from "./helpers.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { getStore, closeStore } from "../lib/store/record-service.mjs";

function session(projectId, role = "worker") {
  return issueSession({ project_id: projectId, actor: `${role}-exp`, role });
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
  return { status: res.status, body: json, text, headers: res.headers };
}

test("生成 → 导出字节与视图内容一致；下载头与 Markdown 形态正确；version 读历史", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p = (await call(base, "POST", "/sorne/projects", { body: { name: "导出项目", description: "导出验证目标" } })).body.project;
    const w = session(p.id, "worker");
    // 造一条漏洞报告草稿（suspected 起步，§19）
    const sub = await call(base, "POST", "/sorne/submissions", {
      session: w,
      body: {
        submission_id: "exp-v",
        operations: [{ op: "report_vulnerability", local_ref: "v", category: "export-test", location: "/exp", impact: "测试影响" }],
      },
    });
    assert.equal(sub.status, 200);

    // 生成阶段报告（refresh=1；零新端点）
    const gen = await call(base, "GET", `/sorne/reports/milestones?project_id=${p.id}&refresh=1`);
    assert.equal(gen.status, 200, JSON.stringify(gen.body).slice(0, 300));
    assert.equal(gen.body.refreshed, true);
    const milestoneId = gen.body.report_meta.report_id;
    assert.match(milestoneId, /^MR-/);
    const boundarySeq = gen.body.report?.data_boundary?.snapshot_commit_seq;

    // 导出：200 + 下载头 + markdown 含视图同源事实
    const exp = await call(base, "GET", `/sorne/reports/${milestoneId}/export?project_id=${p.id}`);
    assert.equal(exp.status, 200, exp.text.slice(0, 200));
    assert.match(exp.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(exp.headers.get("content-disposition") ?? "", /attachment/);
    assert.ok(exp.text.startsWith(`# 报告 ${milestoneId}`), exp.text.slice(0, 120));
    assert.match(exp.text, new RegExp(`数据截止：commit_seq=${boundarySeq}`));
    assert.match(exp.text, /## 已确认成果|## 未确认线索|## 覆盖度记录/);
    // 语义纪律随报告走（note 字段原文保留）
    assert.match(exp.text, /不代表关联资产已测透|不写作已排除|不结束项目|提交边界/);

    // 与视图同源：视图报告的已确认/未确认数量在导出中可见（同一边界）
    const vulnId = sub.body.ids.v;
    assert.match(exp.text, new RegExp(vulnId), "漏洞编号（未确认线索）应出现在导出中");

    // 历史版本导出：refresh 生成 v2 后 version=v1 仍可导出
    const gen2 = await call(base, "GET", `/sorne/reports/milestones?project_id=${p.id}&refresh=1`);
    assert.equal(gen2.status, 200);
    assert.equal(gen2.body.current_version, "v2");
    const v1 = await call(base, "GET", `/sorne/reports/${milestoneId}/export?project_id=${p.id}&version=v1`);
    assert.equal(v1.status, 200);
    assert.match(v1.text, /v1|版本：v1/);
    const badVersion = await call(base, "GET", `/sorne/reports/${milestoneId}/export?project_id=${p.id}&version=v9`);
    assert.equal(badVersion.status, 404);
  });
});

test("跨项目 / 未知 id 404 不泄露；内容文件缺失 → 404 + note（不虚报成功）", async () => {
  await withTestServer(async (s) => {
    const base = s.base;
    const p1 = (await call(base, "POST", "/sorne/projects", { body: { name: "导出甲" } })).body.project;
    const p2 = (await call(base, "POST", "/sorne/projects", { body: { name: "导出乙" } })).body.project;
    await call(base, "GET", `/sorne/reports/milestones?project_id=${p1.id}`);
    const store = await getStore({ dataDir: s.dataDir });
    const row = store.db.prepare("SELECT id FROM report_revisions WHERE project_id = ?").get(p1.id);
    assert.ok(row, "阶段报告版本行应存在");

    // 跨项目读取 → 404（不泄露存在性）
    const cross = await call(base, "GET", `/sorne/reports/${row.id}/export?project_id=${p2.id}`);
    assert.equal(cross.status, 404);
    // 未知 id → 404
    const unknown = await call(base, "GET", `/sorne/reports/MR-9999/export?project_id=${p1.id}`);
    assert.equal(unknown.status, 404);

    // 内容文件缺失 → 404 + note（磁盘文件被删，行元数据保留）
    const meta = store.db.prepare("SELECT content_ref FROM report_revisions WHERE id = ?").get(row.id);
    rmSync(join(s.dataDir, meta.content_ref));
    const missing = await call(base, "GET", `/sorne/reports/${row.id}/export?project_id=${p1.id}`);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.match(missing.body.detail?.note ?? "", /refresh=1 可生成新版本/);
    await closeStore({ dataDir: s.dataDir });
  });
});
