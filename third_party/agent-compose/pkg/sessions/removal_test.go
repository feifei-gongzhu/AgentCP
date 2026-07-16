package sessions_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "agent-compose/pkg/config"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/sessions"
	"agent-compose/pkg/storage/sessionstore"
)

func TestRemovalCoordinatorPersistsAndResumesStages(t *testing.T) {
	root := t.TempDir()
	sandbox := removalTestSandbox(t, root, "sandbox-stage", domain.VMStatusRunning, time.Now().Add(-time.Hour))
	store := &removalTestStore{sandboxes: map[string]*domain.Sandbox{sandbox.Summary.ID: sandbox}}
	runtime := &removalTestRuntime{removeErrors: []error{errors.New("injected remove failure")}}
	coordinator := &sessions.RemovalCoordinator{SandboxRoot: root, Store: store, Runtime: runtime}

	if _, err := coordinator.Remove(context.Background(), sandbox.Summary.ID, false); !errors.Is(err, sessions.ErrSandboxRunning) {
		t.Fatalf("Remove running without force error = %v", err)
	}
	if _, err := coordinator.Remove(context.Background(), sandbox.Summary.ID, true); err == nil {
		t.Fatal("Remove returned nil for injected runtime failure")
	}
	record, err := sessions.ReadOwnershipRecord(root, sandbox.Summary.ID)
	if err != nil {
		t.Fatalf("ReadOwnershipRecord: %v", err)
	}
	if record.LifecycleState != "deleting" || !record.StageCompleted(sessions.DeletionStageRuntimeStop) || record.StageCompleted(sessions.DeletionStageRuntime) {
		t.Fatalf("record after failure = %#v", record)
	}
	if store.sandboxes[sandbox.Summary.ID].Summary.VMStatus != domain.VMStatusDeleting {
		t.Fatalf("sandbox status = %q", store.sandboxes[sandbox.Summary.ID].Summary.VMStatus)
	}

	result, err := coordinator.Remove(context.Background(), sandbox.Summary.ID, true)
	if err != nil || !result.Removed || !result.Stopped {
		t.Fatalf("resumed Remove result=%#v err=%v", result, err)
	}
	if runtime.stopCalls != 1 || runtime.removeCalls != 2 || store.removeCalls != 1 {
		t.Fatalf("calls stop/remove/store = %d/%d/%d", runtime.stopCalls, runtime.removeCalls, store.removeCalls)
	}
	if _, err := sessions.ReadOwnershipRecord(root, sandbox.Summary.ID); !os.IsNotExist(err) {
		t.Fatalf("ownership record remains: %v", err)
	}
}

func TestRemovalCoordinatorRecoveryOnlyProcessesDeletingRecords(t *testing.T) {
	root := t.TempDir()
	deleting := removalTestSandbox(t, root, "sandbox-deleting", domain.VMStatusStopped, time.Now())
	ordinary := removalTestSandbox(t, root, "sandbox-ordinary", domain.VMStatusStopped, time.Now())
	store := &removalTestStore{sandboxes: map[string]*domain.Sandbox{deleting.Summary.ID: deleting, ordinary.Summary.ID: ordinary}}
	deletingRecord, _ := sessions.ReadOwnershipRecord(root, deleting.Summary.ID)
	deletingRecord.LifecycleState = "deleting"
	deletingRecord.Complete(sessions.DeletionStageIntent)
	if err := sessions.WriteOwnershipRecord(root, deletingRecord); err != nil {
		t.Fatal(err)
	}
	coordinator := &sessions.RemovalCoordinator{SandboxRoot: root, Store: store, Runtime: &removalTestRuntime{}}
	warnings := coordinator.Recover(context.Background())
	if len(warnings) != 0 {
		t.Fatalf("Recover warnings = %#v", warnings)
	}
	if _, ok := store.sandboxes[deleting.Summary.ID]; ok {
		t.Fatal("deleting sandbox was not recovered")
	}
	if _, ok := store.sandboxes[ordinary.Summary.ID]; !ok {
		t.Fatal("ordinary ownership record was removed during recovery")
	}
}

func TestRemovalCoordinatorRejectsInvalidOwnershipRecord(t *testing.T) {
	tests := []struct {
		name    string
		record  func(t *testing.T, root, sandboxID string)
		wantErr string
	}{
		{
			name: "corrupt json",
			record: func(t *testing.T, root, sandboxID string) {
				t.Helper()
				path, err := sessions.OwnershipRecordPath(root, sandboxID)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: "lifecycle record is invalid",
		},
		{
			name: "path escape",
			record: func(t *testing.T, root, sandboxID string) {
				t.Helper()
				path, err := sessions.OwnershipRecordPath(root, sandboxID)
				if err != nil {
					t.Fatal(err)
				}
				data := []byte(`{"version":1,"sandbox_id":"` + sandboxID + `","driver":"docker","runtime_id":"runtime","sandbox_path":"/tmp/outside","lifecycle_state":"active"}`)
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: "outside sandbox root",
		},
		{
			name: "symlink escape",
			record: func(t *testing.T, root, sandboxID string) {
				t.Helper()
				outside := t.TempDir()
				escape := filepath.Join(root, "escape")
				if err := os.Symlink(outside, escape); err != nil {
					t.Fatal(err)
				}
				path, err := sessions.OwnershipRecordPath(root, sandboxID)
				if err != nil {
					t.Fatal(err)
				}
				data := []byte(`{"version":1,"sandbox_id":"` + sandboxID + `","driver":"docker","runtime_id":"runtime","sandbox_path":"` + filepath.Join(escape, sandboxID) + `","lifecycle_state":"active"}`)
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: "outside sandbox root",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sandbox := removalTestSandbox(t, root, "sandbox-invalid", domain.VMStatusStopped, time.Now())
			tt.record(t, root, sandbox.Summary.ID)
			store := &removalTestStore{sandboxes: map[string]*domain.Sandbox{sandbox.Summary.ID: sandbox}}
			runtime := &removalTestRuntime{}
			coordinator := &sessions.RemovalCoordinator{SandboxRoot: root, Store: store, Runtime: runtime}

			_, err := coordinator.Remove(context.Background(), sandbox.Summary.ID, true)
			if !errors.Is(err, sessions.ErrOwnershipUnknown) || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Remove error = %v", err)
			}
			if runtime.removeCalls != 0 || store.removeCalls != 0 {
				t.Fatalf("unsafe removal calls runtime/store = %d/%d", runtime.removeCalls, store.removeCalls)
			}
			if _, err := os.Stat(filepath.Dir(sandbox.Summary.WorkspacePath)); err != nil {
				t.Fatalf("sandbox data changed: %v", err)
			}
		})
	}
}

func TestRemovalCoordinatorPruneSeparatesRecordsAndResidues(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	owned := removalTestSandbox(t, root, "sandbox-owned", domain.VMStatusStopped, now.Add(-48*time.Hour))
	foreign := removalTestSandbox(t, root, "sandbox-foreign", domain.VMStatusStopped, now.Add(-48*time.Hour))
	store := &removalTestStore{sandboxes: map[string]*domain.Sandbox{owned.Summary.ID: owned, foreign.Summary.ID: foreign}}
	residues := &removalTestResidues{items: []sessions.RuntimeResidue{
		{Driver: "docker", RuntimeID: "known-runtime", SandboxID: owned.Summary.ID, UpdatedAt: now.Add(-48 * time.Hour), OwnershipValid: true, Removable: true},
		{Driver: "docker", RuntimeID: "orphan-runtime", SandboxID: "sandbox-orphan", UpdatedAt: now.Add(-48 * time.Hour), OwnershipValid: true, Removable: true},
		{Driver: "docker", RuntimeID: "unsafe-runtime", SandboxID: "", UpdatedAt: now.Add(-48 * time.Hour), OwnershipValid: false},
		{Driver: "docker", RuntimeID: "second-orphan-runtime", SandboxID: "sandbox-second-orphan", UpdatedAt: now.Add(-48 * time.Hour), OwnershipValid: true, Removable: true},
	}}
	coordinator := &sessions.RemovalCoordinator{
		SandboxRoot: root, Store: store, Runtime: &removalTestRuntime{}, Residues: residues, Now: func() time.Time { return now },
		Targets: removalTestTargets{targets: map[string]sessions.SandboxOwnershipTarget{
			owned.Summary.ID: {ProjectID: "project-a", AgentName: "worker"}, foreign.Summary.ID: {ProjectID: "project-b", AgentName: "worker"},
		}},
	}
	dryRun, err := coordinator.Prune(context.Background(), sessions.PruneRequest{ProjectID: "project-a", Driver: "docker", OlderThan: 24 * time.Hour})
	if err != nil || !dryRun.DryRun || len(dryRun.Matched) != 1 || residues.listCalls != 0 {
		t.Fatalf("record-only prune = %#v err=%v residue calls=%d", dryRun, err, residues.listCalls)
	}
	result, err := coordinator.Prune(context.Background(), sessions.PruneRequest{ProjectID: "project-a", Driver: "docker", OlderThan: 24 * time.Hour, IncludeOrphans: true, Force: true})
	if err != nil || result.DryRun || len(result.Matched) != 4 || len(result.Removed) != 3 || len(result.Skipped) != 1 {
		t.Fatalf("forced prune = %#v err=%v", result, err)
	}
	if residues.removeCalls != 2 || result.Removed[1] != "sandbox-orphan" || result.Removed[2] != "sandbox-second-orphan" {
		t.Fatalf("residue removal calls/result = %d/%#v", residues.removeCalls, result.Removed)
	}
	if len(residues.removed) != 2 || residues.removed[0].RuntimeID != "orphan-runtime" || residues.removed[1].RuntimeID != "second-orphan-runtime" {
		t.Fatalf("removed residues = %#v", residues.removed)
	}
}

func TestRemovalCoordinatorSerializesConcurrentResume(t *testing.T) {
	root := t.TempDir()
	config := &appconfig.Config{DataRoot: root, SandboxRoot: filepath.Join(root, "sandboxes"), RuntimeDriver: "docker", DefaultImage: "guest:latest"}
	store, err := sessionstore.NewWithConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	sandbox, err := store.CreateSandboxWithOptions(context.Background(), "race", "", "docker", "guest:latest", "", "test", nil, nil, nil, sessionstore.CreateSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sandbox.Summary.VMStatus = domain.VMStatusStopped
	if err := store.UpdateSandbox(context.Background(), sandbox); err != nil {
		t.Fatal(err)
	}
	locks := sessions.NewLifecycleLocks()
	runtime := newBlockingLifecycleRuntime()
	lifecycle := sessions.Lifecycle{Config: config, Store: store, WorkspaceEnsurer: noOpWorkspaceEnsurer{}, Driver: runtime, Locks: locks}
	coordinator := &sessions.RemovalCoordinator{SandboxRoot: config.SandboxRoot, Store: store, Runtime: runtime, Locks: locks}

	resumeDone := make(chan error, 1)
	go func() {
		_, resumeErr := lifecycle.ResumeLoaded(context.Background(), sandbox, nil)
		resumeDone <- resumeErr
	}()
	<-runtime.startEntered
	removeDone := make(chan error, 1)
	go func() {
		_, removeErr := coordinator.Remove(context.Background(), sandbox.Summary.ID, true)
		removeDone <- removeErr
	}()
	select {
	case <-runtime.removeEntered:
		t.Fatal("remove reached the runtime while resume held the lifecycle lock")
	case <-time.After(50 * time.Millisecond):
	}
	close(runtime.continueStart)
	if err := <-resumeDone; err != nil {
		t.Fatalf("ResumeLoaded: %v", err)
	}
	if err := <-removeDone; err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if runtime.stopCalls != 1 || runtime.removeCalls != 1 {
		t.Fatalf("runtime stop/remove calls = %d/%d", runtime.stopCalls, runtime.removeCalls)
	}
	if _, err := store.GetSandbox(context.Background(), sandbox.Summary.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("sandbox remains after serialized remove: %v", err)
	}
}

func removalTestSandbox(t *testing.T, root, id, status string, updated time.Time) *domain.Sandbox {
	t.Helper()
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(filepath.Join(dir, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	sandbox := &domain.Sandbox{Summary: domain.SandboxSummary{ID: id, Driver: "docker", VMStatus: status, RuntimeRef: "runtime-" + id, WorkspacePath: filepath.Join(dir, "workspace"), CreatedAt: updated, UpdatedAt: updated}}
	if err := sessions.WriteOwnershipRecord(root, sessions.OwnershipRecord{Version: sessions.OwnershipRecordVersion, SandboxID: id, Driver: "docker", RuntimeID: sandbox.Summary.RuntimeRef, SandboxPath: dir, LifecycleState: "active"}); err != nil {
		t.Fatal(err)
	}
	return sandbox
}

type removalTestStore struct {
	sandboxes   map[string]*domain.Sandbox
	removeCalls int
}

func (s *removalTestStore) GetSandbox(_ context.Context, id string) (*domain.Sandbox, error) {
	item, ok := s.sandboxes[id]
	if !ok {
		return nil, os.ErrNotExist
	}
	return item, nil
}

func (s *removalTestStore) ListSandboxes(context.Context, domain.SandboxListOptions) (domain.SandboxListResult, error) {
	result := domain.SandboxListResult{}
	for _, item := range s.sandboxes {
		result.Sandboxes = append(result.Sandboxes, item)
	}
	return result, nil
}

func (s *removalTestStore) UpdateSandbox(_ context.Context, sandbox *domain.Sandbox) error {
	s.sandboxes[sandbox.Summary.ID] = sandbox
	return nil
}

func (s *removalTestStore) RemoveSandbox(_ context.Context, id string) error {
	s.removeCalls++
	item, ok := s.sandboxes[id]
	if !ok {
		return os.ErrNotExist
	}
	delete(s.sandboxes, id)
	return os.RemoveAll(filepath.Dir(item.Summary.WorkspacePath))
}

type removalTestRuntime struct {
	stopCalls    int
	removeCalls  int
	removeErrors []error
}

type noOpWorkspaceEnsurer struct{}

func (noOpWorkspaceEnsurer) Ensure(context.Context, *domain.Sandbox) error { return nil }

type blockingLifecycleRuntime struct {
	startEntered  chan struct{}
	continueStart chan struct{}
	removeEntered chan struct{}
	stopCalls     int
	removeCalls   int
}

func newBlockingLifecycleRuntime() *blockingLifecycleRuntime {
	return &blockingLifecycleRuntime{startEntered: make(chan struct{}), continueStart: make(chan struct{}), removeEntered: make(chan struct{}, 1)}
}

func (r *blockingLifecycleRuntime) StartSandboxVM(context.Context, *domain.Sandbox) error {
	close(r.startEntered)
	<-r.continueStart
	return nil
}

func (r *blockingLifecycleRuntime) StopSandboxVM(context.Context, *domain.Sandbox) error {
	r.stopCalls++
	return nil
}

func (r *blockingLifecycleRuntime) RemoveSandboxVM(context.Context, *domain.Sandbox) error {
	r.removeCalls++
	r.removeEntered <- struct{}{}
	return nil
}

func (r *removalTestRuntime) StopSandboxVM(context.Context, *domain.Sandbox) error {
	r.stopCalls++
	return nil
}

func (r *removalTestRuntime) RemoveSandboxVM(context.Context, *domain.Sandbox) error {
	r.removeCalls++
	if len(r.removeErrors) == 0 {
		return nil
	}
	err := r.removeErrors[0]
	r.removeErrors = r.removeErrors[1:]
	return err
}

type removalTestTargets struct {
	targets map[string]sessions.SandboxOwnershipTarget
}

func (r removalTestTargets) ResolveSandboxTargets(context.Context, []*domain.Sandbox) (map[string]sessions.SandboxOwnershipTarget, error) {
	return r.targets, nil
}

type removalTestResidues struct {
	items       []sessions.RuntimeResidue
	listCalls   int
	removeCalls int
	removed     []sessions.RuntimeResidue
}

func (r *removalTestResidues) ListRuntimeResidues(context.Context) ([]sessions.RuntimeResidue, []string, error) {
	r.listCalls++
	return append([]sessions.RuntimeResidue(nil), r.items...), nil, nil
}

func (r *removalTestResidues) RemoveRuntimeResidue(_ context.Context, residue sessions.RuntimeResidue) error {
	r.removeCalls++
	r.removed = append(r.removed, residue)
	return nil
}
