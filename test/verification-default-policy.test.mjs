/**
 * 内置验证策略回归（§8.3 必备要素：验证策略及其版本）。
 *
 * 生产进程此前没有任何 registerVerificationPolicy 调用点 → request_verification 恒
 * INVALID_REFERENCE，独立验证链路不可用。本用例把「进程启动即存在可用策略」钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_VERIFICATION_POLICY, listVerificationPolicies } from "../lib/store/verification.mjs";

test("内置默认验证策略已注册，request_verification 无需额外注册即可用", () => {
  const policies = listVerificationPolicies();
  const found = policies.find(
    (p) => p.id === DEFAULT_VERIFICATION_POLICY.id && p.version === DEFAULT_VERIFICATION_POLICY.version,
  );
  assert.ok(found, "默认策略必须随模块加载注册（否则生产验证准入链路不可用）");
  assert.deepEqual(found.required_checks, ["evidence_reviewed"]);
  assert.match(found.description, /Manifest|原始证据/);
});

test("策略版本不可变：同键不同内容重注册被拒绝", async () => {
  const { registerVerificationPolicy } = await import("../lib/store/verification.mjs");
  const { ApiError } = await import("../lib/errors.mjs");
  assert.throws(
    () => registerVerificationPolicy({ id: "default-verification", version: "v1", required_checks: ["other"], description: "x" }),
    (error) => error instanceof ApiError && error.code === "BAD_REQUEST",
  );
});