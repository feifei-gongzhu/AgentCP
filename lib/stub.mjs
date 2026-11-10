/**
 * 施工期路由桩工厂（骨架冻结）。
 *
 * 蓝图 §5 API 注册表中的每个端点在骨架期都已预接线；未实装端点由
 * 所属模块的桩返回 501 NOT_IMPLEMENTED，并标注负责模块与规范章节。
 * NOT_IMPLEMENTED 是过渡码：模块竣工后其端点不再返回该码（验收项）。
 */
import { apiError } from "./errors.mjs";

export function stub(moduleId, method, path, specRef, opts = {}) {
  return {
    method,
    path,
    rawBody: Boolean(opts.rawBody),
    maxBodyBytes: opts.maxBodyBytes,
    async handler() {
      throw apiError("NOT_IMPLEMENTED", `端点 ${method} ${path} 由模块 ${moduleId} 施工（${specRef}）`, {
        module: moduleId,
        endpoint: `${method} ${path}`,
        spec: specRef,
      });
    },
  };
}
