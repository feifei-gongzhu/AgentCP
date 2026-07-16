package main

import (
	"os"
	"path/filepath"
	"testing"

	"agent-compose/pkg/compose"
)

func TestResolveCLIProjectEnvPrecedence(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, filepath.Join(projectDir, ".env.base"), "FROM_BASE=base\nSHARED=base\n")
	writeTestFile(t, filepath.Join(projectDir, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n")
	t.Setenv("SHARED", "process")

	values, err := resolveCLIProjectEnv(&compose.ProjectSpec{EnvFiles: compose.EnvFileSpec{".env.base", ".env.local"}}, composePath)
	if err != nil {
		t.Fatalf("resolveCLIProjectEnv returned error: %v", err)
	}
	for key, want := range map[string]string{
		"FROM_BASE":  "base",
		"FROM_LOCAL": "local",
		"SHARED":     "process",
	} {
		if got := values[key]; got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestResolveCLIProjectEnvProcessEmptyValueOverridesFile(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, filepath.Join(projectDir, ".env"), "CLI_PROJECT_EMPTY_OVERRIDE=file-value\n")
	t.Setenv("CLI_PROJECT_EMPTY_OVERRIDE", "")

	values, err := resolveCLIProjectEnv(&compose.ProjectSpec{}, composePath)
	if err != nil {
		t.Fatalf("resolveCLIProjectEnv returned error: %v", err)
	}
	value, ok := values["CLI_PROJECT_EMPTY_OVERRIDE"]
	if !ok || value != "" {
		t.Fatalf("CLI_PROJECT_EMPTY_OVERRIDE = %q, %v; want present empty value", value, ok)
	}
}

func TestResolveCLIProjectEnvAutoDiscovery(t *testing.T) {
	workingDir := t.TempDir()
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, filepath.Join(workingDir, ".env"), "SOURCE=working\n")

	values, err := resolveCLIProjectEnvFromDir(&compose.ProjectSpec{}, composePath, workingDir)
	if err != nil {
		t.Fatalf("resolve cwd env returned error: %v", err)
	}
	if got := values["SOURCE"]; got != "working" {
		t.Fatalf("SOURCE = %q, want working", got)
	}

	writeTestFile(t, filepath.Join(projectDir, ".env"), "SOURCE=project\n")
	values, err = resolveCLIProjectEnvFromDir(&compose.ProjectSpec{}, composePath, workingDir)
	if err != nil {
		t.Fatalf("resolve project env returned error: %v", err)
	}
	if got := values["SOURCE"]; got != "project" {
		t.Fatalf("SOURCE = %q, want project", got)
	}
}

func TestResolveCLIProjectEnvExplicitFileDisablesAutoDiscovery(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, filepath.Join(projectDir, ".env"), "AUTO=unexpected\n")
	writeTestFile(t, filepath.Join(projectDir, "custom.env"), "EXPLICIT=expected\n")

	values, err := resolveCLIProjectEnv(&compose.ProjectSpec{EnvFiles: compose.EnvFileSpec{"custom.env"}}, composePath)
	if err != nil {
		t.Fatalf("resolveCLIProjectEnv returned error: %v", err)
	}
	if got := values["EXPLICIT"]; got != "expected" {
		t.Fatalf("EXPLICIT = %q, want expected", got)
	}
	if _, ok := values["AUTO"]; ok {
		t.Fatalf("AUTO should not be loaded from project .env")
	}
}

func TestResolveCLIProjectEnvEmptyFileListDisablesAutoDiscovery(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, filepath.Join(projectDir, ".env"), "AUTO_EMPTY_LIST=unexpected\n")

	values, err := resolveCLIProjectEnv(&compose.ProjectSpec{EnvFiles: compose.EnvFileSpec{}}, composePath)
	if err != nil {
		t.Fatalf("resolveCLIProjectEnv returned error: %v", err)
	}
	if _, ok := values["AUTO_EMPTY_LIST"]; ok {
		t.Fatal("AUTO_EMPTY_LIST should not be loaded when env_file is an empty list")
	}
}

func TestLoadNormalizedComposeUsesProjectEnv(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yml")
	writeTestFile(t, composePath, "name: env-project\nagents:\n  reviewer:\n    provider: codex\n    model: ${PROJECT_MODEL}\n")
	writeTestFile(t, filepath.Join(projectDir, ".env"), "PROJECT_MODEL=gpt-from-project\n")

	_, normalized, err := loadNormalizedCompose(cliOptions{ComposeFile: composePath})
	if err != nil {
		t.Fatalf("loadNormalizedCompose returned error: %v", err)
	}
	if got := normalized.Agents[0].Model; got != "gpt-from-project" {
		t.Fatalf("model = %q, want gpt-from-project", got)
	}
}

func TestResolveCLIProjectEnvMissingExplicitFileFails(t *testing.T) {
	composePath := filepath.Join(t.TempDir(), "agent-compose.yml")
	_, err := resolveCLIProjectEnv(&compose.ProjectSpec{EnvFiles: compose.EnvFileSpec{"missing.env"}}, composePath)
	if err == nil {
		t.Fatal("resolveCLIProjectEnv returned nil error")
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
