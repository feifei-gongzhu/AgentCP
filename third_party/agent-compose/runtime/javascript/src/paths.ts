import path from "node:path";

export function runtimeRootForStateRoot(stateRoot: string): string {
  return path.join(path.dirname(path.resolve(stateRoot)), "runtime");
}

export function uniqueDirectories(paths: Array<string | undefined | null>): string[] {
  return [...new Set(paths.filter((entry): entry is string => Boolean(entry)))];
}
