import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HOME, envValue } from "./env.js";
import { log } from "./log.js";

export interface RuntimeSshPrepareOptions {
  hostAlias: string;
  hostName: string;
  user?: string;
  port?: string | number;
  proxyJump?: string;
  privateKey?: string;
  privateKeyName?: string;
  home?: string;
  blockName?: string;
  strictHostKeyChecking?: "accept-new" | "yes" | "no";
}

export interface RuntimeSshConfig {
  hostAlias: string;
  hostName: string;
  user: string;
  port: string;
  proxyJump?: string;
  privateKeyPath?: string;
  configPath: string;
  knownHostsPath: string;
  blockName: string;
  strictHostKeyChecking: "accept-new" | "yes" | "no";
}

export const ssh = {
  async prepareConfig(options: RuntimeSshPrepareOptions): Promise<RuntimeSshConfig> {
    const normalized = normalizeSshPrepareOptions(options);
    const sshDir = path.join(normalized.home, ".ssh");
    const configPath = path.join(sshDir, "config");
    const knownHostsPath = path.join(sshDir, "known_hosts");
    let privateKeyPath: string | undefined;

    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(sshDir, 0o700);

    if (normalized.privateKey !== undefined) {
      privateKeyPath = path.join(sshDir, normalized.privateKeyName);
      await fsp.writeFile(privateKeyPath, normalized.privateKey, { encoding: "utf8", mode: 0o600 });
      await fsp.chmod(privateKeyPath, 0o600);
    }

    const config: RuntimeSshConfig = {
      hostAlias: normalized.hostAlias,
      hostName: normalized.hostName,
      user: normalized.user,
      port: normalized.port,
      ...(normalized.proxyJump ? { proxyJump: normalized.proxyJump } : {}),
      ...(privateKeyPath ? { privateKeyPath } : {}),
      configPath,
      knownHostsPath,
      blockName: normalized.blockName,
      strictHostKeyChecking: normalized.strictHostKeyChecking,
    };

    await writeSshConfigBlock(config);
    log("SSH configured", {
      hostAlias: config.hostAlias,
      hostName: config.hostName,
      user: config.user,
      port: config.port,
      proxyJump: config.proxyJump,
      configPath: config.configPath,
      privateKeyConfigured: Boolean(config.privateKeyPath),
    });
    return config;
  },

  command(config: RuntimeSshConfig): string {
    return `ssh ${ssh.options(config)}`;
  },

  scpCommand(config: RuntimeSshConfig): string {
    return `scp ${ssh.options(config)}`;
  },

  options(config: RuntimeSshConfig): string {
    return [
      "-F",
      quoteShell(config.configPath),
      "-o",
      quoteShell(`UserKnownHostsFile=${config.knownHostsPath}`),
      "-o",
      quoteShell(`StrictHostKeyChecking=${config.strictHostKeyChecking}`),
    ].join(" ");
  },
};

function normalizeSshPrepareOptions(options: RuntimeSshPrepareOptions): RuntimeSshPrepareOptions & {
  hostAlias: string;
  hostName: string;
  user: string;
  port: string;
  privateKeyName: string;
  home: string;
  blockName: string;
  strictHostKeyChecking: "accept-new" | "yes" | "no";
} {
  const hostAlias = requiredSshScalar("hostAlias", options.hostAlias);
  const hostName = requiredSshScalar("hostName", options.hostName);
  const user = optionalSshScalar("user", options.user) ?? "root";
  const port = normalizeSshPort(options.port ?? "22");
  const proxyJump = optionalSshScalar("proxyJump", options.proxyJump);
  const privateKeyName = optionalSshScalar("privateKeyName", options.privateKeyName) ?? "id_rsa";
  const home = optionalSshScalar("home", options.home) ?? envValue("HOME", DEFAULT_HOME);
  const blockName = optionalSshScalar("blockName", options.blockName) ?? "agent-compose-runtime-sdk";
  const strictHostKeyChecking = normalizeStrictHostKeyChecking(options.strictHostKeyChecking ?? "accept-new");
  if (path.basename(privateKeyName) !== privateKeyName || privateKeyName === "." || privateKeyName === "..") {
    throw new Error("privateKeyName must be a plain file name");
  }
  const privateKey = options.privateKey === undefined ? undefined : normalizePrivateKey(options.privateKey);
  return {
    ...options,
    hostAlias,
    hostName,
    user,
    port,
    ...(proxyJump ? { proxyJump } : {}),
    ...(privateKey ? { privateKey } : {}),
    privateKeyName,
    home,
    blockName,
    strictHostKeyChecking,
  };
}

function requiredSshScalar(name: string, value: string): string {
  const normalized = optionalSshScalar(name, value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function optionalSshScalar(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain newline characters`);
  }
  return value.trim();
}

function normalizeSshPort(value: string | number): string {
  const port = String(value).trim();
  if (!/^\d+$/.test(port)) {
    throw new Error("port must be numeric");
  }
  return port;
}

function normalizeStrictHostKeyChecking(value: string): "accept-new" | "yes" | "no" {
  if (value === "accept-new" || value === "yes" || value === "no") {
    return value;
  }
  throw new Error("strictHostKeyChecking must be accept-new, yes, or no");
}

function normalizePrivateKey(value: string): string {
  let key = value.trim();
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith("\"") && key.endsWith("\""))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  if (!key.includes("PRIVATE KEY")) {
    throw new Error("privateKey must contain PRIVATE KEY");
  }
  return key.endsWith("\n") ? key : `${key}\n`;
}

async function writeSshConfigBlock(config: RuntimeSshConfig): Promise<void> {
  const block = sshConfigBlock(config);
  const existing = await fsp.readFile(config.configPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const begin = markerLine("BEGIN", config);
  const end = markerLine("END", config);
  const markerPattern = new RegExp(`${escapeRegExp(begin)}\\n[\\s\\S]*?\\n${escapeRegExp(end)}(?:\\n|$)`);
  const replacement = `${block}\n`;
  const next = markerPattern.test(existing)
    ? existing.replace(markerPattern, replacement)
    : appendConfigBlock(existing, replacement);
  await fsp.writeFile(config.configPath, next, { encoding: "utf8", mode: 0o600 });
  await fsp.chmod(config.configPath, 0o600);
}

function sshConfigBlock(config: RuntimeSshConfig): string {
  const lines = [
    markerLine("BEGIN", config),
    `Host ${config.hostAlias}`,
    `  HostName ${config.hostName}`,
    `  User ${config.user}`,
    `  Port ${config.port}`,
  ];
  if (config.proxyJump) {
    lines.push(`  ProxyJump ${config.proxyJump}`);
  }
  if (config.privateKeyPath) {
    lines.push(`  IdentityFile ${config.privateKeyPath}`);
    lines.push("  IdentitiesOnly yes");
  }
  lines.push(`  UserKnownHostsFile ${config.knownHostsPath}`);
  lines.push(`  StrictHostKeyChecking ${config.strictHostKeyChecking}`);
  lines.push(markerLine("END", config));
  return lines.join("\n");
}

function markerLine(kind: "BEGIN" | "END", config: RuntimeSshConfig): string {
  return `# ${kind} ${config.blockName}:${config.hostAlias}`;
}

function appendConfigBlock(existing: string, block: string): string {
  if (!existing) {
    return block;
  }
  return existing.endsWith("\n") ? `${existing}${block}` : `${existing}\n${block}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
