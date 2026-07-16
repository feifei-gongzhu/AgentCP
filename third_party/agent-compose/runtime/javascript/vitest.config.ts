import { defineConfig } from "vitest/config";

const testShape = process.env.TEST_SHAPE ?? process.env.AGENT_COMPOSE_TEST_SHAPE ?? "all";
const includeByShape: Record<string, string[]> = {
  unit: ["test/**/*.test.ts"],
  integration: ["test/**/*.integration.test.ts", "test/runner-execution.test.ts", "test/runners.test.ts"],
  e2e: ["test/**/*.e2e.test.ts", "test/runner-execution.test.ts", "test/cli.test.ts"],
  all: ["test/**/*.test.ts"]
};
const excludeByShape: Record<string, string[]> = {
  unit: ["test/**/*.integration.test.ts", "test/**/*.e2e.test.ts"],
  integration: [],
  e2e: [],
  all: []
};
const coverageReportsDirectory = process.env.COVERAGE_DIR ?? process.env.AGENT_COMPOSE_COVERAGE_DIR ?? "coverage";

export default defineConfig({
  test: {
    include: includeByShape[testShape] ?? includeByShape.all,
    exclude: excludeByShape[testShape] ?? excludeByShape.all,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: coverageReportsDirectory,
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "src/index.ts"]
    }
  }
});
