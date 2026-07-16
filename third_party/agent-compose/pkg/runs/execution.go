package runs

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"agent-compose/pkg/execution"
	domain "agent-compose/pkg/model"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func TransitionFromAgentCell(run domain.ProjectRunRecord, sandbox *domain.Sandbox, cell domain.NotebookCell, execErr error) TransitionRequest {
	req := TransitionRequest{
		RunID:    run.RunID,
		ExitCode: cell.ExitCode,
		Output:   cell.Output,
	}
	if sandbox != nil {
		req.SandboxID = sandbox.Summary.ID
	}
	if sandbox != nil && cell.ID != "" {
		artifactsDir := filepath.Join(execution.HostSandboxDir(sandbox), "state", "cells", cell.ID)
		req.ArtifactsDir = artifactsDir
		req.LogsPath = filepath.Join(artifactsDir, "output.txt")
	}
	resultJSON, err := json.Marshal(map[string]any{
		"sandboxId":     req.SandboxID,
		"cellId":        cell.ID,
		"agent":         cell.Agent,
		"agentThreadId": cell.AgentThreadID,
		"stopReason":    cell.StopReason,
		"success":       cell.Success,
		"exitCode":      cell.ExitCode,
	})
	if err == nil {
		req.ResultJSON = string(resultJSON)
	}
	if execErr != nil {
		req.ExitCode = execution.FirstNonZeroInt(req.ExitCode, 1)
		req.Error = fmt.Sprintf("agent execution failed: %v", execErr)
		return req
	}
	if !cell.Success {
		req.ExitCode = execution.FirstNonZeroInt(req.ExitCode, 1)
		req.Error = "agent execution failed"
		if detail := firstNonEmpty(cell.Stderr, cell.Output); strings.TrimSpace(detail) != "" {
			req.Error += ": " + strings.TrimSpace(detail)
		}
	}
	return req
}

func CleanupPolicyStopsSandbox(policy agentcomposev2.RunSandboxCleanupPolicy) bool {
	return policy != agentcomposev2.RunSandboxCleanupPolicy_RUN_SANDBOX_CLEANUP_POLICY_KEEP_RUNNING
}

func CleanupPolicyRemovesSandbox(policy agentcomposev2.RunSandboxCleanupPolicy) bool {
	return policy == agentcomposev2.RunSandboxCleanupPolicy_RUN_SANDBOX_CLEANUP_POLICY_REMOVE_ON_COMPLETION
}
