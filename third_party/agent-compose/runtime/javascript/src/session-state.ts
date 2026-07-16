import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, readText } from "./fs.js";
import type { Provider, StoredThread } from "./types.js";

export function providerStatePath(stateRoot: string, provider: Provider): string {
  return path.join(stateRoot, "agents", "providers", `${provider}.json`);
}

export async function readStoredThread(stateRoot: string, provider: Provider): Promise<StoredThread | null> {
  try {
    const raw = await readText(providerStatePath(stateRoot, provider));
    const payload = JSON.parse(raw);
    if (typeof payload?.threadId === "string") {
      return payload;
    }
    if (typeof payload?.sessionId === "string") {
      return { ...payload, threadId: payload.sessionId };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeStoredThread(
  stateRoot: string,
  provider: Provider,
  threadId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!threadId) {
    return;
  }
  const target = providerStatePath(stateRoot, provider);
  await ensureDir(path.dirname(target));
  const payload = {
    provider,
    threadId,
    updatedAt: now.toISOString(),
  };
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
