/**
 * M3：创建项目（名称/测试目标/测试任务/LLM 基础配置）与删除项目（清空数据库 + 文件 + 会话）。
 * 规范 §6.1/§16.4；M3 创建/删除接口验收。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { withTestServer } from "./helpers.mjs";

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

test("创建项目记录 name/description/task + 初始范围；删除项目清空库与文件且必须 confirm", async () => {
  await withTestServer(async (s) => {
    const target = "http://crud.example.test/";
    const created = await call(s.base, "POST", "/sorne/projects", {
      name: "CRUD 测试项目",
      description: target,
      task: "验证创建与删除",
      target,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const project = created.body.project;
    assert.equal(project.task, "验证创建与删除");
    assert.equal(project.description, target);
    assert.ok(project.current_scope_revision, "应有初始范围版本");
    const scope = await call(s.base, "GET", `/sorne/projects/${project.id}/scope`);
    assert.deepEqual(scope.body.current.rules.allow, [target]);

    const noConfirm = await call(s.base, "DELETE", `/sorne/projects/${project.id}`);
    assert.equal(noConfirm.status, 422, "缺少 confirm 必须拒绝（PRECONDITION_INVALID）");

    const deleted = await call(s.base, "DELETE", `/sorne/projects/${project.id}?confirm=delete`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted_project_id, project.id);
    assert.ok(deleted.body.deleted.projects === 1);
    assert.ok(deleted.body.deleted.scope_revisions >= 1, "范围版本应被清除");
    assert.equal(deleted.body.files_removed, true);
    assert.equal(existsSync(join(s.dataDir, "projects", project.id)), false, "projects/<id> 目录应删除");

    const gone = await call(s.base, "GET", `/sorne/projects/${project.id}`);
    assert.equal(gone.status, 404);
  });
});