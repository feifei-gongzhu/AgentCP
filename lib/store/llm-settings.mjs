/**
 * M2 —— LLM 连接配置存储（<dataDir>/llm.json；蓝图 §2.6-1 的施工要点落地形态）。
 *
 * 存储决策（偏离蓝图 llm_settings 表，偏差已在 docs/modules/ui-M2.md 登记）：
 *   施工要点明确「POST /sorne/settings/llm 写 <dataDir>/llm.json，参照已就位的
 *   sorne-data/llm.json 结构」——文件为唯一存储（camelCase 键：provider/baseUrl/
 *   anthropicBaseUrl/model/apiKey + 可选 per_role 角色覆盖 + note/updated_at）。
 *   API key 服务端保存、永不回传浏览器（冻结安全约束，蓝图 §10-4：响应永不回显
 *   明文 key；信任边界为回环-only）。
 *
 * 合同：
 *   - 写入原子（tmp + rename）；进程内串行队列防并发交错；
 *   - 读取容错：文件缺失/损坏返回 null（source="none"），不抛错、不猜测；
 *   - apiKey 缺省=保留原值，空串=清除（蓝图 §2.6-1）；
 *   - resolveModelProvider 顺序 store > env（蓝图 §2.6-1；lib/agents/model.mjs）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { apiError } from "../errors.mjs";

export const LLM_FILE_NAME = "llm.json";
export const LLM_ROLES = Object.freeze(["planner", "orchestrator", "worker", "verifier"]);

const MAX_NOTE = 2000;

export function llmSettingsPath(dataDir) {
  return join(dataDir, LLM_FILE_NAME);
}

/** 掩码 key（脱敏：首段 + … + 末 4 位；短 key 全掩码）。 */
export function maskApiKey(key) {
  if (typeof key !== "string" || !key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function normalizeRoleEntry(entry) {
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const out = {};
  if (typeof entry.model === "string" && entry.model.trim()) out.model = entry.model.trim();
  if (typeof entry.baseUrl === "string" && entry.baseUrl.trim()) out.baseUrl = entry.baseUrl.trim();
  else if (typeof entry.base_url === "string" && entry.base_url.trim()) out.baseUrl = entry.base_url.trim();
  if (typeof entry.provider === "string" && entry.provider.trim()) out.provider = entry.provider.trim();
  if (typeof entry.apiKey === "string") out.apiKey = entry.apiKey;
  else if (typeof entry.api_key === "string") out.apiKey = entry.api_key;
  return Object.keys(out).length ? out : undefined;
}

/** 归一化（写入与读取后统一形态；接受 camelCase 与 snake_case 输入）。 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cfg = {};
  if (typeof raw.provider === "string" && raw.provider.trim()) cfg.provider = raw.provider.trim();
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl : raw.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) cfg.baseUrl = baseUrl.trim();
  if (typeof raw.anthropicBaseUrl === "string" && raw.anthropicBaseUrl.trim()) {
    cfg.anthropicBaseUrl = raw.anthropicBaseUrl.trim();
  }
  if (typeof raw.model === "string" && raw.model.trim()) cfg.model = raw.model.trim();
  // 空串 key 视为未设置（清除语义；不落空字符串）
  if (typeof raw.apiKey === "string" && raw.apiKey !== "") cfg.apiKey = raw.apiKey;
  else if (typeof raw.api_key === "string" && raw.api_key !== "") cfg.apiKey = raw.api_key;
  const perRoleRaw = raw.per_role ?? raw.perRole;
  if (perRoleRaw && typeof perRoleRaw === "object" && !Array.isArray(perRoleRaw)) {
    const perRole = {};
    for (const role of LLM_ROLES) {
      const entry = normalizeRoleEntry(perRoleRaw[role]);
      if (entry) perRole[role] = entry;
    }
    if (Object.keys(perRole).length) cfg.per_role = perRole;
  }
  if (typeof raw.note === "string" && raw.note.trim()) cfg.note = raw.note.slice(0, MAX_NOTE);
  if (typeof raw.updated_at === "string") cfg.updated_at = raw.updated_at;
  return Object.keys(cfg).length ? cfg : null;
}

/** 读取（容错）：{ config, source }；source ∈ "store" | "none"。 */
export function readLlmSettings(dataDir) {
  const file = llmSettingsPath(dataDir);
  if (!existsSync(file)) return { config: null, source: "none" };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { config: normalizeConfig(parsed), source: "store" };
  } catch {
    // 文件损坏不猜测、不覆盖：以未配置呈现，等待用户重写（未提供 ≠ 不存在）
    return { config: null, source: "none" };
  }
}

const writeQueue = new Map(); // dataDir → Promise（进程内串行写）

/** 原子写入（tmp + rename；进程内按 dataDir 串行）。返回归一化后的完整配置。 */
export function writeLlmSettings(dataDir, patch) {
  const prev = writeQueue.get(dataDir) ?? Promise.resolve();
  const job = prev
    .then(() => writeLlmSettingsSync(dataDir, patch))
    .finally(() => {
      if (writeQueue.get(dataDir) === job) writeQueue.delete(dataDir);
    });
  writeQueue.set(dataDir, job);
  return job;
}

function writeLlmSettingsSync(dataDir, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw apiError("BAD_REQUEST", "LLM 设置必须是 JSON 对象");
  }
  const baseUrl = typeof patch.baseUrl === "string" && patch.baseUrl.trim()
    ? patch.baseUrl.trim()
    : typeof patch.base_url === "string" ? patch.base_url.trim() : "";
  const model = typeof patch.model === "string" ? patch.model.trim() : "";
  if (!/^(https?):\/\//i.test(baseUrl)) {
    throw apiError("BAD_REQUEST", "base_url 必填且必须是 http(s) URL");
  }
  if (!model) {
    throw apiError("BAD_REQUEST", "model 必填（非空）");
  }
  const existing = readLlmSettings(dataDir).config ?? {};
  // 写入面同时接受契约键 snake_case api_key 与内部 camelCase apiKey（蓝图 §2.6-1 响应
  // 键为 api_key_set；M3 向导按契约提交 api_key，历史调用方用 apiKey —— 两键等价）。
  const keyPatch = patch.apiKey !== undefined ? patch.apiKey : patch.api_key;
  const next = normalizeConfig({
    provider: patch.provider ?? existing.provider,
    baseUrl,
    anthropicBaseUrl: patch.anthropicBaseUrl ?? existing.anthropicBaseUrl,
    model,
    // apiKey 缺省=保留原值；空串=显式清除
    apiKey: keyPatch === undefined ? existing.apiKey : keyPatch === "" ? undefined : keyPatch,
    per_role: patch.per_role ?? patch.perRole ?? existing.per_role,
    note: patch.note ?? existing.note,
  });
  next.updated_at = new Date().toISOString();
  mkdirSync(dataDir, { recursive: true });
  const file = llmSettingsPath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return next;
}

/** 脱敏视图（响应面冻结：永不含明文 key）。 */
export function sanitizedView(config, { source } = {}) {
  if (!config) {
    return {
      configured: false,
      provider: null,
      model: null,
      base_url: null,
      api_key_set: false,
      api_key_hint: null,
      per_role: {},
      source: source ?? "none",
      updated_at: null,
    };
  }
  return {
    configured: Boolean(config.baseUrl && config.model),
    provider: config.provider ?? null,
    model: config.model ?? null,
    base_url: config.baseUrl ?? null,
    api_key_set: Boolean(config.apiKey),
    api_key_hint: maskApiKey(config.apiKey),
    per_role: Object.fromEntries(
      Object.entries(config.per_role ?? {}).map(([role, entry]) => [
        role,
        { model: entry.model ?? null, base_url: entry.baseUrl ?? null, api_key_set: Boolean(entry.apiKey) },
      ]),
    ),
    source: source ?? "store",
    updated_at: config.updated_at ?? null,
  };
}

/** 角色生效配置（per_role 覆盖默认；返回 null 表示该角色无可用配置）。 */
export function resolveEffectiveConfig(config, role) {
  if (!config || !config.baseUrl || !config.model) return null;
  if (!role || role === "default") return { ...config };
  const override = config.per_role?.[role];
  if (!override) return { ...config };
  return {
    ...config,
    model: override.model || config.model,
    baseUrl: override.baseUrl || config.baseUrl,
    provider: override.provider || config.provider,
    apiKey: override.apiKey !== undefined ? override.apiKey : config.apiKey,
  };
}

/** env 回退配置（store 缺失时）。 */
export function envConfig() {
  const baseUrl = process.env.SORNE_LLM_BASE_URL && process.env.SORNE_LLM_BASE_URL.trim();
  const apiKey = process.env.SORNE_LLM_API_KEY && process.env.SORNE_LLM_API_KEY.trim();
  const model = process.env.SORNE_LLM_MODEL && process.env.SORNE_LLM_MODEL.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: apiKey || undefined, model, source: "env" };
}

/**
 * 连接测试（POST /sorne/settings/llm/test）：用给定配置向 base_url 发起真实
 * 最小 chat 请求（max_tokens=1，10s 超时）；返回 { ok, latency_ms, model } 或
 * { ok:false, error:{code,message}, latency_ms }。不落日志含 key。
 */
export async function testLlmConnection({ baseUrl, model, apiKey, timeoutMs = 10_000 }) {
  const started = Date.now();
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      // 401/403/404 等真实失败原因原样带回（不掩盖）；响应体截断防泄漏大 payload
      return {
        ok: false,
        error: { code: "LLM_HTTP_ERROR", message: `端点返回 HTTP ${res.status}：${text.slice(0, 400)}` },
        latency_ms: latency,
      };
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        error: { code: "LLM_BAD_RESPONSE", message: "端点响应不是合法 JSON" },
        latency_ms: latency,
      };
    }
    if (!json || !Array.isArray(json.choices) || !json.choices.length) {
      return {
        ok: false,
        error: { code: "LLM_BAD_RESPONSE", message: "端点响应缺少 choices（非 OpenAI 兼容 /chat/completions）" },
        latency_ms: latency,
      };
    }
    return { ok: true, latency_ms: latency, model };
  } catch (error) {
    const latency = Date.now() - started;
    const message =
      error && error.name === "AbortError"
        ? `连接超时（${timeoutMs}ms）`
        : `连接失败：${String(error?.message ?? error)}`;
    return { ok: false, error: { code: "LLM_UNREACHABLE", message }, latency_ms: latency };
  } finally {
    clearTimeout(timer);
  }
}
