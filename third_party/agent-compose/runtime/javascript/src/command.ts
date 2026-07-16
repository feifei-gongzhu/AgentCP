import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeRootForStateRoot } from "./paths.js";

export const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RuntimeCommandRequest {
  mode: "exec" | "shell";
  command?: string;
  args?: string[];
  script?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  artifactDir?: string;
  home?: string;
  stateRoot?: string;
  runtimeRoot?: string;
}

export interface RuntimeCommandArtifacts {
  stdout: string;
  stderr: string;
  output: string;
  request: string;
  result: string;
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
  artifacts: RuntimeCommandArtifacts;
}

interface StreamCapture {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

interface RunProcessResult {
  stdout: StreamCapture;
  stderr: StreamCapture;
  output: StreamCapture;
  exitCode: number;
}

export interface RunRuntimeCommandOptions {
  request: RuntimeCommandRequest;
  artifactDir?: string;
  stateRoot?: string;
  workspace?: string;
  home?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
}

export async function runExecCommand(options: {
  requestFile: string;
  stateRoot?: string;
  workspace?: string;
  home?: string;
}): Promise<RuntimeCommandResult> {
  const requestPath = path.resolve(options.requestFile);
  const request = await readCommandRequest(requestPath);
  const artifactDir = path.resolve(request.artifactDir ?? path.dirname(requestPath));
  return runRuntimeCommand({
    request,
    artifactDir,
    stateRoot: options.stateRoot,
    workspace: options.workspace,
    home: options.home,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

export async function runRuntimeCommand(options: RunRuntimeCommandOptions): Promise<RuntimeCommandResult> {
  const artifactDir = path.resolve(options.artifactDir ?? options.request.artifactDir ?? process.cwd());
  await fsp.mkdir(artifactDir, { recursive: true });

  const normalizedRequest = normalizeCommandRequest(options.request, {
    artifactDir,
    stateRoot: options.stateRoot,
    workspace: options.workspace,
    home: options.home,
  });
  await writeJSON(path.join(artifactDir, "command-request.json"), normalizedRequest);

  const artifacts = {
    stdout: path.join(artifactDir, "stdout.txt"),
    stderr: path.join(artifactDir, "stderr.txt"),
    output: path.join(artifactDir, "output.txt"),
    request: path.join(artifactDir, "command-request.json"),
    result: path.join(artifactDir, "command-result.json"),
  };

  const processResult = await runProcess(normalizedRequest, artifacts, {
    stdout: options.stdout,
    stderr: options.stderr,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onOutput: options.onOutput,
  });
  const result: RuntimeCommandResult = {
    stdout: processResult.stdout.text,
    stderr: processResult.stderr.text,
    output: processResult.output.text,
    exitCode: processResult.exitCode,
    success: processResult.exitCode === 0,
    stdoutTruncated: processResult.stdout.truncated,
    stderrTruncated: processResult.stderr.truncated,
    outputTruncated: processResult.output.truncated,
    artifacts,
  };
  await writeJSON(artifacts.result, result);
  return result;
}

export async function readCommandRequest(requestFile: string): Promise<RuntimeCommandRequest> {
  const raw = await fsp.readFile(requestFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("command request must be an object");
  }
  return parsed as RuntimeCommandRequest;
}

export function normalizeCommandRequest(
  request: RuntimeCommandRequest,
  defaults: { artifactDir?: string; stateRoot?: string; workspace?: string; home?: string } = {},
): Required<Pick<RuntimeCommandRequest, "mode" | "cwd" | "env" | "maxOutputBytes" | "artifactDir" | "home" | "stateRoot" | "runtimeRoot">> & RuntimeCommandRequest {
  const mode = request.mode;
  if (mode !== "exec" && mode !== "shell") {
    throw new Error("command request mode must be exec or shell");
  }
  if (mode === "exec" && !request.command) {
    throw new Error("command is required");
  }
  if (mode === "shell" && !request.script) {
    throw new Error("script is required");
  }
  if (request.args !== undefined && !Array.isArray(request.args)) {
    throw new Error("command args must be an array");
  }
  if (request.env !== undefined && (!request.env || typeof request.env !== "object" || Array.isArray(request.env))) {
    throw new Error("command env must be an object");
  }

  const stateRoot = request.stateRoot || defaults.stateRoot || process.env.STATE_ROOT || process.env.AGENT_COMPOSE_STATE_ROOT || "/data/state";
  const runtimeRoot = request.runtimeRoot || process.env.RUNTIME_ROOT || process.env.AGENT_COMPOSE_RUNTIME_ROOT || runtimeRootForStateRoot(stateRoot);
  const home = request.home || defaults.home || process.env.HOME || "/root";
  return {
    ...request,
    mode,
    cwd: request.cwd || defaults.workspace || process.env.WORKSPACE || process.env.AGENT_COMPOSE_WORKSPACE || "/workspace",
    env: request.env ?? {},
    maxOutputBytes: normalizeMaxOutputBytes(request.maxOutputBytes),
    artifactDir: request.artifactDir || defaults.artifactDir || "",
    home,
    stateRoot,
    runtimeRoot,
  };
}

async function runProcess(
  request: ReturnType<typeof normalizeCommandRequest>,
  artifacts: Pick<RuntimeCommandArtifacts, "stdout" | "stderr" | "output">,
  options: Pick<RunRuntimeCommandOptions, "stdout" | "stderr" | "onStdout" | "onStderr" | "onOutput"> = {},
): Promise<RunProcessResult> {
  await Promise.all([
    fsp.mkdir(path.dirname(artifacts.stdout), { recursive: true }),
    fsp.mkdir(path.dirname(artifacts.stderr), { recursive: true }),
    fsp.mkdir(path.dirname(artifacts.output), { recursive: true }),
  ]);

  const stdoutFile = fs.createWriteStream(artifacts.stdout);
  const stderrFile = fs.createWriteStream(artifacts.stderr);
  const outputFile = fs.createWriteStream(artifacts.output);
  const stdoutCapture = createStreamCapture(request.maxOutputBytes);
  const stderrCapture = createStreamCapture(request.maxOutputBytes);
  const outputCapture = createStreamCapture(request.maxOutputBytes);

  const command = request.mode === "shell" ? "bash" : request.command ?? "";
  const args = request.mode === "shell" ? ["-lc", request.script ?? ""] : request.args ?? [];
  const child = spawn(command, args, {
    cwd: request.cwd,
    env: {
      ...process.env,
      WORKSPACE: request.cwd,
      STATE_ROOT: request.stateRoot,
      RUNTIME_ROOT: request.runtimeRoot,
      ...request.env,
    },
    shell: false,
  });

  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (request.timeoutMs && request.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, request.timeoutMs);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    options.stdout?.write(chunk);
    stdoutFile.write(chunk);
    outputFile.write(chunk);
    options.onStdout?.(chunk);
    options.onOutput?.(chunk, "stdout");
    appendCapture(stdoutCapture, chunk);
    appendCapture(outputCapture, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    options.stderr?.write(chunk);
    stderrFile.write(chunk);
    outputFile.write(chunk);
    options.onStderr?.(chunk);
    options.onOutput?.(chunk, "stderr");
    appendCapture(stderrCapture, chunk);
    appendCapture(outputCapture, chunk);
  });

  try {
    const exitCode = await waitForProcess(child);
    if (timedOut) {
      throw new Error(`command timed out after ${request.timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      options.stderr?.write(`command exited with code ${exitCode}\n`);
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
    await Promise.all([
      closeWritable(stdoutFile),
      closeWritable(stderrFile),
      closeWritable(outputFile),
    ]);
  }
}

function waitForProcess(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function createStreamCapture(limit: number) {
  return {
    limit,
    chunks: [] as Buffer[],
    totalBytes: 0,
    capturedBytes: 0,
    truncated: false,
  };
}

function appendCapture(capture: ReturnType<typeof createStreamCapture>, chunk: Buffer) {
  capture.totalBytes += chunk.length;
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

function finalizeCapture(capture: ReturnType<typeof createStreamCapture>): StreamCapture {
  return {
    text: Buffer.concat(capture.chunks).toString("utf8"),
    truncated: capture.truncated,
    totalBytes: capture.totalBytes,
  };
}

function closeWritable(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (!value || value < 1) {
    return DEFAULT_COMMAND_MAX_OUTPUT_BYTES;
  }
  return Math.floor(value);
}

async function writeJSON(filePath: string, value: unknown) {
  await fsp.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function modulePath(metaURL: string): string {
  return fileURLToPath(metaURL);
}
