import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { closeStore, getStore } from "../lib/store/record-service.mjs";
import { applyIntentTransition, reconcileIntentLiveness } from "../lib/store/intents.mjs";

test("retryable 执行采用持久化有界重试：3 次重派后第 4 次失败自动搁置", () =>
  withTestServer(async (s) => {
    const created = await s.request("POST", "/sorne/projects", { body: { name: "有界重试项目" } });
    const projectId = created.body.project.id;
    const pctx = { dataDir: s.dataDir };
    const store = await getStore(pctx);
    const now = new Date().toISOString();
    store.db.prepare(
      `INSERT INTO intents
       (id, project_id, question, kind, status, created_at, created_by, created_seq)
       VALUES ('I-RETRY-1', ?, '不可达目标是否恢复', 'collect', 'running', ?, 'test', 2)`,
    ).run(projectId, now);

    const results = [];
    for (let n = 1; n <= 4; n += 1) {
      const attemptId = `ATT-RETRY-${n}`;
      store.db.prepare(
        `INSERT INTO attempts
         (id, project_id, intent_id, assignment_id, worker_id, fencing_token, status,
          recovery_note, created_at, created_by, created_seq)
         VALUES (?, ?, 'I-RETRY-1', ?, 'worker-test', ?, 'interrupted', ?, ?, 'test', ?)`,
      ).run(
        attemptId,
        projectId,
        `ASM-RETRY-${n}`,
        n,
        JSON.stringify({ reason_code: "retryable", reason: "target_unreachable" }),
        now,
        n + 2,
      );
      const result = store.runSerial((db) => reconcileIntentLiveness(db, {
        projectId,
        intentId: "I-RETRY-1",
        triggerAttemptId: attemptId,
      }));
      results.push(await result);
      if (n < 4) {
        await store.runSerial((db) => applyIntentTransition(db, {
          projectId,
          actor: "test",
          intentId: "I-RETRY-1",
          action: "start",
          via: "test_retry_cycle",
        }));
      }
    }

    assert.deepEqual(results.map((r) => r.action), ["requeue", "requeue", "requeue", "block"]);
    assert.equal(results[3].retry_exhausted, true);
    const intent = store.db.prepare("SELECT status, retry_count, retry_limit FROM intents WHERE id = 'I-RETRY-1'").get();
    assert.equal(intent.status, "blocked");
    assert.equal(intent.retry_count, 4);
    assert.equal(intent.retry_limit, 3);
    const shelf = store.db.prepare("SELECT status, shelve_reason, reconsider_conditions_json FROM branch_shelving WHERE branch_id = 'I-RETRY-1'").get();
    assert.equal(shelf.status, "shelved");
    assert.equal(shelf.shelve_reason, "blocked");
    assert.match(shelf.reconsider_conditions_json, /目标或依赖恢复可达/);
    await closeStore(pctx);
  }));
