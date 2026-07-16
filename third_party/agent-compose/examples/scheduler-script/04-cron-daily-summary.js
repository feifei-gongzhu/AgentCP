function readDailyState() {
  return scheduler.state.get("daily-summary:last-run") ?? null;
}

function buildDailyPrompt(context) {
  return [
    "You are a scheduled agent-compose loader.",
    "Create a short daily status note and a focused action list.",
    "Keep it concise and operational.",
    "",
    "Context:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function runDailySummary(context) {
  const reply = scheduler.agent(buildDailyPrompt(context), {
    agent: "codex",
    sandboxPolicy: "new",
  });

  const result = {
    ok: reply.success,
    ranAt: new Date().toISOString(),
    sandboxId: reply.sandboxId,
    cellId: reply.cellId,
    agent: reply.agent,
    agentThreadId: reply.agentThreadId,
    text: reply.finalText ?? reply.text ?? reply.output ?? "",
    stopReason: reply.stopReason,
    previousRun: readDailyState(),
    context: context,
  };

  scheduler.state.set("daily-summary:last-run", {
    ranAt: result.ranAt,
    sandboxId: result.sandboxId,
    cellId: result.cellId,
  });

  scheduler.log("daily summary completed", result);
  return result;
}

function main(payload) {
  return runDailySummary({
    reason: "manual",
    input: payload ?? null,
  });
}

scheduler.cron("daily-summary", "0 9 * * *", function dailySummary() {
  return runDailySummary({
    reason: "cron",
    timezone: "Asia/Shanghai",
  });
}, { timezone: "Asia/Shanghai" });
