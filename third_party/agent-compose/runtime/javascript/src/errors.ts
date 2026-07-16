import { inspect } from "node:util";

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return inspect(error, { depth: 8, breakLength: 120 });
  }
}
