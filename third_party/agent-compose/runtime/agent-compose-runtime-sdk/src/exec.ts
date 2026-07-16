import { spawn } from "node:child_process";
import process from "node:process";
import { paths } from "./env.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RuntimeExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  rejectOnFailure?: boolean;
  /** @deprecated Use streamOutput instead. */
  forwardOutput?: boolean;
  streamOutput?: boolean;
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
  success: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputTruncated: boolean;
}

interface StreamCapture {
  text: string;
  truncated: boolean;
}

export interface ProcessResult {
  stdout: StreamCapture;
  stderr: StreamCapture;
  output: StreamCapture;
  exitCode: number;
}

interface ExecFailureDetails {
  command: string;
  args: string[];
  result: RuntimeCommandResult;
}

export class CommandError extends Error {
  command: string;
  args: string[];
  result: RuntimeCommandResult;

  constructor(message: string, details: ExecFailureDetails) {
    super(message);
    this.name = "CommandError";
    this.command = details.command;
    this.args = details.args;
    this.result = details.result;
  }
}

export async function exec(command: string, args: string[] = [], options: RuntimeExecOptions = {}): Promise<RuntimeCommandResult> {
  const result = toCommandResult(await runProcess(command, args, {
    cwd: options.cwd ?? paths.workspace,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    forwardStdout: options.streamOutput ?? options.forwardOutput ?? true,
    forwardStderr: options.streamOutput ?? options.forwardOutput ?? true,
  }));
  if (options.rejectOnFailure && !result.success) {
    throw new CommandError(`command failed with exit code ${result.exitCode}: ${command}`, { command, args, result });
  }
  return result;
}

export async function shell(script: string, options: RuntimeExecOptions = {}): Promise<RuntimeCommandResult> {
  const result = await exec("bash", ["-lc", script], options);
  if (options.rejectOnFailure && !result.success) {
    throw new CommandError(`shell command failed with exit code ${result.exitCode}`, { command: "bash", args: ["-lc", script], result });
  }
  return result;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    forwardStdout?: boolean;
    forwardStderr?: boolean;
  },
): Promise<ProcessResult> {
  const limit = normalizeMaxOutputBytes(options.maxOutputBytes);
  const stdoutCapture = createCapture(limit);
  const stderrCapture = createCapture(limit);
  const outputCapture = createCapture(limit);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      WORKSPACE: paths.workspace,
      STATE_ROOT: paths.stateRoot,
      RUNTIME_ROOT: paths.runtimeRoot,
      ...options.env,
    },
    shell: false,
  });

  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, options.timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (options.forwardStdout) {
      process.stdout.write(chunk);
    }
    appendCapture(stdoutCapture, chunk);
    appendCapture(outputCapture, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (options.forwardStderr) {
      process.stderr.write(chunk);
    }
    appendCapture(stderrCapture, chunk);
    appendCapture(outputCapture, chunk);
  });

  try {
    const exitCode = await waitForProcess(child);
    if (timedOut) {
      throw new Error(`command timed out after ${options.timeoutMs}ms`);
    }
    return {
      stdout: finalizeCapture(stdoutCapture),
      stderr: finalizeCapture(stderrCapture),
      output: finalizeCapture(outputCapture),
      exitCode,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toCommandResult(result: ProcessResult): RuntimeCommandResult {
  return {
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    output: result.output.text,
    exitCode: result.exitCode,
    success: result.exitCode === 0,
    stdoutTruncated: result.stdout.truncated,
    stderrTruncated: result.stderr.truncated,
    outputTruncated: result.output.truncated,
  };
}

function waitForProcess(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function createCapture(limit: number) {
  return {
    limit,
    chunks: [] as Buffer[],
    capturedBytes: 0,
    truncated: false,
  };
}

function appendCapture(capture: ReturnType<typeof createCapture>, chunk: Buffer) {
  if (capture.capturedBytes >= capture.limit) {
    capture.truncated = true;
    return;
  }
  const remaining = capture.limit - capture.capturedBytes;
  const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  capture.chunks.push(Buffer.from(selected));
  capture.capturedBytes += selected.length;
  if (chunk.length > remaining) {
    capture.truncated = true;
  }
}

function finalizeCapture(capture: ReturnType<typeof createCapture>): StreamCapture {
  return {
    text: Buffer.concat(capture.chunks).toString("utf8"),
    truncated: capture.truncated,
  };
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (!value || value < 1) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.floor(value);
}
