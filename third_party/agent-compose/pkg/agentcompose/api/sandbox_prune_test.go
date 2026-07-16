package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"

	"agent-compose/pkg/sessions"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func TestPruneSandboxesMapsRequestAndCandidates(t *testing.T) {
	updatedAt := time.Date(2026, 7, 14, 8, 0, 0, 0, time.UTC)
	coordinator := &sandboxPruneCoordinatorFake{result: sessions.PruneResult{
		DryRun: true,
		Matched: []sessions.PruneCandidate{
			{Kind: sessions.PruneCandidateSandboxRecord, SandboxID: "sandbox-record", ProjectID: "project-1", AgentName: "worker", Driver: "docker", Status: "STOPPED", RuntimeID: "container-1", UpdatedAt: updatedAt, Removable: true},
			{Kind: sessions.PruneCandidateRuntimeResidue, SandboxID: "sandbox-orphan", Driver: "microsandbox", RuntimeID: "msb-1", UpdatedAt: updatedAt, Removable: false, BlockedReasons: []string{"ownership incomplete"}},
		},
		Removed:  []string{"sandbox-record"},
		Skipped:  []sessions.PruneCandidate{{Kind: sessions.PruneCandidateRuntimeResidue, SandboxID: "sandbox-orphan", Driver: "microsandbox", RuntimeID: "msb-1", Removable: false, BlockedReasons: []string{"ownership incomplete"}}},
		Warnings: []string{"inventory partial"},
	}}
	handler := NewSandboxHandler(nil, nil, nil, nil).WithRemovalCoordinator(coordinator)
	response, err := handler.PruneSandboxes(context.Background(), connect.NewRequest(&agentcomposev2.PruneSandboxesRequest{
		ProjectId: " project-1 ", Status: []string{"stopped"}, AgentName: " worker ", Driver: " docker ",
		OlderThanSeconds: 3600, IncludeOrphans: true, Force: false,
	}))
	if err != nil {
		t.Fatalf("PruneSandboxes returned error: %v", err)
	}
	if coordinator.request.ProjectID != "project-1" || coordinator.request.AgentName != "worker" || coordinator.request.Driver != "docker" || coordinator.request.OlderThan != time.Hour || !coordinator.request.IncludeOrphans || coordinator.request.Force {
		t.Fatalf("coordinator request = %#v", coordinator.request)
	}
	if !response.Msg.GetDryRun() || len(response.Msg.GetMatched()) != 2 || len(response.Msg.GetSkipped()) != 1 || len(response.Msg.GetRemoved()) != 1 || len(response.Msg.GetWarnings()) != 1 {
		t.Fatalf("response = %#v", response.Msg)
	}
	if got := response.Msg.GetMatched()[1]; got.GetKind() != agentcomposev2.SandboxPruneCandidateKind_SANDBOX_PRUNE_CANDIDATE_KIND_RUNTIME_RESIDUE || got.GetRuntimeId() != "msb-1" || got.GetUpdatedAt() == nil || got.GetRemovable() || len(got.GetBlockedReasons()) != 1 {
		t.Fatalf("runtime residue candidate = %#v", got)
	}
}

func TestPruneSandboxesValidatesDurationAndCoordinatorErrors(t *testing.T) {
	handler := NewSandboxHandler(nil, nil, nil, nil)
	if _, err := handler.PruneSandboxes(context.Background(), connect.NewRequest(&agentcomposev2.PruneSandboxesRequest{})); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatalf("missing coordinator code = %v, err=%v", connect.CodeOf(err), err)
	}

	coordinator := &sandboxPruneCoordinatorFake{err: errors.New("unsafe status")}
	handler.WithRemovalCoordinator(coordinator)
	if _, err := handler.PruneSandboxes(context.Background(), connect.NewRequest(&agentcomposev2.PruneSandboxesRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("coordinator error code = %v, err=%v", connect.CodeOf(err), err)
	}
}

type sandboxPruneCoordinatorFake struct {
	request sessions.PruneRequest
	result  sessions.PruneResult
	err     error
}

func (f *sandboxPruneCoordinatorFake) Remove(context.Context, string, bool) (sessions.RemovalResult, error) {
	return sessions.RemovalResult{}, nil
}

func (f *sandboxPruneCoordinatorFake) Prune(_ context.Context, request sessions.PruneRequest) (sessions.PruneResult, error) {
	f.request = request
	return f.result, f.err
}
