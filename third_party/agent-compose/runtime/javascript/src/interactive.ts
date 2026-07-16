import { resolveCodexPath } from "./codex-path.js";
import { stringEnv } from "./env.js";
import { buildPromptRuntimeOptions } from "./prompt.js";
import { CodexRunner } from "./runners/codex.js";
import { readStoredThread, writeStoredThread } from "./session-state.js";
import type { TextWriter } from "./transcript.js";
import type { AgentResult, Provider, RunnerOptions } from "./types.js";

export interface InteractiveStartOptions {
  provider?: string;
  stateRoot?: string;
  workspace?: string;
  home?: string;
  model?: string;
  outputSchemaFile?: string;
}

export type EmitInteractiveFrame = (type: string, fields?: object) => void;

export class UnsupportedProviderError extends Error {
  readonly code = "unsupported_provider";

  constructor(readonly provider: Provider) {
    super(`interactive stream is not supported for provider ${provider}`);
    this.name = "UnsupportedProviderError";
  }
}

export class CodexInteractiveSession {
  private readonly runner: CodexRunner;
  private readonly writer: BufferedTextWriter;
  private readonly result: AgentResult;
  private turnCount = 0;
  private thread?: {
    id?: string | null;
    runStreamed(input: string, options?: unknown): Promise<{ events: AsyncIterable<unknown> }>;
  };

  constructor(
    private readonly options: RunnerOptions,
    private readonly emit: EmitInteractiveFrame,
  ) {
    this.writer = new BufferedTextWriter();
    this.runner = new CodexRunner(options, this.writer);
    this.result = {
      provider: "codex",
      threadId: "",
      stopReason: "completed",
      finalText: "",
      transcript: "",
      stderr: "",
    };
  }

  async start(): Promise<void> {
    const { Codex } = await import("@openai/codex-sdk");
    const stored = await readStoredThread(this.options.stateRoot, "codex");
    const codex = new Codex({
      codexPathOverride: resolveCodexPath(),
      env: stringEnv(),
      ...(this.options.systemContext
        ? { config: { developer_instructions: this.options.systemContext } }
        : {}),
    });
    this.thread = stored?.threadId
      ? codex.resumeThread(stored.threadId, this.runner.threadOptions())
      : codex.startThread(this.runner.threadOptions());
    const thread = this.thread;
    this.result.threadId = stored?.threadId || thread.id || "";
    this.emit("started", {
      provider: "codex",
      threadId: this.result.threadId,
    });
  }

  async runHumanMessage(message: string): Promise<void> {
    if (!this.thread) {
      throw new Error("stream has not been started");
    }
    if (this.turnCount > 0) {
      this.writer.beginTurn();
    }
    this.turnCount++;
    const { events } = await this.thread.runStreamed(
      message,
      this.options.outputSchema ? { outputSchema: this.options.outputSchema } : undefined,
    );
    for await (const event of events) {
      const sdkEvent = event as Record<string, unknown>;
      this.emit("agent_event", { event: sdkEvent });
      this.runner.handleEvent(sdkEvent, this.result);
    }
    this.result.threadId = this.thread.id || this.result.threadId;
    this.result.transcript = this.runner.transcript();
    if (!this.result.finalText && this.result.transcript) {
      this.result.finalText = this.result.transcript;
    }
    await writeStoredThread(this.options.stateRoot, "codex", this.result.threadId);
    this.emit("agent_turn_completed", {
      provider: "codex",
      threadId: this.result.threadId,
      finalText: this.result.finalText,
    });
  }

  async finish(stopReason: string): Promise<AgentResult> {
    this.result.stopReason = stopReason;
    this.result.threadId = this.thread?.id || this.result.threadId;
    this.result.transcript = this.runner.transcript();
    if (!this.result.finalText && this.result.transcript) {
      this.result.finalText = this.result.transcript;
    }
    if (this.result.threadId) {
      await writeStoredThread(this.options.stateRoot, "codex", this.result.threadId);
    }
    return { ...this.result };
  }
}

class BufferedTextWriter implements TextWriter {
  private readonly chunks: string[] = [];

  write(text: string): void {
    if (text) {
      this.chunks.push(text);
    }
  }

  line(text = ""): void {
    this.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  beginTurn(): void {
    if (this.chunks.length === 0) {
      return;
    }
    const last = this.chunks[this.chunks.length - 1] || "";
    if (!last.endsWith("\n")) {
      this.chunks.push("\n");
    }
  }

  transcript(): string {
    return this.chunks.join("").trimEnd();
  }
}

export async function createInteractiveSession(
  startOptions: InteractiveStartOptions,
  emit: EmitInteractiveFrame,
): Promise<CodexInteractiveSession> {
  const options = await buildPromptRuntimeOptions(startOptions);
  if (options.provider !== "codex") {
    throw new UnsupportedProviderError(options.provider);
  }
  const session = new CodexInteractiveSession(options, emit);
  await session.start();
  return session;
}
