package runs

import (
	"context"
	"fmt"
	"strings"

	domain "agent-compose/pkg/model"
)

type ProjectSandboxRunStore interface {
	ListProjectSandboxRuns(context.Context, domain.ProjectSandboxRelationFilter) ([]domain.ProjectRunRecord, error)
}

type SandboxStore interface {
	GetSandbox(context.Context, string) (*domain.Sandbox, error)
}

func ListProjectSandboxStatuses(ctx context.Context, runStore ProjectSandboxRunStore, sandboxStore SandboxStore, filter domain.ProjectSandboxRelationFilter) ([]domain.ProjectSandboxStatus, error) {
	if runStore == nil {
		return nil, fmt.Errorf("config store is required")
	}
	if sandboxStore == nil {
		return nil, fmt.Errorf("sandbox store is required")
	}
	runs, err := runStore.ListProjectSandboxRuns(ctx, filter)
	if err != nil {
		return nil, err
	}
	items := make([]domain.ProjectSandboxStatus, 0, len(runs))
	seenSandboxes := make(map[string]struct{}, len(runs))
	for _, run := range runs {
		sandboxID := strings.TrimSpace(run.SandboxID)
		if sandboxID == "" {
			continue
		}
		if _, ok := seenSandboxes[sandboxID]; ok {
			continue
		}
		seenSandboxes[sandboxID] = struct{}{}
		item := domain.ProjectSandboxStatus{Run: run}
		sandbox, err := sandboxStore.GetSandbox(ctx, sandboxID)
		if err != nil {
			item.SandboxMissing = true
		} else {
			item.Sandbox = sandbox
		}
		items = append(items, item)
	}
	return items, nil
}
