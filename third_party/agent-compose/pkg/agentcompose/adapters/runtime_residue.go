package adapters

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	appconfig "agent-compose/pkg/config"
	driverpkg "agent-compose/pkg/driver"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/sessions"
)

type RuntimeResidueManager struct {
	config  *appconfig.Config
	runtime sessions.RemovalRuntime
}

func NewRuntimeResidueManager(config *appconfig.Config, runtime sessions.RemovalRuntime) *RuntimeResidueManager {
	return &RuntimeResidueManager{config: config, runtime: runtime}
}

func (m *RuntimeResidueManager) ListRuntimeResidues(ctx context.Context) ([]sessions.RuntimeResidue, []string, error) {
	resources, err := driverpkg.ListDockerManagedResources(ctx, m.config)
	var warnings []string
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("docker runtime residue scan skipped: %v", err))
		resources = nil
	}
	result := make([]sessions.RuntimeResidue, 0, len(resources))
	for _, resource := range resources {
		result = append(result, sessions.RuntimeResidue{
			Driver: resource.Driver, RuntimeID: resource.RuntimeID, SandboxID: resource.SandboxID,
			UpdatedAt: resource.UpdatedAt, OwnershipValid: resource.OwnershipValid,
			Removable: resource.Removable, BlockedReasons: append([]string(nil), resource.BlockedReasons...), OwnedPaths: append([]string(nil), resource.OwnedPaths...),
		})
	}
	microsandboxResources, microsandboxWarnings, err := driverpkg.ListMicrosandboxManagedResources(ctx, m.config)
	if err != nil {
		return result, append(microsandboxWarnings, fmt.Sprintf("microsandbox runtime residue scan skipped: %v", err)), nil
	}
	for _, resource := range microsandboxResources {
		result = append(result, sessions.RuntimeResidue{Driver: resource.Driver, RuntimeID: resource.RuntimeID, SandboxID: resource.SandboxID, UpdatedAt: resource.UpdatedAt, OwnershipValid: resource.OwnershipValid, Removable: resource.Removable, BlockedReasons: append([]string(nil), resource.BlockedReasons...), OwnedPaths: append([]string(nil), resource.OwnedPaths...)})
	}
	warnings = append(warnings, microsandboxWarnings...)
	boxLiteResources, lifecycleWarnings := m.listBoxLiteLifecycleResidues()
	warnings = append(warnings, lifecycleWarnings...)
	result = append(result, boxLiteResources...)
	return result, warnings, nil
}

func (m *RuntimeResidueManager) listBoxLiteLifecycleResidues() ([]sessions.RuntimeResidue, []string) {
	records, warnings := sessions.ListOwnershipRecords(m.config.SandboxRoot)
	result := make([]sessions.RuntimeResidue, 0, len(records))
	for _, record := range records {
		if !strings.EqualFold(record.Driver, driverpkg.RuntimeDriverBoxlite) {
			continue
		}
		if record.LifecycleState == "deleting" {
			continue
		}
		valid := strings.TrimSpace(record.RuntimeID) != ""
		resource := sessions.RuntimeResidue{
			Driver: driverpkg.RuntimeDriverBoxlite, RuntimeID: record.RuntimeID, SandboxID: record.SandboxID,
			UpdatedAt: record.UpdatedAt, OwnershipValid: valid, Removable: valid,
			OwnedPaths: []string{record.SandboxPath},
		}
		if !valid {
			resource.BlockedReasons = append(resource.BlockedReasons, "BoxLite lifecycle ownership is incomplete")
		}
		result = append(result, resource)
	}
	return result, warnings
}

func (m *RuntimeResidueManager) RemoveRuntimeResidue(ctx context.Context, resource sessions.RuntimeResidue) error {
	driverResource := driverpkg.ManagedRuntimeResource{
		Driver: resource.Driver, RuntimeID: resource.RuntimeID, SandboxID: resource.SandboxID,
		UpdatedAt: resource.UpdatedAt, OwnershipValid: resource.OwnershipValid,
		Removable: resource.Removable, BlockedReasons: append([]string(nil), resource.BlockedReasons...), OwnedPaths: append([]string(nil), resource.OwnedPaths...),
	}
	switch resource.Driver {
	case driverpkg.RuntimeDriverDocker:
		return driverpkg.RemoveDockerManagedResource(ctx, m.config, driverResource)
	case driverpkg.RuntimeDriverMicrosandbox:
		return driverpkg.RemoveMicrosandboxManagedResource(ctx, m.config, driverResource)
	case driverpkg.RuntimeDriverBoxlite:
		return m.removeBoxLiteResidue(ctx, resource)
	default:
		return fmt.Errorf("runtime residue driver %q does not support safe removal", resource.Driver)
	}
}

func (m *RuntimeResidueManager) removeBoxLiteResidue(ctx context.Context, requested sessions.RuntimeResidue) error {
	if m.runtime == nil || !requested.OwnershipValid || !requested.Removable || strings.TrimSpace(requested.SandboxID) == "" || strings.TrimSpace(requested.RuntimeID) == "" {
		return fmt.Errorf("BoxLite runtime residue ownership is incomplete")
	}
	record, err := sessions.ReadOwnershipRecord(m.config.SandboxRoot, requested.SandboxID)
	if err != nil {
		return fmt.Errorf("revalidate BoxLite lifecycle ownership: %w", err)
	}
	if !strings.EqualFold(record.Driver, driverpkg.RuntimeDriverBoxlite) || record.RuntimeID != requested.RuntimeID || record.SandboxPath == "" {
		return fmt.Errorf("BoxLite lifecycle ownership changed before removal")
	}
	sandbox := &domain.Sandbox{Summary: domain.SandboxSummary{
		ID: record.SandboxID, Driver: driverpkg.RuntimeDriverBoxlite, RuntimeRef: record.RuntimeID,
		WorkspacePath: filepath.Join(record.SandboxPath, "workspace"), VMStatus: domain.VMStatusStopped,
	}}
	if err := m.runtime.RemoveSandboxVM(ctx, sandbox); err != nil {
		return err
	}
	if err := os.RemoveAll(record.SandboxPath); err != nil {
		return fmt.Errorf("remove BoxLite sandbox residue data: %w", err)
	}
	return sessions.RemoveOwnershipRecord(m.config.SandboxRoot, record.SandboxID)
}
