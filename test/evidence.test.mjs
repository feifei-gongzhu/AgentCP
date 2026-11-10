/**
 * A2 —— 证据存储与采集记录测试（§5.2 §5.3 §5.4 §13 §8.3 §18.3）。
 *
 * 蓝图 §7 验收映射中 A2 主责场景：
 *   - 场景 4  同 URL JS 内容变化 → 保留两个版本，旧行号锚点仍可读取；
 *   - 场景 5  两次响应仅 Token 不同 → 两份原始证据仍在，派生 Diff 可降噪；
 *   - 场景 23 Blob 写入成功但事务失败 → 业务无半条引用，孤立 Blob 可识别；
 *   - 场景 25 磁盘满或证据存储不可用 → 不创建无证据的成功记录，工作明确受阻。
 *
 * 故障注入全部为真实注入（staging 占位文件、磁盘内容损坏、外键事务失败、
 * 句柄真实重开），不使用 mock 替代被测事务语义。
 *
 * 并行安全：每个用例独立 mkdtemp 临时目录；HTTP 用例 listen(0) 随机端口；
 * finally 关闭服务、关闭本模块数据库句柄、删除临时目录；环境变量改动就地恢复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { withTestServer } from "./helpers.mjs";
import * as evidence from "../lib/store/evidence.mjs";
import * as layout from "../lib/store/layout.mjs";

const QUIET = { info() {}, warn() {}, error() {} };

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), "sorne-a2-"));
  const pctx = { dataDir: dir, logger: QUIET };
  try {
    return await fn(pctx, dir);
  } finally {
    evidence.closeAllStores();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedProject(pctx, projectId, name = "A2 测试项目") {
  const store = await evidence.getStore(pctx);
  await store.runSerial((db) => {
    db.prepare("INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, ?, ?)").run(
      projectId,
      name,
      new Date().toISOString(),
      "test",
    );
  });
  return store;
}

/** 以指定数据目录启动真实路由（helpers.withTestServer 的参数顺序为 (fn, opts)）。 */
async function withServerOn(dir, fn) {
  return withTestServer(fn, { dataDir: dir });
}

/** 原始字节 POST（绕过 helpers.request 的 JSON 序列化；同源 Origin 不可少）。 */
async function postRaw(base, path, bytes, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { origin: base, ...extraHeaders },
    body: bytes,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

async function getBytes(base, path) {
  const res = await fetch(`${base}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  const text = buf.toString("utf8");
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, buf, headers: res.headers, body };
}

/* ── §13 写入顺序与 Blob 基础 ─────────────────────────────────────── */

test("POST /evidence/blobs：staging→哈希→固定→登记→回执全链路（§13）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T1");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("console.log('a2');\n", "utf8");
      const { status, body } = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-T1&representation=raw_body",
        bytes,
        { "x-sorne-actor": "worker-1" },
      );
      assert.equal(status, 200);
      assert.equal(body.blob_id, "B-PRJ-T1-0001");
      assert.equal(body.sha256, sha256hex(bytes));
      assert.equal(body.byte_size, bytes.length);
      assert.equal(body.representation, "raw_body");
      assert.equal(body.storage_status, "fixed");
      assert.equal(body.referencable, true);
      assert.equal(body.deduplicated, false);
      // 文件固定在 §5.2 布局位置
      const fixed = layout.blobPath(dir, "PRJ-T1", body.sha256);
      assert.ok(existsSync(fixed), "固定文件应存在");
      assert.deepEqual(readFileSync(fixed), bytes);
      // 数据库登记与 stored_path（相对数据根）
      const store = await evidence.getStore(pctx);
      const row = store.db.prepare("SELECT * FROM blobs WHERE project_id = ?").get("PRJ-T1");
      assert.equal(row.storage_status, "fixed");
      assert.equal(row.stored_path, layout.relToDataDir(dir, fixed));
      assert.equal(row.created_by, "worker-1");
      // staging 已清空
      const stagingFiles = await readdir(layout.evidenceDirs(dir, "PRJ-T1").staging);
      assert.equal(stagingFiles.length, 0, "staging 不应残留");
    });
  }));

test("rawBody 流式上传不受 256KiB JSON 预读上限约束（蓝图 §2.2/#11）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T2");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.alloc(300 * 1024, 0x61); // 300KiB > 256KiB
      const { status, body } = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-T2&representation=raw_body",
        bytes,
      );
      assert.equal(status, 200);
      assert.equal(body.byte_size, 300 * 1024);
      const got = await getBytes(s.base, `/sorne/evidence/blobs/${body.sha256}?project_id=PRJ-T2`);
      assert.equal(got.status, 200);
      assert.deepEqual(got.buf, bytes);
    });
  }));

test("超过自定上限返回 413 REQUEST_TOO_LARGE 且不留任何记录", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T3");
    // 注意：环境变量装拆在服务回调内完成。若在 try/finally 中以裸 return 返回
    // Promise，finally（恢复 env）会先于该 Promise 结算执行，提前删掉变量。
    return withServerOn(dir, async (s) => {
      const prev = process.env.SORNE_EVIDENCE_MAX_BYTES;
      process.env.SORNE_EVIDENCE_MAX_BYTES = "1024";
      try {
        const { status, body } = await postRaw(
          s.base,
          "/sorne/evidence/blobs?project_id=PRJ-T3&representation=raw_body",
          Buffer.alloc(3000, 0x62),
        );
        assert.equal(status, 413);
        assert.equal(body.code, "REQUEST_TOO_LARGE");
        const store = await evidence.getStore(pctx);
        const count = store.db.prepare("SELECT COUNT(*) AS c FROM blobs").get().c;
        assert.equal(count, 0, "超限上传不得产生证据记录");
      } finally {
        if (prev === undefined) delete process.env.SORNE_EVIDENCE_MAX_BYTES;
        else process.env.SORNE_EVIDENCE_MAX_BYTES = prev;
      }
    });
  }));

test("内容寻址去重：相同字节返回原回执，库中只有一行，去重不删采集历史", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T4");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("duplicate-me", "utf8");
      const first = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T4&representation=raw_body", bytes);
      const second = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T4&representation=raw_body", bytes);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.body.blob_id, first.body.blob_id);
      assert.equal(second.body.deduplicated, true);
      assert.equal(second.body.created_seq, first.body.created_seq, "去重返回原回执的提交序号");
      const store = await evidence.getStore(pctx);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id='PRJ-T4'").get().c, 1);
    });
  }));

test("representation 必填且受枚举约束；expected_sha256 不符拒绝且丢弃暂存", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T5");
    return withServerOn(dir, async (s) => {
      const missing = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T5", Buffer.from("x"));
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, "BAD_REQUEST");
      const bogus = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-T5&representation=magic",
        Buffer.from("x"),
      );
      assert.equal(bogus.status, 400);
      const bytes = Buffer.from("payload", "utf8");
      const wrong = await postRaw(
        s.base,
        `/sorne/evidence/blobs?project_id=PRJ-T5&representation=raw_body&expected_sha256=${"0".repeat(64)}`,
        bytes,
      );
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.actual, sha256hex(bytes));
      const store = await evidence.getStore(pctx);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id='PRJ-T5'").get().c, 0);
      const staging = await readdir(layout.evidenceDirs(dir, "PRJ-T5").staging);
      assert.equal(staging.length, 0, "失败上传应清空暂存");
    });
  }));

test("§20.3 场景 25（主责）：证据存储不可用 → 可重试错误、不创建成功记录、工作明确受阻", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T6");
    // 真实注入：staging 位置被普通文件占据 → 目录无法创建，写入必败。
    const staging = layout.evidenceDirs(dir, "PRJ-T6").staging;
    mkdirSync(dirname(staging), { recursive: true });
    writeFileSync(staging, "not-a-dir");
    return withServerOn(dir, async (s) => {
      const { status, body } = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-T6&representation=raw_body",
        Buffer.from("will-fail"),
      );
      assert.equal(status, 500);
      assert.equal(body.code, "INTERNAL_ERROR");
      assert.equal(body.retryable, true, "存储不可用必须可重试（§13 上传失败返回可重试错误）");
      assert.ok(body.message.includes("证据存储不可用"));
      assert.ok(Array.isArray(body.next_requirements) && body.next_requirements.length > 0, "错误必须给出受阻与恢复条件");
      const store = await evidence.getStore(pctx);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id='PRJ-T6'").get().c, 0, "不创建无证据的成功记录");
      // 恢复存储后同一上传可成功（受阻可解除）
      rmSync(staging);
      const ok = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T6&representation=raw_body", Buffer.from("will-fail"));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.referencable, true);
    });
  }));

test("不可变保护：目标 Blob 路径被不同内容占用时拒绝覆盖（真实损坏注入）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T7");
    const legit = Buffer.from("legitimate content", "utf8");
    const sha = sha256hex(legit);
    const target = layout.blobPath(dir, "PRJ-T7", sha);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "corrupted different bytes"); // 预置损坏内容
    return withServerOn(dir, async (s) => {
      const { status, body } = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-T7&representation=raw_body",
        legit,
      );
      assert.equal(status, 500);
      assert.equal(body.integrity, "mismatch");
      assert.equal(body.retryable, false);
      assert.equal(readFileSync(target, "utf8"), "corrupted different bytes", "不得覆盖已存在内容");
      const store = await evidence.getStore(pctx);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE project_id='PRJ-T7'").get().c, 0);
    });
  }));

test("GET /evidence/blobs/{sha256}：原始字节 + 元数据头；404/坏哈希/lost 拒读", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T8");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("body-bytes-§8.3", "utf8");
      const up = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T8&representation=decoded_body", bytes);
      assert.equal(up.status, 200);
      const got = await getBytes(s.base, `/sorne/evidence/blobs/${up.body.sha256}?project_id=PRJ-T8`);
      assert.equal(got.status, 200);
      assert.deepEqual(got.buf, bytes);
      assert.equal(got.headers.get("x-sorne-representation"), "decoded_body");
      assert.equal(got.headers.get("x-sorne-blob-id"), up.body.blob_id);
      assert.equal(got.headers.get("x-sorne-sha256"), up.body.sha256);

      const notFound = await getBytes(s.base, `/sorne/evidence/blobs/${"a".repeat(64)}`);
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.code, "NOT_FOUND");
      const malformed = await getBytes(s.base, "/sorne/evidence/blobs/notahash");
      assert.equal(malformed.status, 400);

      // lost 状态：数据库如实记录异常后拒绝作为证据提供
      const store = await evidence.getStore(pctx);
      await store.runSerial((db) => {
        db.prepare(
          `INSERT INTO blobs (id, project_id, sha256, byte_size, representation, stored_path, storage_status,
             source_kind, created_at, created_by, created_seq)
           VALUES ('B-LOST', 'PRJ-T8', ?, 1, 'raw_body', 'nowhere', 'lost', 'tool_gateway', ?, 't', 1)`,
        ).run("b".repeat(64), new Date().toISOString());
      });
      const lost = await getBytes(s.base, `/sorne/evidence/blobs/${"b".repeat(64)}`);
      assert.equal(lost.status, 422);
      assert.equal(lost.body.code, "EVIDENCE_NOT_COMMITTED");
    });
  }));

test("磁盘内容与登记哈希不符时拒绝提供字节（完整性校验不静默）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-T9");
    return withServerOn(dir, async (s) => {
      const up = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-T9&representation=raw_body", Buffer.from("original"));
      assert.equal(up.status, 200);
      // 真实注入：磁盘损坏
      writeFileSync(layout.blobPath(dir, "PRJ-T9", up.body.sha256), "tampered!!!");
      const got = await getBytes(s.base, `/sorne/evidence/blobs/${up.body.sha256}?project_id=PRJ-T9`);
      assert.equal(got.status, 500);
      assert.equal(got.body.integrity, "mismatch");
      assert.equal(got.body.code, "INTERNAL_ERROR");
    });
  }));

/* ── §20.3 场景 4/5（A2 主责） ────────────────────────────────────── */

test("§20.3 场景 4（主责）：同 URL JS 内容变化 → 两个版本保留，旧行号锚点仍可读取", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-C4");
    const v1 = Buffer.from("console.log('v1');\nconst version = 1;\n", "utf8");
    const v2 = Buffer.from("console.log('v2');\nconst version = 2;\n// added\n", "utf8");
    const b1 = await evidence.storeBlob(pctx, { projectId: "PRJ-C4", bytes: v1, representation: "raw_body", actor: "w" });
    const b2 = await evidence.storeBlob(pctx, { projectId: "PRJ-C4", bytes: v2, representation: "raw_body", actor: "w" });
    assert.notEqual(b1.sha256, b2.sha256);
    const cap1 = await evidence.registerCapture(pctx, {
      project_id: "PRJ-C4",
      tool_call_id: "TC-V1",
      response_body_blob: b1.sha256,
      request_url_exact: "https://test.com/js/static/app.js",
      method: "GET",
      observed_at: new Date().toISOString(),
    });
    const cap2 = await evidence.registerCapture(pctx, {
      project_id: "PRJ-C4",
      tool_call_id: "TC-V2",
      response_body_blob: b2.sha256,
      request_url_exact: "https://test.com/js/static/app.js",
      method: "GET",
    });
    // 两个版本、两条采集都保留；旧行号锚点仍可读取（绑定 v1 哈希）
    const r1 = await evidence.readBlobBytes(pctx, { sha256: b1.sha256, projectId: "PRJ-C4" });
    const r2 = await evidence.readBlobBytes(pctx, { sha256: b2.sha256, projectId: "PRJ-C4" });
    assert.deepEqual(r1.bytes, v1);
    assert.deepEqual(r2.bytes, v2);
    const anchorV1 = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-C4",
      anchor: {
        capture_id: cap1.capture_id,
        blob_hash: b1.sha256,
        representation: "raw_body",
        locator_type: "line_range",
        locator: { start_line: 2, end_line: 2 },
        text_encoding: "utf-8",
      },
    });
    assert.equal(anchorV1.text, "const version = 1;");
    // v2 锚点绑定新版本行号
    const anchorV2 = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-C4",
      anchor: { capture_id: cap2.capture_id, blob_hash: b2.sha256, representation: "raw_body", locator_type: "line_range", locator: { start_line: 3, end_line: 3 } },
    });
    assert.equal(anchorV2.text, "// added");
    // 旧锚点若错绑到新版本哈希 → 拒绝（版本绑定强校验）
    await assert.rejects(
      () => evidence.resolveEvidenceAnchor(pctx, {
        projectId: "PRJ-C4",
        anchor: { capture_id: cap1.capture_id, blob_hash: b2.sha256, representation: "raw_body", locator_type: "whole" },
      }),
      (e) => e.code === "INVALID_REFERENCE",
    );
    // 同事务事件：两条 capture.completed + 一条 resource.content_changed
    const store = await evidence.getStore(pctx);
    const events = store.db
      .prepare("SELECT event_type, commit_seq, event_index FROM outbox WHERE project_id = ? ORDER BY commit_seq, event_index")
      .all("PRJ-C4");
    assert.deepEqual(
      events.map((e) => `${e.event_type}@${e.commitSeq ?? e.commit_seq}:${e.event_index}`),
      ["capture.completed@3:0", "capture.completed@4:0", "resource.content_changed@4:1"],
    );
    const changed = store.db
      .prepare("SELECT payload FROM outbox WHERE event_type = 'resource.content_changed' AND project_id = ?")
      .get("PRJ-C4");
    const payload = JSON.parse(changed.payload);
    assert.equal(payload.previous_sha256, b1.sha256);
    assert.equal(payload.new_sha256, b2.sha256);
    assert.equal(payload.request_url_exact, "https://test.com/js/static/app.js");
  }));

test("§20.3 场景 5（主责）：两次响应仅 Token 不同 → 两份原始证据仍在，派生脱敏可降噪", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-C5");
    const bodyA = Buffer.from('{"token":"aaaa1111","role":"admin","page":1}', "utf8");
    const bodyB = Buffer.from('{"token":"bbbb2222","role":"admin","page":1}', "utf8");
    const bA = await evidence.storeBlob(pctx, { projectId: "PRJ-C5", bytes: bodyA, representation: "raw_body" });
    const bB = await evidence.storeBlob(pctx, { projectId: "PRJ-C5", bytes: bodyB, representation: "raw_body" });
    assert.notEqual(bA.sha256, bB.sha256, "仅 Token 不同也是两份独立原始证据");
    const capA = await evidence.registerCapture(pctx, {
      project_id: "PRJ-C5", tool_call_id: "TC-A", response_body_blob: bA.sha256,
      request_url_exact: "https://test.com/api/list", method: "GET",
    });
    const capB = await evidence.registerCapture(pctx, {
      project_id: "PRJ-C5", tool_call_id: "TC-B", response_body_blob: bB.sha256,
      request_url_exact: "https://test.com/api/list", method: "GET",
    });
    // 派生脱敏（去噪）：对两份原始证据做同一 transform → 同一降噪产物
    const redact = (buf) => Buffer.from(buf.toString("utf8").replace(/"token":"[a-z0-9]+"/g, '"token":"<redacted>"'), "utf8");
    const tA = await evidence.registerTransform(pctx, {
      project_id: "PRJ-C5", source_kind: "capture", source_id: capA.capture_id,
      transform_name: "redact_tokens", transform_version: "1.0.0", parameters: { fields: ["token"] },
      derived_bytes: redact(bodyA),
    });
    const tB = await evidence.registerTransform(pctx, {
      project_id: "PRJ-C5", source_kind: "capture", source_id: capB.capture_id,
      transform_name: "redact_tokens", transform_version: "1.0.0", parameters: { fields: ["token"] },
      derived_bytes: redact(bodyB),
    });
    assert.equal(tA.derived_blob.sha256, tB.derived_blob.sha256, "降噪后同形 → 同一派生 Blob（内容寻址去重）");
    // 原始证据不受派生影响
    const rA = await evidence.readBlobBytes(pctx, { sha256: bA.sha256, projectId: "PRJ-C5" });
    const rB = await evidence.readBlobBytes(pctx, { sha256: bB.sha256, projectId: "PRJ-C5" });
    assert.deepEqual(rA.bytes, bodyA);
    assert.deepEqual(rB.bytes, bodyB);
    // 采集详情能看到派生链（完整依据层）
    const detailA = await evidence.getCaptureDetail(pctx, capA.capture_id);
    assert.equal(detailA.transforms.length, 1);
    assert.equal(detailA.transforms[0].transform_name, "redact_tokens");
    assert.equal(detailA.transforms[0].parameters.fields[0], "token");
    assert.equal(detailA.transforms[0].derived_blob.representation, "derived");
  }));

test("§20.3 场景 23（主责）：Blob 固定成功但事务失败 → 无半条引用，孤立 Blob 可识别", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-C23");
    const bytes = Buffer.from("orphan candidate", "utf8");
    // §13 前两步真实成功：staging → 固定
    const staged = await evidence.stageBytes(pctx, { projectId: "PRJ-C23", bytes });
    const fixed = await evidence.fixBlobFile(pctx, { projectId: "PRJ-C23", sha256: staged.sha256, stagingPath: staged.stagingPath });
    assert.ok(existsSync(fixed.blobPath));
    // 真实事务失败注入：登记事务内外键失效（项目行被删除 → projects 外键违反）
    const store = await evidence.getStore(pctx);
    await store.runSerial((db) => {
      db.prepare("DELETE FROM projects WHERE id = ?").run("PRJ-C23");
    });
    await assert.rejects(
      () => evidence.registerBlob(pctx, {
        projectId: "PRJ-C23", sha256: staged.sha256, byteSize: staged.byteSize,
        representation: "raw_body", blobPath: fixed.blobPath,
      }),
      (e) => e.code === "INVALID_REFERENCE",
    );
    // 业务无半条引用：任何项目都没有指向该文件的 Blob 行
    const rows = store.db.prepare("SELECT COUNT(*) AS c FROM blobs").get().c;
    assert.equal(rows, 0);
    // 孤立 Blob 可识别（findStorageAnomalies）
    await seedProject(pctx, "PRJ-C23", "重建项目（新行）");
    const anomalies = await evidence.findStorageAnomalies(pctx, { projectId: "PRJ-C23" });
    assert.equal(anomalies.orphan_files.length, 1);
    assert.equal(anomalies.orphan_files[0], layout.relToDataDir(pctx.dataDir, fixed.blobPath));
    assert.equal(anomalies.missing_files.length, 0);
    assert.equal(anomalies.mismatched_files.length, 0);
    // 被引用证据不得因孤立识别而丢弃（§13）：文件仍在原处
    assert.ok(existsSync(fixed.blobPath));
  }));

/* ── POST /captures 与 GET /captures/{id} ────────────────────────── */

test("POST /captures：校验、幂等、同事务事件与回执（§5.3）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-CAP");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("<html>ok</html>", "utf8");
      const up = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-CAP&representation=raw_body", bytes);
      const reqBody = {
        project_id: "PRJ-CAP",
        tool_call_id: "TC-HTTP-1",
        response_body_blob: up.body.sha256,
        request_url_exact: "https://test.com/index.html",
        method: "GET",
        observed_at: new Date().toISOString(),
        source_kind: "tool_gateway",
        condition_snapshot_id: "COND-1",
      };
      const first = await s.request("POST", "/sorne/captures", { body: reqBody, origin: s.base });
      assert.equal(first.status, 200);
      assert.equal(first.body.capture_id, "CAP-PRJ-CAP-0001");
      assert.equal(first.body.capture_no, 1);
      assert.equal(first.body.event_id, `evt-PRJ-CAP-${first.body.commit_seq}-0`);
      assert.equal(first.body.capture.integrity_status, "verified");
      assert.equal(first.body.capture.condition_snapshot_id, "COND-1");
      assert.ok(first.body.asset_entry && first.body.asset_entry.logical_path);
      // 同一 tool_call_id 重复提交 → 原采集，无重复事件
      const dup = await s.request("POST", "/sorne/captures", { body: reqBody });
      assert.equal(dup.status, 200);
      assert.equal(dup.body.deduplicated, true);
      assert.equal(dup.body.capture_id, first.body.capture_id);
      // 同 ID 不同内容 → 明确拒绝（引用另一份真实固定 Blob，先过存在性校验）
      const up2 = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-CAP&representation=raw_body",
        Buffer.from("<html>different</html>", "utf8"),
      );
      const conflict = await s.request("POST", "/sorne/captures", {
        body: { ...reqBody, response_body_blob: up2.body.sha256 },
      });
      assert.equal(conflict.status, 422);
      assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
      assert.equal(conflict.body.existing_capture_id, first.body.capture_id);
      // outbox 恰好一条 capture.completed
      const store = await evidence.getStore(pctx);
      const events = store.db.prepare("SELECT * FROM outbox WHERE project_id = ?").all("PRJ-CAP");
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "capture.completed");
      const payload = JSON.parse(events[0].payload);
      assert.equal(payload.request_url_exact, "https://test.com/index.html");
      assert.equal(payload.response_blob_sha256, up.body.sha256);
    });
  }));

test("POST /captures 引用校验：未固定 Blob 拒绝（EVIDENCE_NOT_COMMITTED）；未知对象拒绝（INVALID_REFERENCE）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-CAP2");
    return withServerOn(dir, async (s) => {
      // staged（未固定）Blob：直接构造数据库状态
      const store = await evidence.getStore(pctx);
      await store.runSerial((db) => {
        db.prepare(
          `INSERT INTO blobs (id, project_id, sha256, byte_size, representation, stored_path, storage_status,
             source_kind, created_at, created_by, created_seq)
           VALUES ('B-STG', 'PRJ-CAP2', ?, 1, 'raw_body', 'nowhere', 'staged', 'tool_gateway', ?, 't', 1)`,
        ).run("c".repeat(64), new Date().toISOString());
      });
      const notFixed = await s.request("POST", "/sorne/captures", {
        body: { project_id: "PRJ-CAP2", tool_call_id: "TC-1", response_body_blob: "c".repeat(64), request_url_exact: "https://x/1", method: "GET" },
      });
      assert.equal(notFixed.status, 422);
      assert.equal(notFixed.body.code, "EVIDENCE_NOT_COMMITTED");

      const unknownProject = await s.request("POST", "/sorne/captures", {
        body: { project_id: "NOPE", tool_call_id: "TC-2", response_body_blob: "c".repeat(64), request_url_exact: "https://x/1", method: "GET" },
      });
      assert.equal(unknownProject.status, 422);
      assert.equal(unknownProject.body.code, "INVALID_REFERENCE");

      const unknownBlob = await s.request("POST", "/sorne/captures", {
        body: { project_id: "PRJ-CAP2", tool_call_id: "TC-3", response_body_blob: "d".repeat(64), request_url_exact: "https://x/1", method: "GET" },
      });
      assert.equal(unknownBlob.status, 422);
      assert.equal(unknownBlob.body.code, "INVALID_REFERENCE");

      const up = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-CAP2&representation=raw_body", Buffer.from("z"));
      const unknownResource = await s.request("POST", "/sorne/captures", {
        body: { project_id: "PRJ-CAP2", tool_call_id: "TC-4", response_body_blob: up.body.sha256, request_url_exact: "https://x/1", method: "GET", resource_id: "R-NOPE" },
      });
      assert.equal(unknownResource.status, 422);
      assert.equal(unknownResource.body.code, "INVALID_REFERENCE");
      const unknownAttempt = await s.request("POST", "/sorne/captures", {
        body: { project_id: "PRJ-CAP2", tool_call_id: "TC-5", response_body_blob: up.body.sha256, request_url_exact: "https://x/1", method: "GET", attempt_id: "ATT-NOPE" },
      });
      assert.equal(unknownAttempt.status, 422);
      assert.equal(unknownAttempt.body.code, "INVALID_REFERENCE");
      // 无一登记成功
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM captures WHERE project_id='PRJ-CAP2'").get().c, 0);
    });
  }));

test("第三方导入/worker 上传标记来源，不伪装为 tool_gateway（§5.3）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-SRC");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("imported-config", "utf8");
      const up = await postRaw(
        s.base,
        "/sorne/evidence/blobs?project_id=PRJ-SRC&representation=uploaded_file&source_kind=third_party_import",
        bytes,
      );
      assert.equal(up.status, 200);
      assert.equal(up.body.source_kind, "third_party_import");
      const cap = await s.request("POST", "/sorne/captures", {
        body: {
          project_id: "PRJ-SRC", tool_call_id: "TC-IMPORT-1", response_body_blob: up.body.sha256,
          request_url_exact: "file:///imported/config", method: "IMPORT",
          source_kind: "third_party_import",
        },
      });
      assert.equal(cap.status, 200);
      assert.equal(cap.body.capture.source_kind, "third_party_import");
      const store = await evidence.getStore(pctx);
      const row = store.db.prepare("SELECT source_kind FROM captures WHERE id = ?").get(cap.body.capture_id);
      assert.equal(row.source_kind, "third_party_import", "来源标记必须如实入库");
      const bad = await s.request("POST", "/sorne/captures", {
        body: { project_id: "PRJ-SRC", tool_call_id: "TC-IMPORT-2", response_body_blob: up.body.sha256, request_url_exact: "https://x/1", method: "GET", source_kind: "secret" },
      });
      assert.equal(bad.status, 400);
    });
  }));

test("采集前证据文件缺失：标记 lost 并拒绝新采集引用（不造假记录）", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-LOST");
    const up = await evidence.storeBlob(pctx, { projectId: "PRJ-LOST", bytes: Buffer.from("gone-soon"), representation: "raw_body" });
    await evidence.registerCapture(pctx, {
      project_id: "PRJ-LOST", tool_call_id: "TC-OK", response_body_blob: up.sha256,
      request_url_exact: "https://test.com/a", method: "GET",
    });
    rmSync(layout.blobPath(pctx.dataDir, "PRJ-LOST", up.sha256)); // 真实注入：文件消失
    await assert.rejects(
      () => evidence.registerCapture(pctx, {
        project_id: "PRJ-LOST", tool_call_id: "TC-AFTER-LOSS", response_body_blob: up.sha256,
        request_url_exact: "https://test.com/a", method: "GET",
      }),
      (e) => {
        assert.equal(e.code, "EVIDENCE_NOT_COMMITTED");
        assert.equal(e.extra.integrity, "missing");
        return true;
      },
    );
    const store = await evidence.getStore(pctx);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM captures WHERE tool_call_id='TC-AFTER-LOSS'").get().c, 0);
    const blob = store.db.prepare("SELECT storage_status FROM blobs WHERE id = ?").get(up.blob_id);
    assert.equal(blob.storage_status, "lost", "缺失文件的 Blob 状态如实更新为 lost");
    // 历史采集记录保留
    assert.ok(store.db.prepare("SELECT id FROM captures WHERE tool_call_id='TC-OK'").get());
  }));

test("GET /captures/{id}：完整依据层详情与派生链、读取入口（§18.3）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-DET");
    return withServerOn(dir, async (s) => {
      const bodyBytes = Buffer.from('{"status":500}', "utf8");
      const reqBytes = Buffer.from("GET /api/x HTTP/1.1\r\nHost: test.com\r\n\r\n", "utf8");
      const hdrBytes = Buffer.from("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\n\r\n", "utf8");
      const body = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-DET&representation=raw_body", bodyBytes);
      const reqRec = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-DET&representation=request_record", reqBytes);
      const hdrRec = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-DET&representation=exchange_record", hdrBytes);
      const cap = await s.request("POST", "/sorne/captures", {
        body: {
          project_id: "PRJ-DET", tool_call_id: "TC-DET", response_body_blob: body.body.sha256,
          request_ref: reqRec.body.sha256, response_headers_ref: hdrRec.body.sha256,
          request_url_exact: "https://test.com/api/x", method: "GET", observed_at: new Date().toISOString(),
        },
      });
      assert.equal(cap.status, 200);
      const detail = await s.request("GET", `/sorne/captures/${cap.body.capture_id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.capture.capture_id, cap.body.capture_id);
      assert.equal(detail.body.response_body_blob.sha256, body.body.sha256);
      assert.equal(detail.body.response_body_blob.representation, "raw_body");
      assert.equal(detail.body.request_ref_blob.representation, "request_record");
      assert.equal(detail.body.response_headers_ref_blob.representation, "exchange_record");
      assert.ok(detail.body.read_pointers.response_body_bytes.includes("/sorne/evidence/blobs/"));
      assert.deepEqual(detail.body.transforms, []);
      const notFound = await s.request("GET", "/sorne/captures/CAP-NOPE");
      assert.equal(notFound.status, 404);
    });
  }));

/* ── §5.2 assets/ 逻辑目录与 work/ 工作区（layout.mjs） ──────────── */

test("assets/ 逻辑目录：非法字符与路径穿越防护；逻辑路径不承担证据身份（§5.2）", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-L1");
    const mkEntry = async (captureNo, url) => {
      mkdirSync(join(pctx.dataDir, "seed"), { recursive: true });
      const src = join(pctx.dataDir, "seed", `s${captureNo}`);
      writeFileSync(src, `content-${captureNo}`);
      return layout.materializeAssetEntry(pctx.dataDir, "PRJ-L1", {
        capture_id: `CAP-PRJ-L1-${String(captureNo).padStart(4, "0")}`,
        capture_no: captureNo,
        url_exact: url,
        method: "GET",
        sha256: sha256hex(Buffer.from(`content-${captureNo}`)),
        representation: "raw_body",
        captured_at: new Date().toISOString(),
        source_blob_path: src,
      });
    };
    // 编码的 .. 段与穿越段全部被中和；结果必须落在项目 assets/ 之下
    const r1 = await mkEntry(1, "https://evil.test/a%2e%2e/../../x/..%2f..%2fetc/passwd.txt?x=1");
    const projAssets = join(layout.projectDir(pctx.dataDir, "PRJ-L1"), "assets");
    const target1 = join(layout.projectDir(pctx.dataDir, "PRJ-L1"), r1.logical_path);
    assert.ok(target1.startsWith(projAssets), "逻辑入口不得逃出 assets/");
    // 安全属性：任何一段都不是 "." 或 ".."（段内字符级点号无害，穿越靠段边界）
    for (const seg of r1.logical_path.split("/")) {
      assert.ok(seg !== "." && seg !== "..", `路径段不得为穿越段：${seg}`);
    }
    assert.ok(existsSync(target1));
    assert.ok(existsSync(target1 + ".capture.json"));
    // sidecar 保留完整 URL（含查询）——逻辑路径不承担证据身份
    const sidecar1 = JSON.parse(readFileSync(target1 + ".capture.json", "utf8"));
    assert.equal(sidecar1.url_exact, "https://evil.test/a%2e%2e/../../x/..%2f..%2fetc/passwd.txt?x=1");
    assert.equal(sidecar1.capture_no, 1);
    // 非法字符主机名（IPv6 + 怪字符）也被清洗为单段
    const r2 = await mkEntry(2, "http://[::1]:8080/<bad|name>/file?.js");
    const target2 = join(projAssets, r2.logical_path);
    assert.ok(target2.startsWith(projAssets));
    assert.ok(!existsSync(join(pctx.dataDir, "projects", "PRJ-L1", "etc")), "不得在项目根外或根内产生穿越目录");
  }));

test("assets/ 逻辑目录：URL 冲突以资源编号消歧；最新入口标明采集编号并保留版本历史（§5.2）", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-L2");
    const projDir = layout.projectDir(pctx.dataDir, "PRJ-L2");
    const projAssets = join(projDir, "assets");
    const seedDir = join(pctx.dataDir, "seed");
    mkdirSync(seedDir, { recursive: true });
    const materialize = async (no, url, resourceId, content) => {
      const src = join(seedDir, `m${no}`);
      writeFileSync(src, content);
      return layout.materializeAssetEntry(pctx.dataDir, "PRJ-L2", {
        capture_id: `CAP-PRJ-L2-${String(no).padStart(4, "0")}`,
        capture_no: no,
        url_exact: url,
        method: "GET",
        resource_id: resourceId,
        sha256: sha256hex(Buffer.from(content)),
        representation: "raw_body",
        captured_at: new Date().toISOString(),
        source_blob_path: src,
      });
    };
    // 同一 URL 新版本：入口就地更新，sidecar 标明最新采集编号，历史保留
    const e1 = await materialize(1, "https://test.com/js/app.js?v=1", null, "// v1");
    assert.equal(e1.updated, "created");
    const e2 = await materialize(2, "https://test.com/js/app.js?v=1", null, "// v2");
    assert.equal(e2.logical_path, e1.logical_path);
    assert.equal(e2.updated, "new_version");
    const sidecar = JSON.parse(readFileSync(join(projDir, e1.logical_path + ".capture.json"), "utf8"));
    assert.equal(sidecar.capture_no, 2, "最新入口必须同时标明采集编号");
    assert.equal(sidecar.versions.length, 2);
    assert.equal(readFileSync(join(projDir, e1.logical_path), "utf8"), "// v2", "入口内容指向最新版本");
    // 不同 URL（仅查询不同）映射冲突 → 资源编号消歧，不覆盖他人入口
    const e3 = await materialize(3, "https://test.com/js/app.js?v=2", "R-0009", "// other-url");
    assert.equal(e3.disambiguated, true);
    assert.notEqual(e3.logical_path, e1.logical_path);
    assert.ok(e3.logical_path.includes("--R-0009"), "消歧名包含资源编号");
    assert.equal(readFileSync(join(projDir, e1.logical_path), "utf8"), "// v2", "原入口不被覆盖");
    const sidecarOther = JSON.parse(readFileSync(join(projDir, e3.logical_path + ".capture.json"), "utf8"));
    assert.equal(sidecarOther.url_exact, "https://test.com/js/app.js?v=2");
    // 未建档资源（无 resource_id）以确定性 URL 哈希消歧
    const e4 = await materialize(4, "https://test.com/js/app.js?v=3", null, "// third-url");
    assert.equal(e4.disambiguated, true);
    assert.ok(/--u[0-9a-f]{8}\.js$/.test(e4.logical_path));
    // 未知占用文件（无 sidecar）不被覆盖
    const hostile = join(projAssets, "test.com", "js", "occupied.js");
    mkdirSync(dirname(hostile), { recursive: true });
    writeFileSync(hostile, "not-ours");
    const e5 = await materialize(5, "https://test.com/js/occupied.js", null, "// legit");
    assert.equal(e5.disambiguated, true);
    assert.equal(readFileSync(hostile, "utf8"), "not-ours");
  }));

test("work/<intent>/<attempt>/ 工作区：创建成功且穿越段被中和（§5.2）", () =>
  withEnv(async (pctx) => {
    const ws = await layout.ensureWorkspace(pctx.dataDir, "PRJ-L3", "../../escape", "ATT-1");
    const projWork = join(layout.projectDir(pctx.dataDir, "PRJ-L3"), "work");
    assert.ok(ws.startsWith(projWork), "工作区不得逃出 work/");
    assert.ok(existsSync(ws));
    assert.ok(!existsSync(join(pctx.dataDir, "projects", "PRJ-L3", "escape")));
    const ws2 = await layout.ensureWorkspace(pctx.dataDir, "PRJ-L3", "I-0001", "ATT-1");
    assert.equal(ws2, join(projWork, "I-0001", "ATT-1"));
  }));

/* ── §5.4 EvidenceAnchor 绑定版本与解码 ──────────────────────────── */

test("EvidenceAnchor：表示形式绑定强校验；格式化产物的行号绑定派生 Blob（§5.4）", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-AN");
    const raw = Buffer.from("const a=1\nconst b=2\n", "utf8");
    const b = await evidence.storeBlob(pctx, { projectId: "PRJ-AN", bytes: raw, representation: "raw_body" });
    const cap = await evidence.registerCapture(pctx, {
      project_id: "PRJ-AN", tool_call_id: "TC-AN", response_body_blob: b.sha256,
      request_url_exact: "https://test.com/raw.js", method: "GET",
    });
    const base = { capture_id: cap.capture_id, blob_hash: b.sha256, representation: "raw_body", locator_type: "line_range", locator: { start_line: 1, end_line: 1 } };
    // 表示形式不符 → 拒绝（解码产物不得冒称原始字节行号）
    await assert.rejects(
      () => evidence.resolveEvidenceAnchor(pctx, { projectId: "PRJ-AN", anchor: { ...base, representation: "decoded_body" } }),
      (e) => e.code === "INVALID_REFERENCE",
    );
    // 坏 locator → BAD_REQUEST
    await assert.rejects(
      () => evidence.resolveEvidenceAnchor(pctx, { projectId: "PRJ-AN", anchor: { ...base, locator: { start_line: 0, end_line: 3 } } }),
      (e) => e.code === "BAD_REQUEST",
    );
    await assert.rejects(
      () => evidence.resolveEvidenceAnchor(pctx, { projectId: "PRJ-AN", anchor: { ...base, locator: { start_line: 1, end_line: 99 } } }),
      (e) => e.code === "BAD_REQUEST",
    );
    // byte_range 左闭右开
    const br = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-AN",
      anchor: { capture_id: cap.capture_id, blob_hash: b.sha256, representation: "raw_body", locator_type: "byte_range", locator: { start_byte: 0, end_byte: 9 } },
    });
    assert.equal(br.bytes.toString("utf8"), "const a=1");
    // json_pointer
    const jsonBytes = Buffer.from('{"a":{"b":[10,20]},"c":null}', "utf8");
    const jb = await evidence.storeBlob(pctx, { projectId: "PRJ-AN", bytes: jsonBytes, representation: "decoded_body" });
    const jcap = await evidence.registerCapture(pctx, {
      project_id: "PRJ-AN", tool_call_id: "TC-AN-J", response_body_blob: jb.sha256,
      request_url_exact: "https://test.com/api/j", method: "GET",
    });
    const jp = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-AN",
      anchor: { capture_id: jcap.capture_id, blob_hash: jb.sha256, representation: "decoded_body", locator_type: "json_pointer", locator: "/a/b/1" },
    });
    assert.equal(jp.value, 20);
    // 格式化产物：行号绑定 derived Blob（transform_id），错绑原始哈希 → 拒绝
    const formatted = Buffer.from("// formatted\nconst a=1;\nconst b=2;\n", "utf8");
    const t = await evidence.registerTransform(pctx, {
      project_id: "PRJ-AN", source_kind: "capture", source_id: cap.capture_id,
      transform_name: "prettify", transform_version: "1.1.0", parameters: { printer: "standard" },
      derived_bytes: formatted,
    });
    const okAnchor = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-AN",
      anchor: {
        capture_id: cap.capture_id, transform_id: t.transform_id, blob_hash: t.derived_blob.sha256,
        representation: "derived", locator_type: "line_range", locator: { start_line: 2, end_line: 2 },
      },
    });
    assert.equal(okAnchor.text, "const a=1;");
    assert.equal(okAnchor.via_transform.transform_name, "prettify");
    await assert.rejects(
      () => evidence.resolveEvidenceAnchor(pctx, {
        projectId: "PRJ-AN",
        anchor: {
          capture_id: cap.capture_id, transform_id: t.transform_id, blob_hash: b.sha256,
          representation: "derived", locator_type: "whole",
        },
      }),
      (e) => e.code === "INVALID_REFERENCE",
    );
    // whole 定位符返回全部字节
    const whole = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-AN",
      anchor: { capture_id: cap.capture_id, blob_hash: b.sha256, representation: "raw_body", locator_type: "whole" },
    });
    assert.deepEqual(whole.bytes, raw);
  }));

/* ── 多项目隔离与恢复 ─────────────────────────────────────────────── */

test("多项目隔离：同哈希双项目两行；读取需 project_id 消歧（存储权限域=项目）", () =>
  withEnv(async (pctx, dir) => {
    await seedProject(pctx, "PRJ-P1");
    await seedProject(pctx, "PRJ-P2");
    return withServerOn(dir, async (s) => {
      const bytes = Buffer.from("shared-bytes", "utf8");
      const u1 = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-P1&representation=raw_body", bytes);
      const u2 = await postRaw(s.base, "/sorne/evidence/blobs?project_id=PRJ-P2&representation=raw_body", bytes);
      assert.equal(u1.body.blob_id, "B-PRJ-P1-0001");
      assert.equal(u2.body.blob_id, "B-PRJ-P2-0001");
      const store = await evidence.getStore(pctx);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM blobs WHERE sha256 = ?").get(u1.body.sha256).c, 2);
      const ambiguous = await getBytes(s.base, `/sorne/evidence/blobs/${u1.body.sha256}`);
      assert.equal(ambiguous.status, 400, "未指定 project_id 且多项目存在 → 要求消歧");
      assert.deepEqual(ambiguous.body.project_ids.sort(), ["PRJ-P1", "PRJ-P2"]);
      for (const pid of ["PRJ-P1", "PRJ-P2"]) {
        const got = await getBytes(s.base, `/sorne/evidence/blobs/${u1.body.sha256}?project_id=${pid}`);
        assert.equal(got.status, 200);
        assert.deepEqual(got.buf, bytes);
        assert.equal(got.headers.get("x-sorne-project-id"), pid);
      }
    });
  }));

test("重启恢复语义：句柄真实重开后证据、采集、锚点仍可读（§18.2 第 1 步的存储面）", () =>
  withEnv(async (pctx) => {
    await seedProject(pctx, "PRJ-R");
    const bytes = Buffer.from("survives-restart\nline2\n", "utf8");
    const b = await evidence.storeBlob(pctx, { projectId: "PRJ-R", bytes, representation: "raw_body" });
    const cap = await evidence.registerCapture(pctx, {
      project_id: "PRJ-R", tool_call_id: "TC-R", response_body_blob: b.sha256,
      request_url_exact: "https://test.com/r.js", method: "GET",
    });
    // 真实重开：关闭全部句柄后重新打开（等价于进程重启后的存储面）
    evidence.closeAllStores();
    const r = await evidence.readBlobBytes(pctx, { sha256: b.sha256, projectId: "PRJ-R" });
    assert.deepEqual(r.bytes, bytes);
    const detail = await evidence.getCaptureDetail(pctx, cap.capture_id);
    assert.equal(detail.capture.tool_call_id, "TC-R");
    const anchor = await evidence.resolveEvidenceAnchor(pctx, {
      projectId: "PRJ-R",
      anchor: { capture_id: cap.capture_id, blob_hash: b.sha256, representation: "raw_body", locator_type: "line_range", locator: { start_line: 2, end_line: 2 } },
    });
    assert.equal(anchor.text, "line2");
    const store = await evidence.getStore(pctx);
    const events = store.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id='PRJ-R'").get().c;
    assert.equal(events, 1, "重启后 Outbox 事件仍在（等待 B2 消费）");
  }));
