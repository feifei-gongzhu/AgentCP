import process from "node:process";

export const DEFAULT_HOME = "/root";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_STATE_ROOT = "/data/state";
const DEFAULT_RUNTIME_ROOT = "/data/runtime";

export interface RuntimePaths {
  workspace: string;
  stateRoot: string;
  runtimeRoot: string;
  home: string;
}

export const paths: RuntimePaths = {
  workspace: envValue("WORKSPACE", "AGENT_COMPOSE_WORKSPACE", DEFAULT_WORKSPACE),
  stateRoot: envValue("STATE_ROOT", "AGENT_COMPOSE_STATE_ROOT", DEFAULT_STATE_ROOT),
  runtimeRoot: envValue("RUNTIME_ROOT", "AGENT_COMPOSE_RUNTIME_ROOT", DEFAULT_RUNTIME_ROOT),
  home: envValue("HOME", DEFAULT_HOME),
};

export const env = {
  get(name: string): string | undefined {
    return process.env[name];
  },

  require(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`required environment variable ${name} is missing`);
    }
    return value;
  },

  all(): Record<string, string> {
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  },
};

export function envValue(name: string, fallback: string): string;
export function envValue(name: string, legacyName: string, fallback: string): string;
export function envValue(name: string, legacyNameOrFallback: string, fallback?: string): string {
  const legacyName = fallback === undefined ? "" : legacyNameOrFallback;
  const defaultValue = fallback === undefined ? legacyNameOrFallback : fallback;
  return optionalEnvValue(name) ?? (legacyName ? optionalEnvValue(legacyName) : undefined) ?? defaultValue;
}

export function optionalEnvValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}
