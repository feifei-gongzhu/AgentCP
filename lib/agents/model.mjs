/**
 * AI 半端 —— LLM 客户端抽象（规范 §3.1/§2 约束 11 的「AI 决策」半边）。
 *
 * 设计约束：
 *   - 规范 §3.1：Planner 与 Orchestrator「必须采用独立 LLM + 工具实现」，
 *     Worker/Verifier 为 LLM + 工具角色。本模块只提供**真实**模型调用通道，
 *     绝不提供规则兜底——无可用提供方时代理循环拒绝启动并显式返回原因
 *     （把 Orchestrator 降为固定流程引擎是规范明令禁止的，§3.1）。
 *   - 调用通道（按证据选择）：
 *     1) OpenAI 兼容 HTTP 端点（/chat/completions，含 tools 函数调用），
 *        经环境变量配置：SORNE_LLM_BASE_URL / SORNE_LLM_API_KEY / SORNE_LLM_MODEL
 *        （可选 SORNE_LLM_TIMEOUT_MS）。DeepSeek/OpenAI 兼容服务均可。
 *     2) dsh 宿主：参考实现（dsh-mrecon）证据表明宿主仅经 ctx.get("tools")
 *        向**宿主会话**暴露插件工具，未暴露插件可调用的模型 API
 *        （docs/BLUEPRINT.md §13.3 即此遗留）；因此 dsh 侧只做工具桥接
 *        （lib/agents/dsh-bridge.mjs），模型调用一律走 1)。
 *   - 工程内没有任何隐式「演示模型」：测试以确定性模型替身（脚本化
 *     tool_calls）或本地 OpenAI 兼容测试服务器驱动，生产路径必须配置
 *     真实端点。规范 §20.3 的反 mock 要求针对事务与故障注入——存储、
 *     事务与网关路径在测试中全部真实；模型本身在 CI 中无法连真实服务，
 *     以替身注入属常规做法，且生产路径不经过替身。
 */
import { readLlmSettings, resolveEffectiveConfig } from "../store/llm-settings.mjs";

/** 进程内 LLM 用量计数（重启清零；供成本巡检与诊断）。 */
const llmUsageTotals = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
export function getLlmUsage() {
  return { ...llmUsageTotals };
}

/** 归一化的模型消息/工具调用形状（与传输格式解耦）。 */
export function normalizeAssistantMessage(raw) {
  const msg = raw && typeof raw === "object" ? raw : {};
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .map((tc) => {
          if (!tc || typeof tc !== "object") return null;
          const fn = tc.function || {};
          let args = {};
          if (typeof fn.arguments === "string" && fn.arguments.trim()) {
            try {
              args = JSON.parse(fn.arguments);
            } catch {
              args = { _parse_error: String(fn.arguments).slice(0, 400) };
            }
          } else if (fn.arguments && typeof fn.arguments === "object") {
            args = fn.arguments;
          }
          return {
            id: typeof tc.id === "string" && tc.id ? tc.id : `call_${Math.random().toString(36).slice(2, 10)}`,
            name: typeof fn.name === "string" ? fn.name : "",
            arguments: args,
          };
        })
        .filter((tc) => tc && tc.name)
    : [];
  return {
    role: "assistant",
    content: typeof msg.content === "string" ? msg.content : msg.content ?? null,
    tool_calls: toolCalls,
    finish_reason: typeof msg.finish_reason === "string" ? msg.finish_reason : null,
  };
}

/**
 * 把**内部归一化消息**转回 OpenAI Chat Completions 线格式（P0 修复）。
 *
 * 内部形状（loop 与四角色共用）：assistant.tool_calls = [{ id, name, arguments:对象 }]，
 * tool 消息 = { role:"tool", tool_call_id, name, content:字符串 }。
 * 线格式（DeepSeek/OpenAI 规范，实测 deepseek-flash 422 拒绝旧形状）：
 *   assistant.tool_calls = [{ id, type:"function", function:{ name, arguments:JSON字符串 } }]；
 *   每条 tool 消息 = { role:"tool", tool_call_id, content }（name 不在规范内，剥离）；
 *   每个 tool_call id 必须有且仅有一条 tool 应答（loop 负责不截断丢答）。
 * 只保留规范字段：剥离 finish_reason / reasoning_content / name 等内部字段。
 */
const MAX_HISTORY_TOOLCALL_ARG_CHARS = 1500;
function truncateToolCallArguments(text) {
  if (typeof text !== "string" || text.length <= MAX_HISTORY_TOOLCALL_ARG_CHARS) return text;
  return JSON.stringify({
    _truncated_arguments_prefix: text.slice(0, MAX_HISTORY_TOOLCALL_ARG_CHARS),
    _note: "历史工具调用参数过长，已截断以控制上下文成本；完整内容在持久记录/证据中",
  });
}

export function toWireMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      const calls = Array.isArray(m.tool_calls)
        ? m.tool_calls.filter((tc) => tc && typeof tc.name === "string" && tc.name)
        : [];
      const msg = {
        role: "assistant",
        content: m.content === undefined ? null : m.content,
      };
      if (calls.length) {
        msg.tool_calls = calls.map((tc, i) => ({
          id: typeof tc.id === "string" && tc.id ? tc.id : `call_${i}`,
          type: "function",
          function: {
            name: tc.name,
            // 成本护栏：历史工具调用参数可能极长（如 submit_findings 的整段观察文本），
            // 每步重发会指数级放大 prompt。历史里超过 1500 字符的参数替换为合法 JSON
            // 截断占位（工具结果本身仍完整、按编号可读）。
            arguments: truncateToolCallArguments(
              typeof tc.arguments === "string"
                ? tc.arguments
                : JSON.stringify(tc.arguments === undefined ? {} : tc.arguments),
            ),
          },
        }));
      }
      out.push(msg);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content === undefined ? null : m.content });
  }
  return out;
}

/** HTTP（OpenAI 兼容）提供方。 */
function httpProvider({ baseUrl, apiKey, model, timeoutMs, logger }) {
  const base = baseUrl.replace(/\/+$/, "");
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 20_000;
  async function chat({ system, messages, tools, maxTokens, temperature, tag }) {
    const body = {
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...toWireMessages(messages),
      ],
      ...(tools && tools.length ? { tools } : {}),
      ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    };
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const isTimeout = error && error.name === "AbortError";
        const reason = isTimeout ? `超时（${timeoutMs}ms）` : String(error?.message ?? error);
        const e = new Error(`LLM 调用失败（${base}/chat/completions）：${reason}`);
        e.providerErrorKind = isTimeout ? "timeout" : "network_error";
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = RETRY_BASE_MS * (attempt + 1);
        logger?.warn?.(`[sorne-llm] 429 限流，${wait}ms 后重试（${attempt + 1}/${MAX_RETRIES}）`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (!res.ok) {
        const e = new Error(`LLM 端点返回 HTTP ${res.status}：${JSON.stringify(json).slice(0, 400)}`);
        e.providerErrorKind =
          res.status === 429 ? "rate_limit"
          : res.status === 401 || res.status === 403 ? "auth_error"
          : res.status >= 500 ? "server_error"
          : res.status === 404 ? "config_error"
          : "server_error";
        throw e;
      }
      if (json && json.usage) {
        llmUsageTotals.calls += 1;
        llmUsageTotals.prompt_tokens += Number(json.usage.prompt_tokens) || 0;
        llmUsageTotals.completion_tokens += Number(json.usage.completion_tokens) || 0;
        if (logger && typeof logger.info === "function") {
          try {
            logger.info(
              "[sorne-llm] " + (tag || "-") + " " + model + " tokens: in=" + (json.usage.prompt_tokens ?? "?")
                + " out=" + (json.usage.completion_tokens ?? "?")
                + " total=" + (json.usage.total_tokens ?? "?"),
            );
          } catch {
            /* 日志失败不影响模型调用 */
          }
        }
      }
      const choice = json && Array.isArray(json.choices) && json.choices[0] ? json.choices[0] : null;
      if (!choice) {
        throw new Error(`LLM 响应缺少 choices：${JSON.stringify(json).slice(0, 400)}`);
      }
      const normalized = normalizeAssistantMessage(choice.message);
      normalized.finish_reason = choice.finish_reason ?? normalized.finish_reason;
      return normalized;
    }
    const e = new Error(`LLM 429 限流耗尽 ${MAX_RETRIES} 次重试（${base}/chat/completions）`);
    e.providerErrorKind = "rate_limit";
    throw e;
  }
  return {
    kind: "http",
    model,
    describe: () => `openai-compatible:${model}@${base}`,
    chat,
  };
}

/**
 * 解析模型提供方（进程内单飞，避免每 tick 重读 env）。
 * 解析顺序（蓝图 §2.6-1 冻结）：进程内替身（测试）> 存储配置（<dataDir>/llm.json，
 * M2 连接配置端点写入）> 环境变量。
 * 可选 role（planner/orchestrator/worker/verifier）：存储配置 per_role 高级覆盖
 * 优先于默认档；无覆盖回落默认配置。无任何可用配置返回 null（显式等待，§16.4）。
 * 测试可经 pctx.__modelProvider 直接注入确定性替身（仅测试入口使用）。
 */
export function resolveModelProvider(pctx, { role, logger } = {}) {
  if (pctx && pctx.__modelProvider) {
    return pctx.__modelProvider;
  }
  // 1) 存储配置（M2：<dataDir>/llm.json）
  if (pctx && pctx.dataDir) {
    try {
      const { config } = readLlmSettings(pctx.dataDir);
      const effective = resolveEffectiveConfig(config, role);
      if (effective && effective.baseUrl && effective.model) {
        const timeoutMs = Number(process.env.SORNE_LLM_TIMEOUT_MS) > 0
          ? Number(process.env.SORNE_LLM_TIMEOUT_MS)
          : 120_000;
        return httpProvider({
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          model: effective.model,
          timeoutMs,
          logger,
        });
      }
    } catch {
      // 存储读取失败不阻断 env 回退（不猜测内容）
    }
  }
  // 2) 环境变量
  const baseUrl = process.env.SORNE_LLM_BASE_URL && process.env.SORNE_LLM_BASE_URL.trim();
  const apiKey = process.env.SORNE_LLM_API_KEY && process.env.SORNE_LLM_API_KEY.trim();
  const model = process.env.SORNE_LLM_MODEL && process.env.SORNE_LLM_MODEL.trim();
  if (!baseUrl || !model) {
    return null;
  }
  const timeoutMs = Number(process.env.SORNE_LLM_TIMEOUT_MS) > 0
    ? Number(process.env.SORNE_LLM_TIMEOUT_MS)
    : 120_000;
  return httpProvider({ baseUrl, apiKey, model, timeoutMs, logger });
}

/** 提供方缺失时的显式等待说明（§16.4：等待，不伪造 AI 决策）。 */
export function missingProviderNotice() {
  return (
    "尚未连接模型：POST /sorne/settings/llm（写 <dataDir>/llm.json）或设置环境变量 "
    + "SORNE_LLM_BASE_URL 与 SORNE_LLM_MODEL（可选 SORNE_LLM_API_KEY、SORNE_LLM_TIMEOUT_MS，"
    + "OpenAI 兼容 /chat/completions）后，Planner/Orchestrator/Worker/Verifier 代理循环才可运行"
    + "（配置成功后运行时经 reload() 热启动，无需重启进程）。规范 §3.1 禁止以固定流程替代 AI，"
    + "未配置时系统进入等待，记录与工具端点不受影响。"
  );
}
