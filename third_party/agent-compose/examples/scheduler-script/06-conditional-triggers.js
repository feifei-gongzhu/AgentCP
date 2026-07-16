const enableWarmup = true;
const enableHeartbeat = true;

function runWarmup() {
  const result = {
    step: "warmup",
    ranAt: new Date().toISOString(),
  };
  scheduler.log("warmup fired", result);
  return result;
}

function runHeartbeat() {
  const result = {
    step: "heartbeat",
    ranAt: new Date().toISOString(),
  };
  scheduler.log("conditional heartbeat fired", result);
  return result;
}

const warmupHandle = scheduler.timeout("warmup", function warmup() {
  return runWarmup();
}, 5000);

const heartbeatHandle = scheduler.interval("conditional-heartbeat", function conditionalHeartbeat() {
  return runHeartbeat();
}, 60000);

if (!enableWarmup) {
  scheduler.clearTimeout(warmupHandle);
}

if (!enableHeartbeat) {
  scheduler.clearInterval(heartbeatHandle);
}

function main(payload) {
  return {
    enableWarmup: enableWarmup,
    enableHeartbeat: enableHeartbeat,
    payload: payload ?? null,
  };
}
