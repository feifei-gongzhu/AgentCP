/**
 * §14 Outbox 消费闭环：bootstrap 跳过存量、增量写 applied 回执并置 sent、幂等。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProject, getStore, submit } from "../lib/store/record-service.mjs";
import { issueSession } from "../lib/store/sessions.mjs";
import { bootstrapOutbox, consumeOutbox } from "../lib/store/outbox-consumer.mjs";
import { closeAllStores } from "../lib/store/evidence.mjs";

const QUIET = { info() {}, warn() {}, error() {} };

test("Outbox 消费：存量 bootstrap skipped，增量 applied+sent，重复消费幂等", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sorne-outbox-"));
  const pctx = { dataDir: dir, logger: QUIET };
  try {
    const created = await createProject(pctx, { actor: "test", name: "outbox-test" });
    const projectId = created.project.id;
    const session = issueSession({ project_id: projectId, actor: "worker-test", role: "worker" });
    const pending = () =>
      getStore(pctx).then((s) => s.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE project_id = ? AND delivery_status = 'pending'").get(projectId).c);
    const first = await submit(pctx, {
      session,
      envelope: {
        submission_id: "OUTBOX-T-0001",
        operations: [
          { op: "register_asset", local_ref: "a1", asset_type: "service", canonicalization_version: "v1", canonical_key: "http://outbox.example.com:80/" },
        ],
      },
    });
    assert.ok(await pending() >= 1, "提交后应有 pending 事件");
    const boot = await bootstrapOutbox(pctx, { projectId, throughCommitSeq: first.commit_seq });
    assert.ok(boot.bootstrap_skipped >= 1);
    assert.equal(await pending(), 0, "bootstrap 后存量 pending 清零（skipped）");

    const second = await submit(pctx, {
      session,
      envelope: {
        submission_id: "OUTBOX-T-0002",
        operations: [
          { op: "register_asset", local_ref: "a2", asset_type: "technology", canonicalization_version: "v1", canonical_key: "nginx" },
        ],
      },
    });
    assert.ok(await pending() >= 1);
    const consumed = await consumeOutbox(pctx, { projectId, fromCommitSeq: first.commit_seq, throughCommitSeq: second.commit_seq });
    assert.ok(consumed.applied >= 1, "写 applied 回执");
    assert.equal(await pending(), 0, "增量事件置 sent 后 pending 清零");
    const receipts = await getStore(pctx).then((s) => s.db.prepare("SELECT COUNT(*) AS c FROM consumer_receipts WHERE consumer_id = 'sorne-runtime' AND receipt_kind = 'applied'").get().c);
    assert.ok(receipts >= 1, "applied 回执持久化");
    const again = await consumeOutbox(pctx, { projectId, fromCommitSeq: first.commit_seq, throughCommitSeq: second.commit_seq });
    assert.equal(again.marked_sent, 0, "重复消费不重复置 sent（幂等）");
  } finally {
    closeAllStores();
    await rm(dir, { recursive: true, force: true });
  }
});