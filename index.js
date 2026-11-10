/**
 * Sorne —— dsh 插件服务半端（运行在 Harness 进程内）。
 *
 * 职责（骨架期已定型，见 docs/BLUEPRINT.md）：
 *   1. 在宿主 webServer 上注册 /sorne/* 前缀路由（kind: "prefix"）；
 *   2. 扫描 lib/routes/*.routes.mjs 装载全部模块挂载点（蓝图 §5 API 注册表）；
 *   3. 统一实施信任边界（回环 + 变更请求同源 Origin，lib/http.mjs）与错误信封；
 *   4. 数据目录：SORNE_DATA_DIR 覆盖，默认 ~/.sorne；项目按 §5.2 布局存放。
 *
 * 本文件为冻结共享文件：模块施工不改此文件，只新增 lib/routes/<area>.routes.mjs。
 */
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDispatcher, loadRouteFiles } from "./lib/router.mjs";
import { registerDshTools } from "./lib/agents/dsh-bridge.mjs";
import { startAgentRuntime } from "./lib/agents/runtime.mjs";

export const name = "sorne";
export const inject = ["webServer"];

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(PLUGIN_DIR, "lib", "routes");

const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));

/** 数据根目录：测试/演练用 SORNE_DATA_DIR 指向独立临时目录。 */
export function resolveDataDir() {
  const fromEnv = process.env.SORNE_DATA_DIR && process.env.SORNE_DATA_DIR.trim();
  return fromEnv ? fromEnv : join(homedir(), ".sorne");
}

export function apply(ctx) {
  const logger = (ctx && ctx.logger) || {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const pctx = { logger, dataDir, pluginDir: PLUGIN_DIR, version: pkg.version };

  // 路由装载是异步动态 import；apply 保持同步（宿主契约），
  // 首个请求到来前完成（dispatcher 等待同一个 Promise）。
  const routesReady = loadRouteFiles(ROUTES_DIR);
  const dispatch = createDispatcher({ routes: routesReady });

  // AI 半端（规范 §3.1/§2 约束 11；第 2 轮打磨接线——冻结文件最小改动，
  // 偏差见 docs/modules/AGENTS.md）：四角色代理循环（Planner/Orchestrator/
  // Worker/Verifier，独立 LLM 会话）+ dsh 只读工具桥接。无 LLM 提供方时
  // 显式等待（started:false），存储与工具端点不受影响（§16.4 不伪造 AI 决策）。
  let agents = null;
  try {
    agents = startAgentRuntime(pctx, { hostCtx: ctx, logger });
    pctx.agents = agents;
    if (!agents.started) {
      logger.info?.(`[sorne] 代理运行时未启动：${agents.reason}`);
    }
  } catch (error) {
    logger.error?.(`[sorne] 代理运行时启动失败：${String(error?.message ?? error)}`);
  }
  const dshBridge = registerDshTools(ctx, pctx);

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/sorne",
      handler: (req, res) => dispatch(pctx, req, res),
    });
    return () => {
      if (typeof dispose === "function") dispose();
      if (agents && typeof agents.stop === "function") agents.stop();
      if (dshBridge && typeof dshBridge.dispose === "function") dshBridge.dispose();
    };
  }, "sorne: /sorne routes");
}

/** 无头测试用：暴露内部解析入口（不触碰真实数据目录）。 */
export const __test__ = { resolveDataDir, loadRouteFiles, createDispatcher, ROUTES_DIR };
