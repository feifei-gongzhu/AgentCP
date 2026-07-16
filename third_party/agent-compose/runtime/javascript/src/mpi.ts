import fs from "node:fs/promises";
import path from "node:path";
import { readText } from "./fs.js";
import { runtimeRootForStateRoot } from "./paths.js";

export interface MpiContext {
  runtimeRoot: string;
  context: string;
}

export function warn(message: string): void {
  process.stderr.write(`[agent-compose-runtime] warning: ${message}\n`);
}

export function formatMpiContext(catalogText: string, resourcesRoot: string): string {
  return [
    "## MPI Catalog",
    "",
    "The runtime provided the following Model Program Interface (MPI) catalog as high-priority context.",
    `Detailed MPI resource files are available under ${resourcesRoot}. Read them on demand when the catalog references them.`,
    "",
    catalogText.trimEnd(),
    "",
  ].join("\n");
}

export async function readMpiContext(stateRoot: string): Promise<MpiContext> {
  const runtimeRoot = runtimeRootForStateRoot(stateRoot);
  const mpiRoot = path.join(runtimeRoot, "mpi");
  const catalogPath = path.join(mpiRoot, "catalog.md");
  const resourcesRoot = path.join(mpiRoot, "resources");

  let stat;
  try {
    stat = await fs.stat(catalogPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { runtimeRoot, context: "" };
    }
    warn(`could not inspect MPI catalog ${catalogPath}: ${(error as Error)?.message || error}`);
    return { runtimeRoot, context: "" };
  }

  if (!stat.isFile()) {
    warn(`MPI catalog ${catalogPath} is not a regular file`);
    return { runtimeRoot, context: "" };
  }

  try {
    const catalogText = await readText(catalogPath);
    return { runtimeRoot, context: formatMpiContext(catalogText, resourcesRoot) };
  } catch (error) {
    warn(`could not read MPI catalog ${catalogPath}: ${(error as Error)?.message || error}`);
    return { runtimeRoot, context: "" };
  }
}
