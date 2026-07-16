function readHeartbeatState() {
  return scheduler.state.get("heartbeat") ?? {
    count: 0,
    lastTickAt: "",
  };
}

function runHeartbeat() {
  const previous = readHeartbeatState();
  const snapshot = {
    count: Number(previous.count || 0) + 1,
    lastTickAt: new Date().toISOString(),
  };

  scheduler.state.set("heartbeat", snapshot);
  scheduler.log("heartbeat tick", snapshot);
  return snapshot;
}

function main(payload) {
  scheduler.log("heartbeat manual run", payload ?? null);
  return runHeartbeat();
}

scheduler.interval("heartbeat", function heartbeat() {
  return runHeartbeat();
}, 60000);
