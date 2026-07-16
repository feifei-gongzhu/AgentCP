package loaders

import (
	"context"
	"testing"

	domain "agent-compose/pkg/model"
)

// The loader sandbox-spawning APIs (scheduler.agent, scheduler.shell,
// scheduler.exec) accept a `jupyter: true` option that must reach the request
// struct so LoaderSandboxRunner.Ensure can enable Jupyter on the sandbox.
func TestLoaderJupyterOptionThreadsThroughRequests(t *testing.T) {
	run := func(t *testing.T, script string) *coverageEngineHost {
		t.Helper()
		host := &coverageEngineHost{state: map[string]string{}}
		if _, err := (&QJSLoaderEngine{}).Execute(context.Background(), LoaderExecutionRequest{
			Runtime: domain.LoaderRuntimeScheduler,
			Script:  script,
		}, host); err != nil {
			t.Fatalf("Execute returned error: %v", err)
		}
		return host
	}

	t.Run("scheduler.agent jupyter true", func(t *testing.T) {
		host := run(t, `function main() { scheduler.agent("p", { jupyter: true }); }`)
		if len(host.agentCalls) != 1 || !host.agentCalls[0].JupyterEnabled {
			t.Fatalf("expected agent request with JupyterEnabled=true, got %#v", host.agentCalls)
		}
	})

	t.Run("scheduler.shell jupyter true", func(t *testing.T) {
		host := run(t, `function main() { scheduler.shell("echo hi", { jupyter: true }); }`)
		if len(host.commandCalls) != 1 || !host.commandCalls[0].JupyterEnabled {
			t.Fatalf("expected command request with JupyterEnabled=true, got %#v", host.commandCalls)
		}
	})

	t.Run("scheduler.exec jupyter true", func(t *testing.T) {
		host := run(t, `function main() { scheduler.exec({ command: "python3", jupyter: true }); }`)
		if len(host.commandCalls) != 1 || !host.commandCalls[0].JupyterEnabled {
			t.Fatalf("expected exec request with JupyterEnabled=true, got %#v", host.commandCalls)
		}
	})

	t.Run("omitted jupyter defaults false", func(t *testing.T) {
		host := run(t, `function main() { scheduler.agent("p", {}); scheduler.shell("echo hi", {}); }`)
		if len(host.agentCalls) != 1 || host.agentCalls[0].JupyterEnabled {
			t.Fatalf("expected agent request with JupyterEnabled=false, got %#v", host.agentCalls)
		}
		if len(host.commandCalls) != 1 || host.commandCalls[0].JupyterEnabled {
			t.Fatalf("expected command request with JupyterEnabled=false, got %#v", host.commandCalls)
		}
	})
}
