function runWorkflow(input) {
  const context = input ?? {};
  const result = {
    source: context.source ?? "manual",
    receivedAt: new Date().toISOString(),
    payload: context.payload ?? null,
    topic: context.topic ?? "",
  };

  scheduler.log("workflow started", result);

  if (context.prompt) {
    const reply = scheduler.agent(context.prompt, {
      agent: "codex",
      sandboxPolicy: "sticky",
    });

    result.agent = {
      ok: reply.success,
      sandboxId: reply.sandboxId,
      cellId: reply.cellId,
      agent: reply.agent,
      agentThreadId: reply.agentThreadId,
      text: reply.finalText ?? reply.text ?? reply.output ?? "",
    };
  }

  scheduler.state.set("router:last-run", result);
  scheduler.log("workflow completed", result);
  return result;
}

function main(payload) {
  const input = payload ?? {};
  return runWorkflow({
    source: "manual",
    payload: input,
    prompt: input.prompt ?? "Give me a short operational summary for this manual run.",
  });
}

scheduler.timeout("boot", function boot() {
  return runWorkflow({
    source: "boot",
    payload: { boot: true },
  });
}, 1000);

scheduler.interval("health-check", function healthCheck() {
  return runWorkflow({
    source: "interval",
    payload: { check: "health" },
  });
}, 300000);

scheduler.on("agent-compose.agent.completed", "agent-completed", function onAgentCompleted(event) {
  return runWorkflow({
    source: "event",
    topic: event?.topic ?? "agent-compose.agent.completed",
    payload: event?.payload ?? event ?? null,
    prompt: "Summarize the completed agent event and highlight any follow-up.",
  });
});
