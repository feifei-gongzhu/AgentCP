/**
 * M2 —— LLM 连接配置路由（蓝图 §2.6-1 端点 #50/#51/#52 + 施工要点主路径；M2）。
 *
 * 路径面（蓝图 §10.7「竣工时如有出入以竣工记录为准」）：
 *   - 施工要点主路径：POST /sorne/settings/llm、GET /sorne/settings/llm/status、
 *     POST /sorne/settings/llm/test（存储 <dataDir>/llm.json，参照已就位的
 *     sorne-data/llm.json 结构；apiKey 服务端保存、永不回传浏览器）；
 *   - 蓝图别名（M1/M3 契约兼容）：GET|PUT /sorne/llm/settings、POST /sorne/llm/test
 *     ——同一存储与语义，不设第二套行为。
 *
 * 安全与语义：
 *   - 所有响应脱敏（api_key_set + api_key_hint 掩码），响应体永不含明文 key；
 *   - 写入成功后必须调用 pctx.agents.reload()（蓝图 §2.6-8 热加载契约）——否则
 *     运行时保持启动时判定，「配置后即启动运行时」断链；句柄缺 reload 时安全跳过
 *     （兼容旧存根），跳过事实在响应 reload 字段如实标注；
 *   - test 用给定或已存配置对 base_url 发起真实最小 chat 请求（max_tokens=1，
 *     10s 超时），返回可用+时延或明确失败原因（超时/HTTP 状态/非兼容响应）；
 *   - 信任边界由 dispatcher 统一实施（回环 + 变更同源，lib/http.mjs 冻结）。
 */
import { apiError } from "../errors.mjs";
import {
  LLM_ROLES,
  envConfig,
  readLlmSettings,
  sanitizedView,
  resolveEffectiveConfig,
  testLlmConnection,
  writeLlmSettings,
} from "../store/llm-settings.mjs";

/** 写入成功后的运行时热加载（§2.6-8；句柄缺 reload 安全跳过并如实标注）。 */
async function reloadAgents(pctx) {
  if (pctx.agents && typeof pctx.agents.reload === "function") {
    try {
      const result = await pctx.agents.reload({ configChanged: true });
      return { reloaded: true, started: Boolean(result && result.started), reason: result?.reason ?? null };
    } catch (error) {
      return { reloaded: false, started: false, reason: `运行时热加载失败：${String(error?.message ?? error)}` };
    }
  }
  return { reloaded: false, started: false, reason: "运行时句柄不支持热加载（旧存根），重启进程后生效" };
}

/** 测试配置解析：显式 baseUrl/model 优先，否则用已存（store > env）按角色解析。 */
function configForTest(pctx, body) {
  const b = body || {};
  const { config: stored } = readLlmSettings(pctx.dataDir);
  const role = typeof b.role === "string" && b.role ? b.role : "default";
  if (role !== "default" && !LLM_ROLES.includes(role)) {
    throw apiError("BAD_REQUEST", `角色覆盖仅允许：${LLM_ROLES.join("、")}`);
  }
  const effective = resolveEffectiveConfig(stored, role) || (role !== "default" ? null : envConfig());
  const baseUrl = typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim() : effective?.baseUrl;
  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : effective?.model;
  if (!baseUrl || !model) {
    throw apiError(
      "BAD_REQUEST",
      "尚未配置模型且请求未携带 baseUrl/model：先 POST /sorne/settings/llm 保存配置，或在请求中显式给出",
      { next_requirements: ["POST /sorne/settings/llm { base_url, model, api_key }"] },
    );
  }
  return { baseUrl, model, apiKey: effective?.apiKey };
}

export const routes = [
  // #50 GET /sorne/llm/settings（蓝图路径）＝ GET /sorne/settings/llm/status（施工要点路径）
  {
    method: "GET",
    path: "/sorne/llm/settings",
    async handler(pctx) {
      const { config, source } = readLlmSettings(pctx.dataDir);
      const view = sanitizedView(config, { source });
      // 存储未配置但环境变量可用时如实标注（store > env 顺序的读取面）
      if (!view.configured && envConfig()) {
        const env = envConfig();
        return { ...view, configured: true, source: "env", model: env.model, base_url: env.baseUrl };
      }
      return view;
    },
  },
  {
    method: "GET",
    path: "/sorne/settings/llm/status",
    async handler(pctx) {
      const { config, source } = readLlmSettings(pctx.dataDir);
      const view = sanitizedView(config, { source });
      if (!view.configured && envConfig()) {
        const env = envConfig();
        return { ...view, configured: true, source: "env", model: env.model, base_url: env.baseUrl };
      }
      return view;
    },
  },
  // #51 PUT /sorne/llm/settings（蓝图路径）＝ POST /sorne/settings/llm（施工要点路径）
  {
    method: "PUT",
    path: "/sorne/llm/settings",
    async handler(pctx, req, res, { body }) {
      const saved = await writeLlmSettings(pctx.dataDir, body || {});
      const reload = await reloadAgents(pctx); // §2.6-8：配置后即启动运行时
      return { ...sanitizedView(saved, { source: "store" }), reload };
    },
  },
  {
    method: "POST",
    path: "/sorne/settings/llm",
    async handler(pctx, req, res, { body }) {
      const saved = await writeLlmSettings(pctx.dataDir, body || {});
      const reload = await reloadAgents(pctx);
      return { ...sanitizedView(saved, { source: "store" }), reload };
    },
  },
  // #52 POST /sorne/llm/test（蓝图路径）＝ POST /sorne/settings/llm/test（施工要点路径）
  {
    method: "POST",
    path: "/sorne/llm/test",
    async handler(pctx, req, res, { body }) {
      const cfg = configForTest(pctx, body);
      return testLlmConnection(cfg);
    },
  },
  {
    method: "POST",
    path: "/sorne/settings/llm/test",
    async handler(pctx, req, res, { body }) {
      const cfg = configForTest(pctx, body);
      return testLlmConnection(cfg);
    },
  },
];
