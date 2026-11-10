import test from "node:test";
import assert from "node:assert/strict";

import { withTestServer } from "./helpers.mjs";
import { closeStore } from "../lib/store/record-service.mjs";
import {
  providerInBackoff,
  readProviderHealth,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderForRetry,
} from "../lib/store/provider-health.mjs";

test("provider 健康是真实三态：未知 → 失败 → 成功，成功清除旧 auth 阻断", () =>
  withTestServer(async (s) => {
    const pctx = { dataDir: s.dataDir };
    const key = "http:test/model";

    const unknown = await readProviderHealth(pctx, key);
    assert.equal(unknown.reachable, null, "尚未真实调用不能冒充可用");
    assert.equal(unknown.known, false);

    await recordProviderFailure(pctx, key, "auth_error");
    const failed = await readProviderHealth(pctx, key);
    assert.equal(failed.reachable, false);
    assert.equal(failed.needs_user, true);
    assert.equal((await providerInBackoff(pctx, key)).needs_user, true);

    await recordProviderSuccess(pctx, key);
    const recovered = await readProviderHealth(pctx, key);
    assert.equal(recovered.reachable, true);
    assert.equal(recovered.last_error_kind, null, "成功必须清除当前故障，否则 auth_error 会永久 needs_user");
    assert.equal(recovered.needs_user, false);
    assert.equal((await providerInBackoff(pctx, key)).in_backoff, false);
    await closeStore(pctx);
  }));

test("同 provider key 更新凭据后可重新探测，但在成功前显示未验证", () =>
  withTestServer(async (s) => {
    const pctx = { dataDir: s.dataDir };
    const key = "http:same-base/same-model";
    await recordProviderFailure(pctx, key, "auth_error");
    await resetProviderForRetry(pctx, key);

    const reset = await readProviderHealth(pctx, key);
    assert.equal(reset.reachable, null);
    assert.equal(reset.last_error_kind, null);
    assert.equal((await providerInBackoff(pctx, key)).in_backoff, false);
    await closeStore(pctx);
  }));
