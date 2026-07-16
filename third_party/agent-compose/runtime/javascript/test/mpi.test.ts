import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatMpiContext, readMpiContext } from "../src/mpi.js";
import { runtimeRootForStateRoot } from "../src/paths.js";
import { captureStdio, withTempSession } from "./helpers.js";

describe("MPI context", () => {
  it("derives the runtime root as a sibling of state", () => {
    expect(runtimeRootForStateRoot("/data/state")).toBe("/data/runtime");
    expect(runtimeRootForStateRoot("/tmp/session/state")).toBe("/tmp/session/runtime");
  });

  it("returns empty context when catalog is absent", async () => {
    await withTempSession(async (root) => {
      const stateRoot = path.join(root, "state");
      await fs.mkdir(stateRoot, { recursive: true });

      const mpi = await readMpiContext(stateRoot);

      expect(mpi.runtimeRoot).toBe(path.join(root, "runtime"));
      expect(mpi.context).toBe("");
    });
  });

  it("formats catalog content with the resources path", () => {
    const context = formatMpiContext("# Tools\n", "/data/runtime/mpi/resources");

    expect(context).toContain("## MPI Catalog");
    expect(context).toContain("/data/runtime/mpi/resources");
    expect(context).toContain("# Tools");
  });

  it("includes catalog content and resources path", async () => {
    await withTempSession(async (root) => {
      const stateRoot = path.join(root, "state");
      const mpiRoot = path.join(root, "runtime", "mpi");
      await fs.mkdir(mpiRoot, { recursive: true });
      await fs.writeFile(path.join(mpiRoot, "catalog.md"), "# Tools\n\n- read resources/search.md\n", "utf8");

      const mpi = await readMpiContext(stateRoot);

      expect(mpi.context).toContain("## MPI Catalog");
      expect(mpi.context).toContain("# Tools");
      expect(mpi.context).toContain(path.join(root, "runtime", "mpi", "resources"));
    });
  });

  it("warns and continues when catalog is not a file", async () => {
    await withTempSession(async (root) => {
      const stateRoot = path.join(root, "state");
      const catalogPath = path.join(root, "runtime", "mpi", "catalog.md");
      await fs.mkdir(catalogPath, { recursive: true });
      const stdio = captureStdio();
      try {
        const mpi = await readMpiContext(stateRoot);
        expect(mpi.context).toBe("");
      } finally {
        stdio.restore();
      }

      expect(stdio.stderr).toMatch(/warning: MPI catalog .* is not a regular file/);
    });
  });

  it("warns and continues when catalog cannot be read", async () => {
    await withTempSession(async (root) => {
      const stateRoot = path.join(root, "state");
      const catalogPath = path.join(root, "runtime", "mpi", "catalog.md");
      await fs.mkdir(path.dirname(catalogPath), { recursive: true });
      await fs.writeFile(catalogPath, "secret", "utf8");
      await fs.chmod(catalogPath, 0o000);
      const stdio = captureStdio();
      try {
        const mpi = await readMpiContext(stateRoot);
        if (process.getuid?.() === 0) {
          expect(mpi.context).toContain("secret");
        } else {
          expect(mpi.context).toBe("");
          expect(stdio.stderr).toMatch(/warning: could not read MPI catalog/);
        }
      } finally {
        await fs.chmod(catalogPath, 0o644);
        stdio.restore();
      }
    });
  });
});
