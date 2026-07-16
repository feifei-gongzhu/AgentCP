import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { normalizeProvider } from "../src/provider.js";
import { runPromptCommand } from "../src/prompt.js";
import { CodexRunner } from "../src/runners/codex.js";
import { ClaudeRunner } from "../src/runners/claude.js";
import { appendDelta, TranscriptWriter } from "../src/transcript.js";
import { extractText, normalizeNewlines } from "../src/text.js";
import { captureStdio, runnerOptions, withTempSession } from "./helpers.js";

describe("runtime shape integration workflows", () => {
  it("covers provider, transcript, and runner option workflows", async () => {
    await withTempSession(async (root) => {
      expect(normalizeProvider(" claude-code ")).toBe("claude");
      expect(() => normalizeProvider("unknown")).toThrow(/unsupported provider/);

      const writer = new TranscriptWriter();
      const stdio = captureStdio();
      try {
        writer.write("a\r\n");
        writer.line("b");
      } finally {
        stdio.restore();
      }
      expect(writer.transcript()).toBe("a\nb");

      const cache = new Map<string, string>();
      const writes: string[] = [];
      appendDelta({ write: (text) => writes.push(text), line: (text = "") => writes.push(`${text}\n`) }, cache, "item", "hello");
      appendDelta({ write: (text) => writes.push(text), line: (text = "") => writes.push(`${text}\n`) }, cache, "item", "hello world");
      expect(writes).toEqual(["hello", " world"]);

      expect(normalizeNewlines("x\r\ny")).toBe("x\ny");
      expect(extractText([{ text: "a" }, { content: [{ text: "b" }] }])).toBe("ab");

      const codex = new CodexRunner(runnerOptions(root, "mpi context"));
      expect(codex.threadOptions()).toMatchObject({
        workingDirectory: path.join(root, "workspace"),
      });
      expect(codex.threadOptions()).not.toHaveProperty("config");

      const claude = new ClaudeRunner(runnerOptions(root, "mpi context", "claude"));
      expect(claude.queryOptions({ provider: "claude", threadId: "s1" })).toMatchObject({
        cwd: path.join(root, "workspace"),
        resume: "s1",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "mpi context",
        },
      });
    });
  });

  it("covers CLI and prompt file workflow", async () => {
    await withTempSession(async (root) => {
      const messageFile = path.join(root, "message.txt");
      await fs.writeFile(messageFile, "hello", "utf8");
      const runPrompt = vi.fn().mockResolvedValue({
          provider: "gemini",
          threadId: "shape-session",
          stopReason: "completed",
          finalText: "done",
          transcript: "done",
          stderr: "",
        });
      const geminiSpy = vi.spyOn(await import("../src/runners/gemini.js"), "GeminiRunner").mockImplementation(function mockGemini(this: unknown, options: unknown) {
        Object.assign(this as object, { options, runPrompt });
      } as never);
      const stdio = captureStdio();
      try {
        await createProgram({ exitOverride: true }).parseAsync([
          "node",
          "cli",
          "prompt",
          "--provider",
          "gemini",
          "--message-file",
          messageFile,
          "--state-root",
          path.join(root, "state"),
          "--workspace",
          path.join(root, "workspace"),
          "--home",
          path.join(root, "home"),
        ]);
        const result = await runPromptCommand({
          provider: "gemini",
          messageFile,
          stateRoot: path.join(root, "state"),
          workspace: path.join(root, "workspace"),
          home: path.join(root, "home"),
        });
        expect(result.threadId).toBe("shape-session");
      } finally {
        stdio.restore();
        geminiSpy.mockRestore();
      }

      expect(runPrompt).toHaveBeenCalledWith("hello");
    });
  });
});
