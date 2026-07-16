package adapters

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	testutil "agent-compose/pkg/internal/testutil"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/workspaces"
)

func TestIntegrationSandboxRPCBridgeResumePreservesReadyFileWorkspace(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	bridge, driver := newTestSandboxRPCBridge(t)
	const workspaceID = "resume-preserves-file-workspace"

	sourceRoot, err := workspaces.DefaultFileWorkspaceContentRoot(bridge.config, workspaceID)
	if err != nil {
		t.Fatalf("resolve file workspace source: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, "docs"), 0o755); err != nil {
		t.Fatalf("create file workspace source: %v", err)
	}
	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "editable.txt"), "template editable\n", 0o644)
	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "template.txt"), "template removed later\n", 0o644)
	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "docs", "guide.txt"), "original guide\n", 0o644)

	workspace, err := bridge.configDB.CreateWorkspaceConfig(ctx, domain.WorkspaceConfig{
		ID:         workspaceID,
		Name:       "Resume Preservation Workspace",
		Type:       "file",
		ConfigJSON: workspaces.DefaultFileConfigJSON(bridge.config, workspaceID),
	})
	if err != nil {
		t.Fatalf("CreateWorkspaceConfig returned error: %v", err)
	}
	created, err := bridge.createSandbox(ctx, sandboxRPCCreateRequest{
		Title:       "resume preservation",
		WorkspaceID: workspace.ID,
	}, domain.SandboxTypeManual)
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	sessionID := created.Summary.ID
	persisted, err := bridge.store.GetSandbox(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetSandbox after create returned error: %v", err)
	}
	assertIntegrationWorkspaceReady(t, persisted, "after create")
	workspaceRoot := persisted.Summary.WorkspacePath

	writeIntegrationWorkspaceFile(t, filepath.Join(workspaceRoot, "editable.txt"), "user content wins\n", 0o600)
	if err := os.Remove(filepath.Join(workspaceRoot, "template.txt")); err != nil {
		t.Fatalf("remove copied template file: %v", err)
	}
	writeIntegrationWorkspaceFile(t, filepath.Join(workspaceRoot, "generated.txt"), "generated in sandbox\n", 0o640)
	if err := os.Symlink("generated.txt", filepath.Join(workspaceRoot, "generated-link")); err != nil {
		t.Fatalf("create sandbox symlink: %v", err)
	}
	beforeStop, err := testutil.WorkspaceManifest(workspaceRoot)
	if err != nil {
		t.Fatalf("manifest workspace before stop: %v", err)
	}

	if _, err := bridge.StopSandbox(ctx, sessionID); err != nil {
		t.Fatalf("StopSession returned error: %v", err)
	}
	persisted, err = bridge.store.GetSandbox(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetSandbox after stop returned error: %v", err)
	}
	assertIntegrationWorkspaceReady(t, persisted, "after stop")

	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "editable.txt"), "conflicting source update\n", 0o644)
	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "template.txt"), "source template update\n", 0o644)
	writeIntegrationWorkspaceFile(t, filepath.Join(sourceRoot, "source-only.txt"), "added after stop\n", 0o644)

	resumeStartChecks := 0
	driver.onStart = func(session *domain.Sandbox) {
		resumeStartChecks++
		assertIntegrationWorkspaceReady(t, session, "at resume driver start")
		if session.Summary.WorkspacePath != workspaceRoot {
			t.Errorf("workspace path at resume driver start = %q, want %q", session.Summary.WorkspacePath, workspaceRoot)
		}
		atStart, manifestErr := testutil.WorkspaceManifest(session.Summary.WorkspacePath)
		if manifestErr != nil {
			t.Errorf("manifest workspace at resume driver start: %v", manifestErr)
			return
		}
		if !reflect.DeepEqual(atStart, beforeStop) {
			t.Errorf("workspace manifest changed before resume driver start:\n got: %#v\nwant: %#v", atStart, beforeStop)
		}
	}
	if _, err := bridge.ResumeSandbox(ctx, sessionID); err != nil {
		t.Fatalf("ResumeSession returned error: %v", err)
	}

	afterResume, err := testutil.WorkspaceManifest(workspaceRoot)
	if err != nil {
		t.Fatalf("manifest workspace after resume: %v", err)
	}
	if !reflect.DeepEqual(afterResume, beforeStop) {
		t.Fatalf("workspace manifest changed across stop/resume:\n got: %#v\nwant: %#v", afterResume, beforeStop)
	}
	persisted, err = bridge.store.GetSandbox(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetSandbox after resume returned error: %v", err)
	}
	assertIntegrationWorkspaceReady(t, persisted, "after resume")
	if resumeStartChecks != 1 {
		t.Fatalf("resume driver start checks = %d, want 1", resumeStartChecks)
	}
	if got := len(driver.startCalls); got != 2 {
		t.Fatalf("StartSandboxVM call count = %d, want 2", got)
	}
	if got := len(driver.stopCalls); got != 1 {
		t.Fatalf("StopSandboxVM call count = %d, want 1", got)
	}
}

func writeIntegrationWorkspaceFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write workspace file %s: %v", path, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod workspace file %s: %v", path, err)
	}
}

func assertIntegrationWorkspaceReady(t *testing.T, sandbox *domain.Sandbox, stage string) {
	t.Helper()
	if sandbox == nil || sandbox.WorkspaceProvisioning == nil {
		t.Fatalf("workspace provisioning %s = %#v, want ready", stage, sandbox)
	}
	if got := sandbox.WorkspaceProvisioning.Status; got != domain.SandboxWorkspaceProvisioningStatusReady {
		t.Fatalf("workspace provisioning status %s = %q, want %q", stage, got, domain.SandboxWorkspaceProvisioningStatusReady)
	}
}
