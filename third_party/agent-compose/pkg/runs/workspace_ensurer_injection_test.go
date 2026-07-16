package runs

import (
	"context"
	"testing"

	domain "agent-compose/pkg/model"
	"agent-compose/pkg/workspaces"
)

type controllerWorkspaceEnsurer struct{}

var _ workspaces.WorkspaceEnsurer = (*controllerWorkspaceEnsurer)(nil)

func (*controllerWorkspaceEnsurer) Ensure(context.Context, *domain.Sandbox) error {
	return nil
}

func TestControllerDependenciesInjectWorkspaceEnsurer(t *testing.T) {
	t.Parallel()

	ensurer := &controllerWorkspaceEnsurer{}
	controller := NewController(ControllerDependencies{WorkspaceEnsurer: ensurer})
	if controller.workspaceEnsurer != ensurer {
		t.Fatalf("Controller workspace ensurer = %p, want %p", controller.workspaceEnsurer, ensurer)
	}
}
