import { spawnSync } from "node:child_process";
import process from "node:process";
import { isExecutable } from "./fs.js";

export function resolveCodexPath(): string {
  const envPath = String(process.env.CODEX_BIN || process.env.AGENT_COMPOSE_CODEX_BIN || "").trim();
  if (envPath && isExecutable(envPath)) {
    return envPath;
  }
  for (const candidate of ["/usr/bin/codex", "/usr/local/bin/codex"]) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  const probe = spawnSync("sh", ["-lc", "command -v codex || true"], {
    encoding: "utf8",
  });
  const fromPath = String(probe.stdout || "").trim();
  return fromPath || "codex";
}
