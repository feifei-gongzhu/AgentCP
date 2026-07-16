import { describe, expect, it } from "vitest";
import { normalizeProvider } from "../src/provider.js";

describe("provider normalization", () => {
  it.each([
    ["codex", "codex"],
    ["CLAUDE", "claude"],
    ["claude-code", "claude"],
    ["claude_code", "claude"],
    ["gemini-cli", "gemini"],
    ["gemini_cli", "gemini"],
    ["opencode", "opencode"],
    ["open-code", "opencode"],
    ["open_code", "opencode"],
  ])("maps %j to %s", (input, expected) => {
    expect(normalizeProvider(input)).toBe(expected);
  });

  it("rejects unsupported providers", () => {
    expect(() => normalizeProvider("qwen")).toThrow(/unsupported provider "qwen"; expected one of: codex, claude, gemini, opencode/);
  });

  it.each([
    "",
    "   ",
    undefined,
    null,
  ])("rejects missing provider %j", (input) => {
    expect(() => normalizeProvider(input)).toThrow(/provider is required; expected one of: codex, claude, gemini, opencode/);
  });

  it("trims provider names before normalization", () => {
    expect(normalizeProvider(" Codex ")).toBe("codex");
  });
});
