package model

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestSandboxWorkspaceProvisioningConstants(t *testing.T) {
	if SandboxWorkspaceProvisioningVersion != 1 {
		t.Fatalf("SandboxWorkspaceProvisioningVersion = %d, want 1", SandboxWorkspaceProvisioningVersion)
	}
	want := map[string]string{
		"pending": SandboxWorkspaceProvisioningStatusPending,
		"ready":   SandboxWorkspaceProvisioningStatusReady,
		"failed":  SandboxWorkspaceProvisioningStatusFailed,
	}
	for value, got := range want {
		if got != value {
			t.Errorf("provisioning status constant = %q, want %q", got, value)
		}
	}
}

func TestSandboxWorkspaceProvisioningJSONRoundTrip(t *testing.T) {
	updatedAt := time.Date(2026, time.July, 13, 12, 0, 0, 123456789, time.UTC)
	want := Sandbox{
		Summary: SandboxSummary{ID: "sandbox-1"},
		WorkspaceProvisioning: &SandboxWorkspaceProvisioning{
			Version:   SandboxWorkspaceProvisioningVersion,
			Status:    SandboxWorkspaceProvisioningStatusPending,
			UpdatedAt: updatedAt,
		},
	}

	data, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	for _, fragment := range [][]byte{
		[]byte(`"workspace_provisioning"`),
		[]byte(`"version":1`),
		[]byte(`"status":"pending"`),
		[]byte(`"updated_at":"2026-07-13T12:00:00.123456789Z"`),
	} {
		if !bytes.Contains(data, fragment) {
			t.Errorf("JSON %s does not contain %s", data, fragment)
		}
	}

	var got Sandbox
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if !reflect.DeepEqual(got.WorkspaceProvisioning, want.WorkspaceProvisioning) {
		t.Fatalf("workspace provisioning after round trip = %#v, want %#v", got.WorkspaceProvisioning, want.WorkspaceProvisioning)
	}
}

func TestSandboxWorkspaceProvisioningJSONBackwardCompatibility(t *testing.T) {
	var legacy Sandbox
	if err := json.Unmarshal([]byte(`{"summary":{"id":"legacy-sandbox"},"workspace":{"id":"workspace-1"}}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy sandbox: %v", err)
	}
	if legacy.WorkspaceProvisioning != nil {
		t.Fatalf("legacy workspace provisioning = %#v, want nil", legacy.WorkspaceProvisioning)
	}

	data, err := json.Marshal(Sandbox{Summary: SandboxSummary{ID: "sandbox-without-workspace"}})
	if err != nil {
		t.Fatalf("marshal sandbox without provisioning: %v", err)
	}
	if bytes.Contains(data, []byte(`"workspace_provisioning"`)) {
		t.Fatalf("JSON %s contains omitted workspace_provisioning", data)
	}
}

func TestValidateSandboxWorkspaceProvisioning(t *testing.T) {
	for _, status := range []string{
		SandboxWorkspaceProvisioningStatusPending,
		SandboxWorkspaceProvisioningStatusReady,
		SandboxWorkspaceProvisioningStatusFailed,
	} {
		t.Run("valid_"+status, func(t *testing.T) {
			provisioning := &SandboxWorkspaceProvisioning{
				Version:   SandboxWorkspaceProvisioningVersion,
				Status:    status,
				UpdatedAt: time.Now().UTC(),
			}
			if err := ValidateSandboxWorkspaceProvisioning(provisioning); err != nil {
				t.Fatalf("ValidateSandboxWorkspaceProvisioning() error = %v", err)
			}
		})
	}

	invalid := []struct {
		name         string
		provisioning *SandboxWorkspaceProvisioning
	}{
		{name: "nil", provisioning: nil},
		{name: "unknown version", provisioning: &SandboxWorkspaceProvisioning{Version: 2, Status: SandboxWorkspaceProvisioningStatusPending}},
		{name: "zero version", provisioning: &SandboxWorkspaceProvisioning{Status: SandboxWorkspaceProvisioningStatusPending}},
		{name: "unknown status", provisioning: &SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: "unknown"}},
		{name: "empty status", provisioning: &SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion}},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateSandboxWorkspaceProvisioning(tt.provisioning); err == nil {
				t.Fatal("ValidateSandboxWorkspaceProvisioning() error = nil, want non-nil")
			}
		})
	}
}

func TestTransitionSandboxWorkspaceProvisioningAllowsDefinedTransitions(t *testing.T) {
	tests := []struct {
		name string
		from string
		to   string
	}{
		{name: "pending to ready", from: SandboxWorkspaceProvisioningStatusPending, to: SandboxWorkspaceProvisioningStatusReady},
		{name: "pending to failed", from: SandboxWorkspaceProvisioningStatusPending, to: SandboxWorkspaceProvisioningStatusFailed},
		{name: "failed to pending", from: SandboxWorkspaceProvisioningStatusFailed, to: SandboxWorkspaceProvisioningStatusPending},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
			sandbox := &Sandbox{WorkspaceProvisioning: &SandboxWorkspaceProvisioning{
				Version:   SandboxWorkspaceProvisioningVersion,
				Status:    tt.from,
				UpdatedAt: before,
			}}

			if err := TransitionSandboxWorkspaceProvisioning(sandbox, tt.to); err != nil {
				t.Fatalf("TransitionSandboxWorkspaceProvisioning() error = %v", err)
			}
			got := sandbox.WorkspaceProvisioning
			if got.Version != SandboxWorkspaceProvisioningVersion {
				t.Errorf("version = %d, want %d", got.Version, SandboxWorkspaceProvisioningVersion)
			}
			if got.Status != tt.to {
				t.Errorf("status = %q, want %q", got.Status, tt.to)
			}
			if got.UpdatedAt.IsZero() || !got.UpdatedAt.After(before) {
				t.Errorf("updated_at = %v, want non-zero and after %v", got.UpdatedAt, before)
			}
			if got.UpdatedAt.Location() != time.UTC {
				t.Errorf("updated_at location = %v, want UTC", got.UpdatedAt.Location())
			}
		})
	}
}

func TestTransitionSandboxWorkspaceProvisioningRejectsInvalidInputWithoutMutation(t *testing.T) {
	if err := TransitionSandboxWorkspaceProvisioning(nil, SandboxWorkspaceProvisioningStatusReady); err == nil {
		t.Fatal("nil sandbox transition error = nil, want non-nil")
	}
	if err := TransitionSandboxWorkspaceProvisioning(&Sandbox{}, SandboxWorkspaceProvisioningStatusReady); err == nil {
		t.Fatal("nil provisioning transition error = nil, want non-nil")
	}

	baseTime := time.Date(2026, time.July, 13, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		current SandboxWorkspaceProvisioning
		target  string
	}{
		{
			name:    "unknown version",
			current: SandboxWorkspaceProvisioning{Version: 2, Status: SandboxWorkspaceProvisioningStatusPending, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusReady,
		},
		{
			name:    "unknown current status",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: "unknown", UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusReady,
		},
		{
			name:    "unknown target status",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusPending, UpdatedAt: baseTime},
			target:  "unknown",
		},
		{
			name:    "pending to pending",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusPending, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusPending,
		},
		{
			name:    "failed to failed",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusFailed, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusFailed,
		},
		{
			name:    "failed to ready",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusFailed, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusReady,
		},
		{
			name:    "ready to pending",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusReady, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusPending,
		},
		{
			name:    "ready to failed",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusReady, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusFailed,
		},
		{
			name:    "ready to ready",
			current: SandboxWorkspaceProvisioning{Version: SandboxWorkspaceProvisioningVersion, Status: SandboxWorkspaceProvisioningStatusReady, UpdatedAt: baseTime},
			target:  SandboxWorkspaceProvisioningStatusReady,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := tt.current
			sandbox := &Sandbox{WorkspaceProvisioning: &tt.current}
			if err := TransitionSandboxWorkspaceProvisioning(sandbox, tt.target); err == nil {
				t.Fatal("TransitionSandboxWorkspaceProvisioning() error = nil, want non-nil")
			}
			if !reflect.DeepEqual(*sandbox.WorkspaceProvisioning, before) {
				t.Fatalf("provisioning mutated on rejected transition: got %#v, want %#v", *sandbox.WorkspaceProvisioning, before)
			}
		})
	}
}
