package adapters

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	appconfig "agent-compose/pkg/config"
	driverpkg "agent-compose/pkg/driver"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/sessions"
)

func TestBoxLiteLifecycleResidueUsesJournalOwnershipAndOfficialRemoval(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-boxlite-orphan"
	sandboxPath := filepath.Join(root, sandboxID)
	if err := os.MkdirAll(filepath.Join(sandboxPath, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sessions.WriteOwnershipRecord(root, sessions.OwnershipRecord{
		Version: sessions.OwnershipRecordVersion, SandboxID: sandboxID,
		Driver: driverpkg.RuntimeDriverBoxlite, RuntimeID: "box-id", SandboxPath: sandboxPath, LifecycleState: "active",
	}); err != nil {
		t.Fatal(err)
	}
	runtime := &boxLiteResidueRuntimeFake{}
	manager := NewRuntimeResidueManager(&appconfig.Config{SandboxRoot: root}, runtime)

	items, warnings := manager.listBoxLiteLifecycleResidues()
	if len(warnings) != 0 || len(items) != 1 || !items[0].OwnershipValid || !items[0].Removable || items[0].RuntimeID != "box-id" {
		t.Fatalf("BoxLite residues = %#v warnings=%#v", items, warnings)
	}
	if err := manager.RemoveRuntimeResidue(context.Background(), items[0]); err != nil {
		t.Fatalf("RemoveRuntimeResidue: %v", err)
	}
	if runtime.calls != 1 || runtime.sandbox == nil || runtime.sandbox.Summary.RuntimeRef != "box-id" || runtime.sandbox.Summary.Driver != driverpkg.RuntimeDriverBoxlite {
		t.Fatalf("runtime call = %d sandbox=%#v", runtime.calls, runtime.sandbox)
	}
	if _, err := os.Stat(sandboxPath); !os.IsNotExist(err) {
		t.Fatalf("sandbox residue remains: %v", err)
	}
	if _, err := sessions.ReadOwnershipRecord(root, sandboxID); !os.IsNotExist(err) {
		t.Fatalf("lifecycle journal remains: %v", err)
	}
}

func TestBoxLiteLifecycleResidueRejectsChangedOwnership(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-boxlite-changed"
	sandboxPath := filepath.Join(root, sandboxID)
	if err := os.MkdirAll(sandboxPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sessions.WriteOwnershipRecord(root, sessions.OwnershipRecord{Version: 1, SandboxID: sandboxID, Driver: driverpkg.RuntimeDriverBoxlite, RuntimeID: "new-box", SandboxPath: sandboxPath, LifecycleState: "active"}); err != nil {
		t.Fatal(err)
	}
	runtime := &boxLiteResidueRuntimeFake{}
	manager := NewRuntimeResidueManager(&appconfig.Config{SandboxRoot: root}, runtime)
	err := manager.RemoveRuntimeResidue(context.Background(), sessions.RuntimeResidue{Driver: driverpkg.RuntimeDriverBoxlite, SandboxID: sandboxID, RuntimeID: "old-box", OwnershipValid: true, Removable: true})
	if err == nil || runtime.calls != 0 {
		t.Fatalf("changed ownership removal err=%v calls=%d", err, runtime.calls)
	}
}

type boxLiteResidueRuntimeFake struct {
	calls   int
	sandbox *domain.Sandbox
}

func (*boxLiteResidueRuntimeFake) StopSandboxVM(context.Context, *domain.Sandbox) error { return nil }

func (f *boxLiteResidueRuntimeFake) RemoveSandboxVM(_ context.Context, sandbox *domain.Sandbox) error {
	f.calls++
	f.sandbox = sandbox
	return nil
}
