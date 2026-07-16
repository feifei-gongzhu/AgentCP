import process from "node:process";

export function log(message: string, payload?: unknown): void {
  process.stdout.write(JSON.stringify({
    type: "agent-compose.runtime.log",
    message,
    payload: payload ?? {},
    createdAt: new Date().toISOString(),
  }) + "\n");
}
