function buildEventPrompt(event) {
  return [
    "You are an automation helper running inside a agent-compose loader.",
    "Read the event JSON below and produce:",
    "1. A one line summary.",
    "2. A short next-step recommendation.",
    "3. Any obvious risk or follow-up.",
    "",
    JSON.stringify(event ?? {}, null, 2),
  ].join("\n");
}

function handleEvent(event) {
  const envelope = {
    topic: event?.topic ?? "manual",
    createdAt: event?.createdAt ?? new Date().toISOString(),
    payload: event?.payload ?? event ?? null,
  };

  scheduler.log("processing loader event", {
    topic: envelope.topic,
    createdAt: envelope.createdAt,
  });

  const reply = scheduler.agent(buildEventPrompt(envelope), {
    agent: "codex",
    sandboxPolicy: "sticky",
  });

  const result = {
    ok: reply.success,
    topic: envelope.topic,
    sandboxId: reply.sandboxId,
    cellId: reply.cellId,
    agent: reply.agent,
    agentThreadId: reply.agentThreadId,
    text: reply.finalText ?? reply.text ?? reply.output ?? "",
    stopReason: reply.stopReason,
  };

  scheduler.log("event handled by agent", result);
  return result;
}

function main(payload) {
  return handleEvent(payload);
}

scheduler.on("agent-compose.session.created", "on-session-created", function onSessionCreated(event) {
  return handleEvent(event);
});
