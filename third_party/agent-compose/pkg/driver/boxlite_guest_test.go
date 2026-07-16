package driver

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNewJupyterReadyHTTPClientDisablesProxyFromEnvironment(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("http_proxy", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")

	client := newJupyterReadyHTTPClient(time.Second)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("jupyter ready client transport = %T, want *http.Transport", client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatalf("jupyter ready client should not use proxy environment")
	}
}

func TestBoxLiteExecDoesNotRunUserCommandWhenBootstrapFails(t *testing.T) {
	wantErr := errors.New("bootstrap failed")
	executed := false

	result, err := executeUserCommandAfterBootstrap(
		func() error {
			return wantErr
		},
		func() (ExecResult, error) {
			executed = true
			return ExecResult{ExitCode: 0, Success: true}, nil
		},
	)

	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	if executed {
		t.Fatalf("user command executed after bootstrap failure")
	}
	if result != (ExecResult{}) {
		t.Fatalf("result = %#v, want zero value", result)
	}
}

func TestBoxLiteExecRunsUserCommandAfterBootstrapSucceeds(t *testing.T) {
	executed := false

	result, err := executeUserCommandAfterBootstrap(
		func() error {
			return nil
		},
		func() (ExecResult, error) {
			executed = true
			return ExecResult{ExitCode: 0, Success: true, Stdout: "ok"}, nil
		},
	)

	if err != nil {
		t.Fatalf("executeUserCommandAfterBootstrap returned error: %v", err)
	}
	if !executed {
		t.Fatalf("user command was not executed after bootstrap success")
	}
	if result.Stdout != "ok" || !result.Success {
		t.Fatalf("result = %#v, want successful user command result", result)
	}
}

func TestBoxLiteBootstrapExecSpecRunsFromRoot(t *testing.T) {
	spec := directoryOnlyGuestSandboxBootstrapExecSpec(testRuntimeMountConfig())
	if spec.Command != "sh" {
		t.Fatalf("bootstrap command = %q, want sh", spec.Command)
	}
	if len(spec.Args) != 2 || spec.Args[0] != "-lc" {
		t.Fatalf("bootstrap args = %#v, want sh -lc script", spec.Args)
	}
	if strings.Contains(spec.Args[1], "mount --bind '/data/home' '/root'") {
		t.Fatalf("bootstrap script unexpectedly contains bind mount: %s", spec.Args[1])
	}
	if strings.Contains(spec.Args[1], "ln -s '/data/home' '/root'") {
		t.Fatalf("bootstrap script unexpectedly contains whole-root symlink: %s", spec.Args[1])
	}
	if !strings.Contains(spec.Args[1], "ln -sfn '/data/home/.codex' '/root/.codex'") {
		t.Fatalf("bootstrap script missing codex home symlink: %s", spec.Args[1])
	}
	if spec.Cwd != "/" {
		t.Fatalf("bootstrap cwd = %q, want /", spec.Cwd)
	}
}

func TestBoxLiteBootstrapErrorIncludesContextAndOutput(t *testing.T) {
	err := formatDirectoryOnlyGuestSandboxBootstrapError(
		RuntimeDriverBoxlite,
		"session-1",
		"box-1",
		ExecResult{ExitCode: 17, Stdout: "stdout detail\n", Stderr: "stderr detail\n"},
		nil,
	)
	message := err.Error()
	for _, required := range []string{
		"directory-only guest bootstrap failed",
		"driver=boxlite",
		"sandbox_id=session-1",
		"runtime_id=box-1",
		"exit_code=17",
		"stdout=\"stdout detail\"",
		"stderr=\"stderr detail\"",
	} {
		if !strings.Contains(message, required) {
			t.Fatalf("bootstrap error missing %q: %s", required, message)
		}
	}
}

func TestMicrosandboxBootstrapExecSpecRunsFromRoot(t *testing.T) {
	spec := directoryOnlyGuestSandboxBootstrapExecSpec(testRuntimeMountConfig())
	if spec.Command != "sh" {
		t.Fatalf("bootstrap command = %q, want sh", spec.Command)
	}
	if len(spec.Args) != 2 || spec.Args[0] != "-lc" {
		t.Fatalf("bootstrap args = %#v, want sh -lc script", spec.Args)
	}
	if strings.Contains(spec.Args[1], "mount --bind '/data/home' '/root'") {
		t.Fatalf("bootstrap script unexpectedly contains bind mount: %s", spec.Args[1])
	}
	if strings.Contains(spec.Args[1], "ln -s '/data/home' '/root'") {
		t.Fatalf("bootstrap script unexpectedly contains whole-root symlink: %s", spec.Args[1])
	}
	if !strings.Contains(spec.Args[1], "ln -sfn '/data/home/.gitconfig' '/root/.gitconfig'") {
		t.Fatalf("bootstrap script missing gitconfig home symlink: %s", spec.Args[1])
	}
	if spec.Cwd != "/" {
		t.Fatalf("bootstrap cwd = %q, want /", spec.Cwd)
	}
}

func TestMicrosandboxBootstrapErrorIncludesContextAndOutput(t *testing.T) {
	err := formatDirectoryOnlyGuestSandboxBootstrapError(
		RuntimeDriverMicrosandbox,
		"session-1",
		"sandbox-1",
		ExecResult{ExitCode: 23, Stdout: "stdout detail\n", Stderr: "stderr detail\n"},
		nil,
	)
	message := err.Error()
	for _, required := range []string{
		"directory-only guest bootstrap failed",
		"driver=microsandbox",
		"sandbox_id=session-1",
		"runtime_id=sandbox-1",
		"exit_code=23",
		"stdout=\"stdout detail\"",
		"stderr=\"stderr detail\"",
	} {
		if !strings.Contains(message, required) {
			t.Fatalf("bootstrap error missing %q: %s", required, message)
		}
	}
}

func TestMicrosandboxExecDoesNotRunUserCommandWhenBootstrapFails(t *testing.T) {
	wantErr := errors.New("bootstrap failed")
	executed := false

	result, err := executeUserCommandAfterBootstrap(
		func() error {
			return wantErr
		},
		func() (ExecResult, error) {
			executed = true
			return ExecResult{ExitCode: 0, Success: true}, nil
		},
	)

	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	if executed {
		t.Fatalf("user command executed after bootstrap failure")
	}
	if result != (ExecResult{}) {
		t.Fatalf("result = %#v, want zero value", result)
	}
}

func TestMicrosandboxExecRunsUserCommandAfterBootstrapSucceeds(t *testing.T) {
	executed := false

	result, err := executeUserCommandAfterBootstrap(
		func() error {
			return nil
		},
		func() (ExecResult, error) {
			executed = true
			return ExecResult{ExitCode: 0, Success: true, Stdout: "ok"}, nil
		},
	)

	if err != nil {
		t.Fatalf("executeUserCommandAfterBootstrap returned error: %v", err)
	}
	if !executed {
		t.Fatalf("user command was not executed after bootstrap success")
	}
	if result.Stdout != "ok" || !result.Success {
		t.Fatalf("result = %#v, want successful user command result", result)
	}
}
