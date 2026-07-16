package runs

import (
	"context"
	"errors"
	"testing"

	"agent-compose/pkg/capabilities"
	driverpkg "agent-compose/pkg/driver"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/sessions"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type recordingCapabilitySandboxIndexer struct {
	indexed []*domain.Sandbox
	revoked []string
}

func (i *recordingCapabilitySandboxIndexer) IndexSandbox(sandbox *domain.Sandbox) {
	i.indexed = append(i.indexed, sandbox)
}

func (i *recordingCapabilitySandboxIndexer) RevokeSandbox(sandboxID string) {
	i.revoked = append(i.revoked, sandboxID)
}

type projectRunRemovalStub struct {
	result sessions.RemovalResult
	err    error
}

func (s projectRunRemovalStub) Remove(context.Context, string, bool) (sessions.RemovalResult, error) {
	return s.result, s.err
}

func TestProjectRunCapabilityTokenLifecycle(t *testing.T) {
	t.Run("start and resume index only after running state reload", func(t *testing.T) {
		fixture := newControllerRunFixture(t)
		indexer := &recordingCapabilitySandboxIndexer{}
		fixture.controller.capTokens = indexer
		sandbox := newProjectRunCapabilitySandbox(t, fixture, domain.VMStatusStopped)

		if err := fixture.controller.startProjectRunSandbox(fixture.ctx, sandbox, "sandbox.resumed", "resumed"); err != nil {
			t.Fatalf("startProjectRunSandbox: %v", err)
		}
		if len(indexer.indexed) != 1 {
			t.Fatalf("indexed count = %d, want 1", len(indexer.indexed))
		}
		indexed := indexer.indexed[0]
		if indexed.Summary.VMStatus != domain.VMStatusRunning || capabilities.SandboxToken(indexed) == "" {
			t.Fatalf("indexed sandbox = %#v", indexed)
		}
		reloaded, err := fixture.store.GetSandbox(fixture.ctx, sandbox.Summary.ID)
		if err != nil {
			t.Fatalf("reload sandbox: %v", err)
		}
		if indexed.Summary.UpdatedAt != reloaded.Summary.UpdatedAt {
			t.Fatalf("indexed UpdatedAt = %v, reloaded = %v", indexed.Summary.UpdatedAt, reloaded.Summary.UpdatedAt)
		}
	})

	t.Run("start failure does not index", func(t *testing.T) {
		fixture := newControllerRunFixture(t)
		indexer := &recordingCapabilitySandboxIndexer{}
		fixture.controller.capTokens = indexer
		fixture.driver.startErr = errors.New("start failed")
		sandbox := newProjectRunCapabilitySandbox(t, fixture, domain.VMStatusStopped)

		if err := fixture.controller.startProjectRunSandbox(fixture.ctx, sandbox, "sandbox.resumed", "resumed"); !errors.Is(err, fixture.driver.startErr) {
			t.Fatalf("startProjectRunSandbox error = %v", err)
		}
		if len(indexer.indexed) != 0 || len(indexer.revoked) != 0 {
			t.Fatalf("index changes = indexed %d revoked %v", len(indexer.indexed), indexer.revoked)
		}
	})

	t.Run("stop success and already stopped revoke", func(t *testing.T) {
		for _, status := range []string{domain.VMStatusRunning, domain.VMStatusStopped} {
			t.Run(status, func(t *testing.T) {
				fixture := newControllerRunFixture(t)
				indexer := &recordingCapabilitySandboxIndexer{}
				fixture.controller.capTokens = indexer
				sandbox := newProjectRunCapabilitySandbox(t, fixture, status)

				if err := fixture.controller.stopProjectRunSandbox(fixture.ctx, sandbox); err != nil {
					t.Fatalf("stopProjectRunSandbox: %v", err)
				}
				if len(indexer.revoked) != 1 || indexer.revoked[0] != sandbox.Summary.ID {
					t.Fatalf("revoked = %v", indexer.revoked)
				}
			})
		}
	})

	t.Run("stop failure preserves index", func(t *testing.T) {
		fixture := newControllerRunFixture(t)
		indexer := &recordingCapabilitySandboxIndexer{}
		fixture.controller.capTokens = indexer
		fixture.driver.stopErr = errors.New("stop failed")
		sandbox := newProjectRunCapabilitySandbox(t, fixture, domain.VMStatusRunning)

		if err := fixture.controller.stopProjectRunSandbox(fixture.ctx, sandbox); !errors.Is(err, fixture.driver.stopErr) {
			t.Fatalf("stopProjectRunSandbox error = %v", err)
		}
		if len(indexer.revoked) != 0 {
			t.Fatalf("revoked = %v", indexer.revoked)
		}
	})

	t.Run("remove revokes only after confirmed removal", func(t *testing.T) {
		for _, tc := range []struct {
			name    string
			result  sessions.RemovalResult
			err     error
			wantRev bool
		}{
			{name: "success", result: sessions.RemovalResult{Removed: true}, wantRev: true},
			{name: "incomplete", result: sessions.RemovalResult{}},
			{name: "failure", err: errors.New("remove failed")},
		} {
			t.Run(tc.name, func(t *testing.T) {
				indexer := &recordingCapabilitySandboxIndexer{}
				controller := NewController(ControllerDependencies{CapTokens: indexer, Removal: projectRunRemovalStub{result: tc.result, err: tc.err}})
				sandbox := &domain.Sandbox{Summary: domain.SandboxSummary{ID: "sandbox-1"}}
				err := controller.cleanupProjectRunSandboxByPolicy(context.Background(), SandboxResult{Sandbox: sandbox, Created: true}, agentcomposev2.RunSandboxCleanupPolicy_RUN_SANDBOX_CLEANUP_POLICY_REMOVE_ON_COMPLETION)
				if !errors.Is(err, tc.err) {
					t.Fatalf("cleanup error = %v, want %v", err, tc.err)
				}
				if got := len(indexer.revoked) == 1; got != tc.wantRev {
					t.Fatalf("revoked = %v, wantRev = %v", indexer.revoked, tc.wantRev)
				}
			})
		}
	})

	t.Run("fallback remove revokes exactly once", func(t *testing.T) {
		fixture := newControllerRunFixture(t)
		indexer := &recordingCapabilitySandboxIndexer{}
		fixture.controller.capTokens = indexer
		sandbox := newProjectRunCapabilitySandbox(t, fixture, domain.VMStatusRunning)

		err := fixture.controller.cleanupProjectRunSandboxByPolicy(
			fixture.ctx,
			SandboxResult{Sandbox: sandbox, Created: true},
			agentcomposev2.RunSandboxCleanupPolicy_RUN_SANDBOX_CLEANUP_POLICY_REMOVE_ON_COMPLETION,
		)
		if err != nil {
			t.Fatalf("cleanupProjectRunSandboxByPolicy: %v", err)
		}
		if len(indexer.revoked) != 1 || indexer.revoked[0] != sandbox.Summary.ID {
			t.Fatalf("revoked = %v, want [%s]", indexer.revoked, sandbox.Summary.ID)
		}
		if _, err := fixture.store.GetSandbox(fixture.ctx, sandbox.Summary.ID); err == nil {
			t.Fatal("removed sandbox is still present")
		}
	})
}

func newProjectRunCapabilitySandbox(t *testing.T, fixture *controllerRunFixture, status string) *domain.Sandbox {
	t.Helper()
	sandbox, err := fixture.store.CreateSandbox(fixture.ctx, "project run", "", driverpkg.RuntimeDriverDocker, "guest:latest", "", domain.SandboxTypeManual, nil,
		[]domain.SandboxEnvVar{{Name: capabilities.SandboxTokenEnvName, Value: "token-1", Secret: true}},
		[]domain.SandboxTag{{Name: capabilities.CapsetTagName, Value: "capset-1"}},
	)
	if err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}
	sandbox.Summary.VMStatus = status
	if err := fixture.store.UpdateSandbox(fixture.ctx, sandbox); err != nil {
		t.Fatalf("UpdateSandbox: %v", err)
	}
	return sandbox
}
