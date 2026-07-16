import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtime } from "../src/index.js";
import { captureStdio, withTempDir } from "./helpers.js";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "test-key-body",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

async function prepareConfigSilently(options: Parameters<typeof runtime.ssh.prepareConfig>[0]) {
  const stdio = captureStdio();
  try {
    const config = await runtime.ssh.prepareConfig(options);
    return { config, stdout: stdio.stdout };
  } finally {
    stdio.restore();
  }
}

async function mode(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).mode & 0o777;
}

describe("runtime.ssh", () => {
  it("creates ssh directory, private key, and config with secure permissions", async () => {
    await withTempDir(async (home) => {
      const { config, stdout } = await prepareConfigSilently({
        home,
        hostAlias: "prod",
        hostName: "10.0.0.8",
        user: "deploy",
        port: 2202,
        proxyJump: "jump",
        privateKey: PRIVATE_KEY,
      });

      expect(config).toMatchObject({
        hostAlias: "prod",
        hostName: "10.0.0.8",
        user: "deploy",
        port: "2202",
        proxyJump: "jump",
        privateKeyPath: path.join(home, ".ssh", "id_rsa"),
        configPath: path.join(home, ".ssh", "config"),
        knownHostsPath: path.join(home, ".ssh", "known_hosts"),
        blockName: "agent-compose-runtime-sdk",
        strictHostKeyChecking: "accept-new",
      });
      expect(await mode(path.join(home, ".ssh"))).toBe(0o700);
      expect(await mode(config.privateKeyPath!)).toBe(0o600);
      expect(await mode(config.configPath)).toBe(0o600);
      expect(await fs.readFile(config.privateKeyPath!, "utf8")).toBe(PRIVATE_KEY);

      const sshConfig = await fs.readFile(config.configPath, "utf8");
      expect(sshConfig).toContain("# BEGIN agent-compose-runtime-sdk:prod\n");
      expect(sshConfig).toContain("Host prod\n");
      expect(sshConfig).toContain("  HostName 10.0.0.8\n");
      expect(sshConfig).toContain("  User deploy\n");
      expect(sshConfig).toContain("  Port 2202\n");
      expect(sshConfig).toContain("  ProxyJump jump\n");
      expect(sshConfig).toContain(`  IdentityFile ${config.privateKeyPath}\n`);
      expect(sshConfig).toContain("  IdentitiesOnly yes\n");
      expect(sshConfig).toContain(`  UserKnownHostsFile ${config.knownHostsPath}\n`);
      expect(sshConfig).toContain("  StrictHostKeyChecking accept-new\n");
      expect(sshConfig).toContain("# END agent-compose-runtime-sdk:prod\n");

      const log = JSON.parse(stdout);
      expect(log.message).toBe("SSH configured");
      expect(log.payload).toMatchObject({
        hostAlias: "prod",
        hostName: "10.0.0.8",
        user: "deploy",
        port: "2202",
        proxyJump: "jump",
        configPath: config.configPath,
        privateKeyConfigured: true,
      });
      expect(stdout).not.toContain("test-key-body");
    });
  });

  it("normalizes escaped newline private keys and custom key names", async () => {
    await withTempDir(async (home) => {
      const escaped = "'-----BEGIN OPENSSH PRIVATE KEY-----\\r\\nbody\\n-----END OPENSSH PRIVATE KEY-----'";
      const { config } = await prepareConfigSilently({
        home,
        hostAlias: "prod",
        hostName: "10.0.0.8",
        privateKeyName: "prod_key",
        privateKey: escaped,
      });

      expect(config.privateKeyPath).toBe(path.join(home, ".ssh", "prod_key"));
      expect(await fs.readFile(config.privateKeyPath!, "utf8")).toBe([
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "body",
        "-----END OPENSSH PRIVATE KEY-----",
        "",
      ].join("\n"));
    });
  });

  it("omits identity settings when no private key is provided", async () => {
    await withTempDir(async (home) => {
      const { config } = await prepareConfigSilently({
        home,
        hostAlias: "prod",
        hostName: "10.0.0.8",
      });

      expect(config.privateKeyPath).toBeUndefined();
      const sshConfig = await fs.readFile(config.configPath, "utf8");
      expect(sshConfig).not.toContain("IdentityFile");
      expect(sshConfig).not.toContain("IdentitiesOnly");
      await expect(fs.stat(path.join(home, ".ssh", "id_rsa"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses the current HOME environment variable when home is not provided", async () => {
    await withTempDir(async (home) => {
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const { config } = await prepareConfigSilently({
          hostAlias: "prod",
          hostName: "10.0.0.8",
        });

        expect(config.configPath).toBe(path.join(home, ".ssh", "config"));
        expect(await fs.readFile(config.configPath, "utf8")).toContain("Host prod\n");
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    });
  });

  it("replaces only the matching marker block and preserves unrelated config content", async () => {
    await withTempDir(async (home) => {
      const sshDir = path.join(home, ".ssh");
      const configPath = path.join(sshDir, "config");
      await fs.mkdir(sshDir, { recursive: true });
      await fs.writeFile(configPath, [
        "Host github.com",
        "  User git",
        "# BEGIN agent-compose-runtime-sdk:stage",
        "Host stage",
        "  HostName 10.0.0.7",
        "# END agent-compose-runtime-sdk:stage",
        "",
      ].join("\n"), "utf8");

      await prepareConfigSilently({
        home,
        hostAlias: "prod",
        hostName: "10.0.0.8",
      });
      await prepareConfigSilently({
        home,
        hostAlias: "prod",
        hostName: "10.0.0.9",
        user: "admin",
        strictHostKeyChecking: "yes",
      });

      const sshConfig = await fs.readFile(configPath, "utf8");
      expect(sshConfig).toContain("Host github.com\n  User git\n");
      expect(sshConfig).toContain("# BEGIN agent-compose-runtime-sdk:stage\nHost stage\n  HostName 10.0.0.7\n# END agent-compose-runtime-sdk:stage\n");
      expect(sshConfig).toContain("  HostName 10.0.0.9\n");
      expect(sshConfig).toContain("  User admin\n");
      expect(sshConfig).toContain("  StrictHostKeyChecking yes\n");
      expect(sshConfig).not.toContain("10.0.0.8");
      expect(sshConfig.match(/# BEGIN agent-compose-runtime-sdk:prod/g)).toHaveLength(1);
    });
  });

  it("rejects invalid values before writing config", async () => {
    await withTempDir(async (home) => {
      const cases: Array<[string, Parameters<typeof runtime.ssh.prepareConfig>[0], string]> = [
        ["empty hostAlias", { home, hostAlias: "", hostName: "10.0.0.8" }, "hostAlias is required"],
        ["empty hostName", { home, hostAlias: "prod", hostName: "" }, "hostName is required"],
        ["newline hostAlias", { home, hostAlias: "prod\nbad", hostName: "10.0.0.8" }, "hostAlias must not contain newline"],
        ["newline hostName", { home, hostAlias: "prod", hostName: "10.0.0.8\nbad" }, "hostName must not contain newline"],
        ["newline user", { home, hostAlias: "prod", hostName: "10.0.0.8", user: "root\nbad" }, "user must not contain newline"],
        ["newline proxyJump", { home, hostAlias: "prod", hostName: "10.0.0.8", proxyJump: "jump\nbad" }, "proxyJump must not contain newline"],
        ["newline privateKeyName", { home, hostAlias: "prod", hostName: "10.0.0.8", privateKeyName: "id\nrsa" }, "privateKeyName must not contain newline"],
        ["newline home", { home: `${home}\nbad`, hostAlias: "prod", hostName: "10.0.0.8" }, "home must not contain newline"],
        ["newline blockName", { home, hostAlias: "prod", hostName: "10.0.0.8", blockName: "runtime\nbad" }, "blockName must not contain newline"],
        ["non-numeric port", { home, hostAlias: "prod", hostName: "10.0.0.8", port: "22x" }, "port must be numeric"],
        ["path-like key name", { home, hostAlias: "prod", hostName: "10.0.0.8", privateKeyName: "../id_rsa" }, "privateKeyName must be a plain file name"],
        ["invalid strict mode", { home, hostAlias: "prod", hostName: "10.0.0.8", strictHostKeyChecking: "ask" as "yes" }, "strictHostKeyChecking must be"],
        ["invalid private key", { home, hostAlias: "prod", hostName: "10.0.0.8", privateKey: "not a key" }, "privateKey must contain PRIVATE KEY"],
      ];

      for (const [name, options, message] of cases) {
        await expect(runtime.ssh.prepareConfig(options), name).rejects.toThrow(message);
      }
    });
  });

  it("generates ssh and scp command options", () => {
    const config = {
      hostAlias: "prod",
      hostName: "10.0.0.8",
      user: "root",
      port: "22",
      configPath: "/tmp/ssh config/config's",
      knownHostsPath: "/tmp/known hosts",
      blockName: "agent-compose-runtime-sdk",
      strictHostKeyChecking: "no" as const,
    };

    const options = "-F '/tmp/ssh config/config'\\''s' -o 'UserKnownHostsFile=/tmp/known hosts' -o 'StrictHostKeyChecking=no'";
    expect(runtime.ssh.options(config)).toBe(options);
    expect(runtime.ssh.command(config)).toBe(`ssh ${options}`);
    expect(runtime.ssh.scpCommand(config)).toBe(`scp ${options}`);
  });
});
