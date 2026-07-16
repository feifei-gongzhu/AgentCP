import path from "node:path";
import { readText } from "./fs.js";
import { warn } from "./mpi.js";

const agentSystemPromptRelativePath = path.join("agents", "system-prompts", "system-prompt.txt"); // keep in sync with pkg/execution/agent_files.go

/** Convention path for agent identity under --state-root (MPI uses the same discovery pattern). */
export function agentSystemPromptPath(stateRoot: string): string {
  return path.join(stateRoot, agentSystemPromptRelativePath);
}

export function buildSystemContext(agentPrompt: string, mpiContext: string): string {
  const agent = agentPrompt.trim();
  if (!agent) {
    return mpiContext.trim() === "" ? "" : mpiContext;
  }

  const parts: string[] = ["## Agent Identity", "", agent];
  const mpi = mpiContext.trim();
  if (mpi) {
    parts.push("", mpi);
  }
  return parts.join("\n").trim();
}

export async function readSystemPromptFile(path?: string): Promise<string> {
  if (!path) {
    return "";
  }
  try {
    return (await readText(path)).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    warn(`could not read agent system prompt ${path}: ${(error as Error)?.message || error}`);
    return "";
  }
}
