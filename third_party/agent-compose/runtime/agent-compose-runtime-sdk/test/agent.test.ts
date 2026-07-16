import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runtime } from "../src/index.js";
import { captureStdio, withTempDir } from "./helpers.js";

describe("runtime.agent", () => {
  it("calls agent-compose-runtime prompt with a message file, parses result payload, and forwards stderr", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      const workspace = path.join(root, "workspace");
      const state = path.join(root, "state");
      const home = path.join(root, "home");
      const callsFile = path.join(root, "calls.json");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const fakeRuntime = path.join(binDir, "agent-compose-runtime");
      await fs.writeFile(fakeRuntime, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const messageFile = args[args.indexOf('--message-file') + 1];",
        "const payload = { args, message: fs.readFileSync(messageFile, 'utf8') };",
        `fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(payload));`,
        "process.stderr.write('runtime progress\\n');",
        "process.stdout.write('__AGENT_RESULT__' + JSON.stringify({ provider: 'codex', threadId: 't1', stopReason: 'completed', finalText: 'done', transcript: 'trace', stderr: 'err' }) + '\\n');",
      ].join("\n"), "utf8");
      await fs.chmod(fakeRuntime, 0o755);

      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      const stdio = captureStdio();
      try {
        const result = await runtime.agent("deploy this", {
          provider: "codex",
          workspace,
          stateRoot: state,
          home,
          timeoutMs: 5000,
        });
        expect(result).toEqual({
          provider: "codex",
          threadId: "t1",
          stopReason: "completed",
          finalText: "done",
          json: null,
          transcript: "trace",
          stderr: "err",
        });
      } finally {
        stdio.restore();
        process.env.PATH = oldPath;
      }

      expect(stdio.stderr).toContain("runtime progress");
      const call = JSON.parse(await fs.readFile(callsFile, "utf8"));
      expect(call.message).toBe("deploy this");
      expect(call.args).toContain("prompt");
      expect(call.args).toContain("--provider");
      expect(call.args).toContain("codex");
      expect(call.args).toContain("--state-root");
      expect(call.args).toContain(state);
      await expect(fs.access(call.args[call.args.indexOf("--message-file") + 1])).rejects.toThrow();
    });
  });

  it("passes output schema files and parses structured JSON output", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      const workspace = path.join(root, "workspace");
      const callsFile = path.join(root, "calls.json");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const fakeRuntime = path.join(binDir, "agent-compose-runtime");
      await fs.writeFile(fakeRuntime, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const schemaFile = args[args.indexOf('--output-schema-file') + 1];",
        "const payload = { args, schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')) };",
        `fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(payload));`,
        "process.stdout.write('__AGENT_RESULT__' + JSON.stringify({ provider: 'codex', threadId: 't1', stopReason: 'completed', finalText: JSON.stringify({ summary: 'ok', risk: 'low' }), transcript: '{}', stderr: '' }) + '\\n');",
      ].join("\n"), "utf8");
      await fs.chmod(fakeRuntime, 0o755);

      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      try {
        const result = await runtime.agent<{ summary: string; risk: string }>("summarize", {
          workspace,
          outputSchema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              risk: { type: "string" },
            },
            required: ["summary", "risk"],
          },
        });

        expect(result.finalText).toBe("{\"summary\":\"ok\",\"risk\":\"low\"}");
        expect(result.json).toEqual({ summary: "ok", risk: "low" });
      } finally {
        process.env.PATH = oldPath;
      }

      const call = JSON.parse(await fs.readFile(callsFile, "utf8"));
      expect(call.args).toContain("--output-schema-file");
      expect(call.schema).toMatchObject({
        type: "object",
        required: ["summary", "risk"],
      });
      await expect(fs.access(call.args[call.args.indexOf("--output-schema-file") + 1])).rejects.toThrow();
    });
  });

  it("accepts Zod schemas, converts them to JSON Schema, and validates parsed output", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      const workspace = path.join(root, "workspace");
      const callsFile = path.join(root, "calls.json");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const fakeRuntime = path.join(binDir, "agent-compose-runtime");
      await fs.writeFile(fakeRuntime, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const schemaFile = args[args.indexOf('--output-schema-file') + 1];",
        "const payload = { schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')) };",
        `fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(payload));`,
        "process.stdout.write('__AGENT_RESULT__' + JSON.stringify({ finalText: JSON.stringify({ summary: 'ok', risk: 'high' }) }) + '\\n');",
      ].join("\n"), "utf8");
      await fs.chmod(fakeRuntime, 0o755);

      const outputSchema = z.object({
        summary: z.string(),
        risk: z.enum(["low", "high"]),
      });
      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      try {
        const result = await runtime.agent("summarize", {
          workspace,
          outputSchema,
        });

        expect(result.json?.risk).toBe("high");
      } finally {
        process.env.PATH = oldPath;
      }

      const call = JSON.parse(await fs.readFile(callsFile, "utf8"));
      expect(call.schema).toMatchObject({
        type: "object",
        properties: {
          summary: { type: "string" },
          risk: { type: "string", enum: ["low", "high"] },
        },
        required: ["summary", "risk"],
        additionalProperties: false,
      });
    });
  });

  it("throws when Zod schema validation rejects parsed JSON output", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      const workspace = path.join(root, "workspace");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const fakeRuntime = path.join(binDir, "agent-compose-runtime");
      await fs.writeFile(fakeRuntime, [
        "#!/usr/bin/env node",
        "process.stdout.write('__AGENT_RESULT__' + JSON.stringify({ finalText: JSON.stringify({ summary: 'ok', risk: 'medium' }) }) + '\\n');",
      ].join("\n"), "utf8");
      await fs.chmod(fakeRuntime, 0o755);

      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      try {
        await expect(runtime.agent("summarize", {
          workspace,
          outputSchema: z.object({
            summary: z.string(),
            risk: z.enum(["low", "high"]),
          }),
        })).rejects.toThrow("agent JSON output does not match outputSchema");
      } finally {
        process.env.PATH = oldPath;
      }
    });
  });

  it("throws when structured agent output is not valid JSON", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      const workspace = path.join(root, "workspace");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const fakeRuntime = path.join(binDir, "agent-compose-runtime");
      await fs.writeFile(fakeRuntime, [
        "#!/usr/bin/env node",
        "process.stdout.write('__AGENT_RESULT__' + JSON.stringify({ finalText: 'not json' }) + '\\n');",
      ].join("\n"), "utf8");
      await fs.chmod(fakeRuntime, 0o755);

      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      try {
        await expect(runtime.agent("summarize", {
          workspace,
          outputSchema: { type: "object" },
        })).rejects.toThrow("agent finalText is not valid JSON for outputSchema");
      } finally {
        process.env.PATH = oldPath;
      }
    });
  });
});
