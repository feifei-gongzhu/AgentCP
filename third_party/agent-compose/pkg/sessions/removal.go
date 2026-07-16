package sessions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	domain "agent-compose/pkg/model"
)

var (
	ErrSandboxRunning   = errors.New("sandbox is running")
	ErrOwnershipUnknown = errors.New("sandbox ownership is unknown")
	ErrUnsafeResidue    = errors.New("runtime residue is unsafe to remove")
)

type RemovalStore interface {
	GetSandbox(context.Context, string) (*domain.Sandbox, error)
	ListSandboxes(context.Context, domain.SandboxListOptions) (domain.SandboxListResult, error)
	UpdateSandbox(context.Context, *domain.Sandbox) error
	RemoveSandbox(context.Context, string) error
}

type RemovalRuntime interface {
	StopSandboxVM(context.Context, *domain.Sandbox) error
	RemoveSandboxVM(context.Context, *domain.Sandbox) error
}

type SandboxAccessoryReleaser interface {
	ReleaseSandboxResources(context.Context, string) error
}

type SandboxOwnershipTarget struct {
	ProjectID string
	AgentName string
}

type SandboxOwnershipTargetResolver interface {
	ResolveSandboxTargets(context.Context, []*domain.Sandbox) (map[string]SandboxOwnershipTarget, error)
}

type RuntimeResidue struct {
	Driver         string
	RuntimeID      string
	SandboxID      string
	UpdatedAt      time.Time
	OwnershipValid bool
	Removable      bool
	BlockedReasons []string
	OwnedPaths     []string
}

type RuntimeResidueManager interface {
	ListRuntimeResidues(context.Context) ([]RuntimeResidue, []string, error)
	RemoveRuntimeResidue(context.Context, RuntimeResidue) error
}

type RemovalResult struct {
	SandboxID string
	Stopped   bool
	Removed   bool
}

type PruneCandidateKind string

const (
	PruneCandidateSandboxRecord  PruneCandidateKind = "sandbox-record"
	PruneCandidateRuntimeResidue PruneCandidateKind = "runtime-residue"
)

type PruneRequest struct {
	ProjectID      string
	Statuses       []string
	AgentName      string
	Driver         string
	OlderThan      time.Duration
	IncludeOrphans bool
	Force          bool
}

type PruneCandidate struct {
	Kind           PruneCandidateKind
	SandboxID      string
	ProjectID      string
	AgentName      string
	Driver         string
	Status         string
	RuntimeID      string
	UpdatedAt      time.Time
	Removable      bool
	BlockedReasons []string
	residue        *RuntimeResidue
}

type PruneResult struct {
	DryRun   bool
	Matched  []PruneCandidate
	Removed  []string
	Skipped  []PruneCandidate
	Warnings []string
}

type RemovalCoordinator struct {
	SandboxRoot string
	Store       RemovalStore
	Runtime     RemovalRuntime
	Accessories SandboxAccessoryReleaser
	Targets     SandboxOwnershipTargetResolver
	Residues    RuntimeResidueManager
	Locks       *LifecycleLocks
	Now         func() time.Time

	locks LifecycleLocks
}

func (c *RemovalCoordinator) Remove(ctx context.Context, sandboxID string, force bool) (RemovalResult, error) {
	if c == nil || c.Store == nil || c.Runtime == nil {
		return RemovalResult{}, fmt.Errorf("sandbox removal coordinator is not configured")
	}
	sandboxID = strings.TrimSpace(sandboxID)
	unlock := c.lock(sandboxID)
	defer unlock()

	record, recordErr := ReadOwnershipRecord(c.SandboxRoot, sandboxID)
	sandbox, sandboxErr := c.Store.GetSandbox(ctx, sandboxID)
	if recordErr != nil {
		if !os.IsNotExist(recordErr) {
			return RemovalResult{}, fmt.Errorf("%w: sandbox %s lifecycle record is invalid: %v", ErrOwnershipUnknown, sandboxID, recordErr)
		}
		if sandboxErr != nil {
			return RemovalResult{}, fmt.Errorf("%w: sandbox %s has neither record nor metadata", ErrOwnershipUnknown, sandboxID)
		}
		record = ownershipFromSandbox(c.SandboxRoot, sandbox)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return RemovalResult{}, err
		}
	}
	if record.LifecycleState != "deleting" {
		if sandboxErr != nil {
			return RemovalResult{}, fmt.Errorf("%w: sandbox %s metadata is unavailable", ErrOwnershipUnknown, sandboxID)
		}
		if sandbox.Summary.VMStatus == domain.VMStatusRunning && !force {
			return RemovalResult{}, fmt.Errorf("%w: %s", ErrSandboxRunning, sandboxID)
		}
		record.StopRequired = sandbox.Summary.VMStatus == domain.VMStatusRunning
		record.LifecycleState = "deleting"
		record.Complete(DeletionStageIntent)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return RemovalResult{}, err
		}
		sandbox.Summary.VMStatus = domain.VMStatusDeleting
		if err := c.Store.UpdateSandbox(ctx, sandbox); err != nil {
			return RemovalResult{}, fmt.Errorf("persist sandbox deletion intent: %w", err)
		}
	}

	result := RemovalResult{SandboxID: sandboxID, Stopped: record.StopRequired && record.StageCompleted(DeletionStageRuntimeStop)}
	if !record.StageCompleted(DeletionStageRuntimeStop) {
		if sandboxErr != nil {
			return result, fmt.Errorf("load sandbox for runtime stop: %w", sandboxErr)
		}
		if record.StopRequired {
			if err := c.Runtime.StopSandboxVM(ctx, sandbox); err != nil {
				return result, fmt.Errorf("stop sandbox runtime: %w", err)
			}
			result.Stopped = true
		}
		record.Complete(DeletionStageRuntimeStop)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return result, err
		}
	}
	if !record.StageCompleted(DeletionStageRuntime) {
		if sandboxErr != nil {
			return result, fmt.Errorf("load sandbox for runtime remove: %w", sandboxErr)
		}
		if err := c.Runtime.RemoveSandboxVM(ctx, sandbox); err != nil {
			return result, fmt.Errorf("remove sandbox runtime: %w", err)
		}
		record.Complete(DeletionStageRuntime)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return result, err
		}
	}
	if !record.StageCompleted(DeletionStageAccessories) {
		if c.Accessories != nil {
			if err := c.Accessories.ReleaseSandboxResources(ctx, sandboxID); err != nil {
				return result, fmt.Errorf("release sandbox accessories: %w", err)
			}
		}
		record.Complete(DeletionStageAccessories)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return result, err
		}
	}
	if !record.StageCompleted(DeletionStageSandboxData) {
		if err := c.Store.RemoveSandbox(ctx, sandboxID); err != nil && !errors.Is(err, os.ErrNotExist) {
			return result, fmt.Errorf("remove sandbox data: %w", err)
		}
		record.Complete(DeletionStageSandboxData)
		if err := WriteOwnershipRecord(c.SandboxRoot, record); err != nil {
			return result, err
		}
	}
	if err := RemoveOwnershipRecord(c.SandboxRoot, sandboxID); err != nil {
		return result, fmt.Errorf("remove sandbox lifecycle journal: %w", err)
	}
	result.Removed = true
	return result, nil
}

func (c *RemovalCoordinator) Recover(ctx context.Context) []string {
	records, warnings := ListOwnershipRecords(c.SandboxRoot)
	for _, record := range records {
		if record.LifecycleState != "deleting" {
			continue
		}
		if _, err := c.Remove(ctx, record.SandboxID, true); err != nil {
			warnings = append(warnings, fmt.Sprintf("resume sandbox deletion %s: %v", record.SandboxID, err))
		}
	}
	return warnings
}

func (c *RemovalCoordinator) Prune(ctx context.Context, req PruneRequest) (PruneResult, error) {
	statuses, err := normalizePruneStatuses(req.Statuses)
	if err != nil {
		return PruneResult{}, err
	}
	listed, err := c.Store.ListSandboxes(ctx, domain.SandboxListOptions{Limit: 1 << 30})
	if err != nil {
		return PruneResult{}, err
	}
	targets := map[string]SandboxOwnershipTarget{}
	if c.Targets != nil {
		targets, err = c.Targets.ResolveSandboxTargets(ctx, listed.Sandboxes)
		if err != nil {
			return PruneResult{}, err
		}
	}
	now := c.now()
	result := PruneResult{DryRun: !req.Force}
	known := make(map[string]struct{}, len(listed.Sandboxes))
	for _, sandbox := range listed.Sandboxes {
		known[sandbox.Summary.ID] = struct{}{}
		target := targets[sandbox.Summary.ID]
		if !matchesSandboxPrune(sandbox, target, req, statuses, now) {
			continue
		}
		result.Matched = append(result.Matched, PruneCandidate{
			Kind: PruneCandidateSandboxRecord, SandboxID: sandbox.Summary.ID,
			ProjectID: target.ProjectID, AgentName: target.AgentName,
			Driver: sandbox.Summary.Driver, Status: sandbox.Summary.VMStatus,
			RuntimeID: sandbox.Summary.RuntimeRef, UpdatedAt: sandbox.Summary.UpdatedAt,
			Removable: true,
		})
	}
	if req.IncludeOrphans {
		if c.Residues == nil {
			result.Warnings = append(result.Warnings, "runtime residue inventory is unavailable")
		} else {
			residues, warnings, listErr := c.Residues.ListRuntimeResidues(ctx)
			result.Warnings = append(result.Warnings, warnings...)
			if listErr != nil {
				return result, listErr
			}
			for i := range residues {
				residue := residues[i]
				if _, exists := known[residue.SandboxID]; exists || !matchesResiduePrune(residue, req, now) {
					continue
				}
				candidate := PruneCandidate{Kind: PruneCandidateRuntimeResidue, SandboxID: residue.SandboxID, Driver: residue.Driver, RuntimeID: residue.RuntimeID, UpdatedAt: residue.UpdatedAt, Removable: residue.OwnershipValid && residue.Removable, BlockedReasons: append([]string(nil), residue.BlockedReasons...), residue: &residue}
				if !residue.OwnershipValid {
					candidate.BlockedReasons = append(candidate.BlockedReasons, "runtime ownership is incomplete")
				}
				result.Matched = append(result.Matched, candidate)
			}
		}
	}
	for _, candidate := range result.Matched {
		if !candidate.Removable {
			result.Skipped = append(result.Skipped, candidate)
			continue
		}
		if result.DryRun {
			continue
		}
		if candidate.Kind == PruneCandidateSandboxRecord {
			if _, err := c.Remove(ctx, candidate.SandboxID, false); err != nil {
				candidate.Removable = false
				candidate.BlockedReasons = append(candidate.BlockedReasons, err.Error())
				result.Skipped = append(result.Skipped, candidate)
				continue
			}
		} else if candidate.residue != nil {
			if err := c.Residues.RemoveRuntimeResidue(ctx, *candidate.residue); err != nil {
				candidate.Removable = false
				candidate.BlockedReasons = append(candidate.BlockedReasons, err.Error())
				result.Skipped = append(result.Skipped, candidate)
				continue
			}
		}
		result.Removed = append(result.Removed, candidateID(candidate))
	}
	return result, nil
}

func ownershipFromSandbox(root string, sandbox *domain.Sandbox) OwnershipRecord {
	return OwnershipRecord{
		Version: OwnershipRecordVersion, SandboxID: sandbox.Summary.ID,
		Driver: sandbox.Summary.Driver, RuntimeID: sandbox.Summary.RuntimeRef,
		SandboxPath: filepath.Dir(sandbox.Summary.WorkspacePath), LifecycleState: "active",
		OwnedResources: []OwnedResource{{Kind: "runtime", Identity: sandbox.Summary.RuntimeRef}, {Kind: "sandbox-directory", Path: filepath.Dir(sandbox.Summary.WorkspacePath)}},
	}
}

func (c *RemovalCoordinator) lock(id string) func() {
	if c.Locks != nil {
		return c.Locks.Lock(id)
	}
	return c.locks.Lock(id)
}

func (c *RemovalCoordinator) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizePruneStatuses(values []string) (map[string]struct{}, error) {
	if len(values) == 0 {
		values = []string{domain.VMStatusStopped, domain.VMStatusFailed}
	}
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		status := strings.ToUpper(strings.TrimSpace(value))
		if status != domain.VMStatusStopped && status != domain.VMStatusFailed {
			return nil, fmt.Errorf("sandbox prune status %q is unsafe", value)
		}
		result[status] = struct{}{}
	}
	return result, nil
}

func matchesSandboxPrune(sandbox *domain.Sandbox, target SandboxOwnershipTarget, req PruneRequest, statuses map[string]struct{}, now time.Time) bool {
	if sandbox == nil {
		return false
	}
	if _, ok := statuses[strings.ToUpper(strings.TrimSpace(sandbox.Summary.VMStatus))]; !ok {
		return false
	}
	if req.ProjectID != "" && target.ProjectID != req.ProjectID {
		return false
	}
	if req.AgentName != "" && !strings.EqualFold(target.AgentName, req.AgentName) {
		return false
	}
	if req.Driver != "" && !strings.EqualFold(sandbox.Summary.Driver, req.Driver) {
		return false
	}
	return req.OlderThan <= 0 || (!sandbox.Summary.UpdatedAt.IsZero() && now.Sub(sandbox.Summary.UpdatedAt) >= req.OlderThan)
}

func matchesResiduePrune(residue RuntimeResidue, req PruneRequest, now time.Time) bool {
	if req.Driver != "" && !strings.EqualFold(residue.Driver, req.Driver) {
		return false
	}
	return req.OlderThan <= 0 || (!residue.UpdatedAt.IsZero() && now.Sub(residue.UpdatedAt) >= req.OlderThan)
}

func candidateID(candidate PruneCandidate) string {
	if candidate.SandboxID != "" {
		return candidate.SandboxID
	}
	return candidate.RuntimeID
}
