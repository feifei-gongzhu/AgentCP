package workspaces

import (
	"context"
	"fmt"
	"strings"

	appconfig "agent-compose/pkg/config"
	domain "agent-compose/pkg/model"
)

type workspace interface {
	Prepare(context.Context, *domain.Sandbox) error
}

func newWorkspace(config *appconfig.Config, workspace domain.WorkspaceConfig) (workspace, error) {
	switch strings.ToLower(strings.TrimSpace(workspace.Type)) {
	case "git":
		return gitWorkspace{workspace: workspace}, nil
	case "file":
		return fileWorkspace{config: config, workspace: workspace}, nil
	default:
		return nil, fmt.Errorf("unsupported workspace type %q", workspace.Type)
	}
}
