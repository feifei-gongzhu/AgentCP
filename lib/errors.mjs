/**
 * 错误注册表（冻结契约，见 docs/BLUEPRINT.md §5.3）。
 *
 * §20.1 机器可区分错误码全集（13 个）为唯一业务错误码来源；
 * TRUST_DENIED / NOT_FOUND / BAD_REQUEST / INTERNAL_ERROR 为传输层骨架码，
 * NOT_IMPLEMENTED 为施工期桩码（模块落地后逐步消失），均不属于 §20.1。
 *
 * 错误信封（§20.1）：返回是否可重试、已保存内容的回执和下一步所需条件。
 * 服务端不能用“发生错误”掩盖提交实际上已经成功。
 */

export const SPEC_ERROR_CODES = Object.freeze([
  // §20.1 原文顺序
  "INVALID_REFERENCE",
  "SCOPE_DENIED",
  "SCOPE_UNRESOLVED",
  "EVIDENCE_NOT_COMMITTED",
  "IDEMPOTENCY_KEY_REUSED",
  "STALE_STATE",
  "STALE_EVIDENCE",
  "CLAIM_CHANGED",
  "LEASE_EXPIRED",
  "PRECONDITION_INVALID",
  "RESOURCE_LIMIT",
  "CURSOR_EXPIRED",
  "DEPENDENCY_CYCLE",
]);

/** 传输层 / 骨架层错误码（非 §20.1，不参与业务一致性语义）。 */
export const TRANSPORT_ERROR_CODES = Object.freeze([
  "TRUST_DENIED", // 非回环来源或变更请求缺少同源 Origin（信任边界）
  "NOT_FOUND", // 路由未命中
  "BAD_REQUEST", // 请求体不可解析
  "REQUEST_TOO_LARGE", // 超过请求体上限
  "INTERNAL_ERROR", // 未分类异常
  "NOT_IMPLEMENTED", // 施工期桩：端点已预接线，由蓝图指定模块实装
]);

/** 错误码默认 HTTP 状态与可重试性。业务码的重试语义由各模块按 §20.1 细化。 */
export const ERROR_META = Object.freeze(
  Object.fromEntries([
    ...SPEC_ERROR_CODES.map((code) => [code, { status: 422, retryable: false }]),
    ["TRUST_DENIED", { status: 403, retryable: false }],
    ["NOT_FOUND", { status: 404, retryable: false }],
    ["BAD_REQUEST", { status: 400, retryable: false }],
    ["REQUEST_TOO_LARGE", { status: 413, retryable: false }],
    ["INTERNAL_ERROR", { status: 500, retryable: false }],
    ["NOT_IMPLEMENTED", { status: 501, retryable: false }],
  ]),
);

/** 统一业务/传输错误对象；dispatcher 捕获后按信封序列化。 */
export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    const meta = ERROR_META[code] || { status: 500, retryable: false };
    this.status = (extra && typeof extra.status === "number") ? extra.status : meta.status;
    this.retryable = Boolean((extra && extra.retryable) ?? meta.retryable);
    this.extra = extra || {};
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.extra,
    };
  }
}

export function apiError(code, message, extra) {
  return new ApiError(code, message, extra);
}
