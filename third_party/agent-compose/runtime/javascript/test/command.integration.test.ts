import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExecCommand } from "../src/command.js";
import { withTempSession } from "./helpers.js";

describe("runtime command integration", () => {
  it("executes a request file and writes command artifacts", async () => {
    await withTempSession(async (root) => {
      const workspace = path.join(root, "workspace");
      const artifacts = path.join(root, "artifacts");
      const requestFile = path.join(root, "request.json");
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(requestFile, JSON.stringify({
        mode: "shell",
        script: "printf '%s' \"$TEST_MESSAGE\"",
        env: { TEST_MESSAGE: "integration-ok" },
        artifactDir: artifacts
      }));

      const result = await runExecCommand({ requestFile, workspace });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("integration-ok");
      await expect(fs.readFile(path.join(artifacts, "command-request.json"), "utf8")).resolves.toContain("TEST_MESSAGE");
      await expect(fs.readFile(path.join(artifacts, "command-result.json"), "utf8")).resolves.toContain("integration-ok");
    });
  });
});
