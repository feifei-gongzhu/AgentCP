import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
  normalizeCommandRequest,
  readCommandRequest,
  runExecCommand,
} from "../src/command.js";
import { captureStdio, withTempSession } from "./helpers.js";

describe("runtime command execution", () => {
  it("runs exec args without shell expansion", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "console.log(process.argv[1])", "$HOME && echo injected"],
        artifactDir: path.join(root, "artifacts"),
      });

      const result = await runExecCommand({
        requestFile,
        workspace: root,
        home: path.join(root, "home"),
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("$HOME && echo injected\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(root, "artifacts", "stdout.txt"), "utf8")).toBe(result.stdout);
    });
  });

  it("runs shell scripts through bash -lc", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "shell",
        script: "echo shell:$RUNTIME_TEST_VALUE",
        env: { RUNTIME_TEST_VALUE: "works" },
        artifactDir: path.join(root, "artifacts"),
      });

      const result = await runExecCommand({ requestFile, workspace: root });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("shell:works\n");
    });
  });

  it("mirrors command stdout without adding a command echo", async () => {
    await withTempSession(async (root) => {
      const artifactDir = path.join(root, "artifacts");
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('raw-out')"],
        artifactDir,
      });
      const stdio = captureStdio();
      try {
        const result = await runExecCommand({ requestFile, workspace: root });
        expect(result.stdout).toBe("raw-out");
        expect(result.output).toBe("raw-out");
        expect(stdio.stdout).toBe("raw-out");
        expect(await fs.readFile(result.artifacts.stdout, "utf8")).toBe("raw-out");
        expect(await fs.readFile(result.artifacts.output, "utf8")).toBe("raw-out");
      } finally {
        stdio.restore();
      }
    });
  });

  it("injects runtime path environment into user commands", async () => {
    await withTempSession(async (root) => {
      const previousEnv = {
        HOME: process.env.HOME,
        SESSION_WORKSPACE: process.env.SESSION_WORKSPACE,
        ARTIFACT_DIR: process.env.ARTIFACT_DIR,
      };
      const workspace = path.join(root, "workspace");
      const stateRoot = path.join(root, "state");
      const artifactDir = path.join(root, "artifacts");
      await fs.mkdir(workspace, { recursive: true });
      process.env.HOME = "/native/home";
      delete process.env.SESSION_WORKSPACE;
      delete process.env.ARTIFACT_DIR;
      try {
        const requestFile = await writeRequest(root, {
          mode: "exec",
          command: "node",
          args: ["-e", [
            "const keys = ['WORKSPACE', 'SESSION_WORKSPACE', 'STATE_ROOT', 'RUNTIME_ROOT', 'ARTIFACT_DIR', 'HOME'];",
            "process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));",
          ].join(" ")],
          artifactDir,
        });

        const result = await runExecCommand({
          requestFile,
          workspace,
          stateRoot,
          home: path.join(root, "home"),
        });
        const env = JSON.parse(result.stdout);

        expect(env.WORKSPACE).toBe(workspace);
        expect(env.SESSION_WORKSPACE).toBeUndefined();
        expect(env.STATE_ROOT).toBe(stateRoot);
        expect(env.RUNTIME_ROOT).toBe(path.join(root, "runtime"));
        expect(env.ARTIFACT_DIR).toBeUndefined();
        expect(env.HOME).toBe("/native/home");
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  });

  it("lets request env override runtime path environment and provide per-command artifact/home values", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "shell",
        script: "printf '%s|%s|%s|%s' \"$WORKSPACE\" \"$STATE_ROOT\" \"$ARTIFACT_DIR\" \"$HOME\"",
        env: {
          WORKSPACE: "/override/workspace",
          STATE_ROOT: "/override/state",
          ARTIFACT_DIR: "/override/artifacts",
          HOME: "/override/home",
        },
        artifactDir: path.join(root, "artifacts"),
      });

      const result = await runExecCommand({
        requestFile,
        workspace: root,
        stateRoot: path.join(root, "state"),
        home: path.join(root, "home"),
      });

      expect(result.stdout).toBe("/override/workspace|/override/state|/override/artifacts|/override/home");
    });
  });

  it("captures stdout and stderr separately and as merged output", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
        artifactDir: path.join(root, "artifacts"),
      });

      const result = await runExecCommand({ requestFile, workspace: root });

      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
      expect(result.output).toContain("out");
      expect(result.output).toContain("err");
      expect(await fs.readFile(result.artifacts.stdout, "utf8")).toBe("out");
      expect(await fs.readFile(result.artifacts.stderr, "utf8")).toBe("err");
      expect(await fs.readFile(result.artifacts.output, "utf8")).toContain("out");
      expect(await fs.readFile(result.artifacts.output, "utf8")).toContain("err");
      const savedResult = JSON.parse(await fs.readFile(result.artifacts.result, "utf8"));
      expect(savedResult).toMatchObject({
        stdout: "out",
        stderr: "err",
        output: expect.stringContaining("out"),
        exitCode: 0,
        success: true,
      });
    });
  });

  it("mirrors child stdout and stderr to the runtime process streams", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('live-out'); process.stderr.write('live-err')"],
        artifactDir: path.join(root, "artifacts"),
      });

      let mirroredStdout = "";
      let mirroredStderr = "";
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        mirroredStdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        mirroredStderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        const result = await runExecCommand({ requestFile, workspace: root });
        expect(result.stdout).toBe("live-out");
        expect(result.stderr).toBe("live-err");
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      expect(mirroredStdout).toContain("live-out");
      expect(mirroredStderr).toContain("live-err");
    });
  });

  it("returns non-zero exit codes without throwing", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('before-fail\\n'); process.stderr.write('error-line\\n'); process.exit(7)"],
        artifactDir: path.join(root, "artifacts"),
      });

      const stdio = captureStdio();
      try {
        const result = await runExecCommand({ requestFile, workspace: root });
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(7);
        expect(result.stdout).toBe("before-fail\n");
        expect(result.stderr).toBe("error-line\n");
        expect(stdio.stderr).toContain("command exited with code 7");
        const savedResult = JSON.parse(await fs.readFile(result.artifacts.result, "utf8"));
        expect(savedResult).toMatchObject({
          stdout: "before-fail\n",
          stderr: "error-line\n",
          exitCode: 7,
          success: false,
        });
      } finally {
        stdio.restore();
      }
    });
  });

  it("terminates commands that exceed timeout", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 10000)"],
        timeoutMs: 25,
        artifactDir: path.join(root, "artifacts"),
      });

      await expect(runExecCommand({ requestFile, workspace: root })).rejects.toThrow("command timed out");
    });
  });

  it("truncates returned output while keeping full artifact files", async () => {
    await withTempSession(async (root) => {
      const requestFile = await writeRequest(root, {
        mode: "exec",
        command: "node",
        args: ["-e", "process.stdout.write('a'.repeat(12)); process.stderr.write('b'.repeat(9))"],
        maxOutputBytes: 5,
        artifactDir: path.join(root, "artifacts"),
      });

      const result = await runExecCommand({ requestFile, workspace: root });

      expect(result.stdout).toBe("aaaaa");
      expect(result.stderr).toBe("bbbbb");
      expect(result.output.length).toBe(5);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      expect(result.outputTruncated).toBe(true);
      expect(await fs.readFile(result.artifacts.stdout, "utf8")).toBe("a".repeat(12));
      expect(await fs.readFile(result.artifacts.stderr, "utf8")).toBe("b".repeat(9));
    });
  });

  it("writes request and result artifacts", async () => {
    await withTempSession(async (root) => {
      const artifactDir = path.join(root, "artifacts");
      const requestFile = await writeRequest(root, {
        mode: "shell",
        script: "echo ok",
        artifactDir,
      });

      const result = await runExecCommand({ requestFile, workspace: root });
      const savedRequest = JSON.parse(await fs.readFile(path.join(artifactDir, "command-request.json"), "utf8"));
      const savedResult = JSON.parse(await fs.readFile(path.join(artifactDir, "command-result.json"), "utf8"));

      expect(savedRequest.cwd).toBe(root);
      expect(savedResult.stdout).toBe("ok\n");
      expect(result.artifacts.request).toBe(path.join(artifactDir, "command-request.json"));
      expect(result.artifacts.result).toBe(path.join(artifactDir, "command-result.json"));
    });
  });

  it("normalizes defaults and rejects invalid requests", async () => {
    const previousEnv = {
      HOME: process.env.HOME,
      SESSION_WORKSPACE: process.env.SESSION_WORKSPACE,
      WORKSPACE: process.env.WORKSPACE,
      AGENT_COMPOSE_WORKSPACE: process.env.AGENT_COMPOSE_WORKSPACE,
      ARTIFACT_DIR: process.env.ARTIFACT_DIR,
    };
    try {
      delete process.env.HOME;
      delete process.env.AGENT_COMPOSE_WORKSPACE;
      process.env.SESSION_WORKSPACE = "/ignored/workspace";
      process.env.WORKSPACE = "/env/workspace";
      process.env.ARTIFACT_DIR = "/ignored/artifacts";
      const normalized = normalizeCommandRequest({ mode: "exec", command: "pwd" });
      expect(normalized.cwd).toBe("/env/workspace");
      expect(normalized.home).toBe("/root");
      expect(normalized.artifactDir).toBe("");
      expect(normalized.maxOutputBytes).toBe(DEFAULT_COMMAND_MAX_OUTPUT_BYTES);
      expect(normalized.stateRoot).toBe("/data/state");
      expect(normalized.runtimeRoot).toBe("/data/runtime");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    expect(() => normalizeCommandRequest({ mode: "exec" })).toThrow("command is required");
    expect(() => normalizeCommandRequest({ mode: "shell", script: "" })).toThrow("script is required");
    await withTempSession(async (root) => {
      const file = path.join(root, "bad.json");
      await fs.writeFile(file, "[]", "utf8");
      await expect(readCommandRequest(file)).rejects.toThrow("command request must be an object");
    });
  });
});

async function writeRequest(root: string, request: unknown): Promise<string> {
  const requestFile = path.join(root, "command-request.json");
  await fs.writeFile(requestFile, JSON.stringify(request), "utf8");
  return requestFile;
}
