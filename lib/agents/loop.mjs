/**
 * AI 半端 —— 通用工具调用代理循环内核（规范 §3.1/§3.2）。
 *
 * 合同：
 *   - 模型经 tools（JSON Schema）发起 tool_calls；程序执行工具并把结果回灌，
 *     直到模型给出最终答复（无 tool_calls）或达到 maxSteps（程序资源边界，
 *     §3.2：程序保障资源上限，不替 AI 判断探索策略）。
 *   - 工具执行错误**不终止循环**：把错误（含本工程错误信封的 code/message）
 *     作为工具结果回灌，让 AI 调整（§3.2「工具返回成功、冲突或受阻原因；
 *     AI 根据结果继续调整」）。
 *   - 每步的调用与结果进入 trace（调用方持久化或记日志，供审计）；
 *     stop_reason 记录终止原因（final / max_steps / provider_error）。
 *   - 工具目录按角色注入（lib/agents/*.mjs），本内核不感知任何业务语义。
 */

/** 单条工具消息（role=tool）构造；超长结果截断数据部分，保留分页控制字段。 */
const MAX_TOOL_RESULT_CHARS = 3000;
function toolResultMessage(toolCallId, name, payload) {
  let text;
  try {
    text = JSON.stringify(payload ?? null);
  } catch {
    text = String(payload);
  }
  if (text === undefined) text = "null";
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    // 优先保留分页/控制字段——截断 items/results 数组而非整个 JSON
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const { items, results, ...envelope } = payload;
      const dataKey = items ? "items" : results ? "results" : null;
      const dataArr = items || results;
      if (dataKey && Array.isArray(dataArr) && dataArr.length > 0) {
        let kept = dataArr;
        let compact;
        while (kept.length > 0) {
          compact = JSON.stringify({ ...envelope, [dataKey]: kept, _truncated: { original_count: dataArr.length, kept_count: kept.length } });
          if (compact.length <= MAX_TOOL_RESULT_CHARS) break;
          kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
        }
        if (compact && compact.length <= MAX_TOOL_RESULT_CHARS) {
          return { role: "tool", tool_call_id: toolCallId, name, content: compact };
        }
      }
    }
    const omitted = text.length - MAX_TOOL_RESULT_CHARS;
    text = text.slice(0, MAX_TOOL_RESULT_CHARS)
      + "…[工具结果超长已截断：" + omitted + " 字符未送入上下文；完整内容在持久记录/证据中，可用编号读取]";
  }
  return { role: "tool", tool_call_id: toolCallId, name, content: text };
}

/**
 * runAgentLoop({ model, system, tools, opening, maxSteps })
 *   - model：{ chat({system,messages,tools}) } 归一化提供方（lib/agents/model.mjs）。
 *   - tools：[{ name, description, parameters(JSON Schema), execute(args) → any }]。
 *   - opening：首条 user 消息内容（角色供给面，调用方构造）。
 * 返回 { stop_reason, steps, trace, final }：
 *   - trace 每项 { step, tool, args, ok, result | error:{code,message} , ms }；
 *   - final 为模型最终文本（stop_reason==="final" 时）。
 */
export async function runAgentLoop({
  model,
  system,
  tools,
  opening,
  maxSteps = 12,
  maxToolCallsPerStep = 4,
  role = "agent",
}) {
  if (!model || typeof model.chat !== "function") {
    throw new Error("runAgentLoop 需要模型提供方（model.chat）");
  }
  const catalog = new Map(tools.map((t) => [t.name, t]));
  const wireTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: "object", properties: {} },
    },
  }));

  const messages = [{ role: "user", content: opening }];
  const trace = [];
  let step = 0;
  let final = null;

  while (step < maxSteps) {
    step += 1;
    let reply;
    try {
      reply = await model.chat({ system, messages, tools: wireTools, tag: role });
    } catch (error) {
      return {
        stop_reason: "provider_error",
        steps: step,
        trace,
        final: null,
        error: { message: String(error?.message ?? error), kind: error?.providerErrorKind || "unknown" },
      };
    }
    const allCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
    messages.push({ role: "assistant", content: reply.content ?? "", tool_calls: allCalls });
    const calls = allCalls.slice(0, maxToolCallsPerStep);
    if (!allCalls.length) {
      final = typeof reply.content === "string" ? reply.content : "";
      return { stop_reason: "final", steps: step, trace, final, finish_reason: reply.finish_reason ?? null };
    }
    // P0：不得截断后留悬空 tool_call id——每个 id 必须有且仅有一条 tool 应答。
    // 超出每步上限的调用不执行，但如实回一条 tool 消息（RESOURCE_LIMIT），
    // 让模型知道「未执行」而不是误以为已完成/已失败（§3.2/§20.1 错误信封精神）。
    for (const dropped of allCalls.slice(maxToolCallsPerStep)) {
      const payload = {
        code: "RESOURCE_LIMIT",
        message: `本步工具调用数超过上限 ${maxToolCallsPerStep}：该调用未执行（既非已完成，也非已失败）`,
        retryable: true,
        next_requirements: [`把剩余调用拆到下一步重新发起（每步最多执行前 ${maxToolCallsPerStep} 个）`],
      };
      trace.push({ step, tool: dropped?.name ?? "", args: dropped?.arguments ?? {}, ok: false, skipped: true, error: payload, ms: 0 });
      messages.push(toolResultMessage(dropped?.id, dropped?.name ?? "", payload));
    }
    for (const call of calls) {
      const tool = catalog.get(call.name);
      const started = Date.now();
      if (!tool) {
        const error = { code: "BAD_REQUEST", message: `未知工具：${call.name}（允许：${[...catalog.keys()].join("、")}）` };
        trace.push({ step, tool: call.name, args: call.arguments, ok: false, error, ms: Date.now() - started });
        messages.push(toolResultMessage(call.id, call.name, { code: error.code, message: error.message }));
        continue;
      }
      try {
        const result = await tool.execute(call.arguments ?? {});
        trace.push({ step, tool: call.name, args: call.arguments ?? {}, ok: true, result, ms: Date.now() - started });
        messages.push(toolResultMessage(call.id, call.name, result ?? null));
      } catch (error) {
        const payload = error && typeof error === "object"
          ? { code: error.code || "INTERNAL_ERROR", message: String(error?.message ?? error) }
          : { code: "INTERNAL_ERROR", message: String(error) };
        trace.push({ step, tool: call.name, args: call.arguments ?? {}, ok: false, error: payload, ms: Date.now() - started });
        messages.push(toolResultMessage(call.id, call.name, payload));
      }
    }
  }
  return { stop_reason: "max_steps", steps: step, trace, final: null };
}

/** JSON Schema 常用片段（各角色工具目录复用）。 */
export const schemaHelpers = {
  string: (description) => ({ type: "string", description }),
  integer: (description) => ({ type: "integer", description }),
  stringArray: (description) => ({ type: "array", items: { type: "string" }, description }),
};

export const __test__ = { toolResultMessage };
