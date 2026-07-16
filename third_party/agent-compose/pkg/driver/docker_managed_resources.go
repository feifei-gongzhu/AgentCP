package driver

import (
	"context"
	"fmt"
	"strings"
	"time"

	appconfig "agent-compose/pkg/config"
	containerapi "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

type ManagedRuntimeResource struct {
	Driver         string
	RuntimeID      string
	SandboxID      string
	UpdatedAt      time.Time
	OwnershipValid bool
	Removable      bool
	BlockedReasons []string
	OwnedPaths     []string
}

func ListDockerManagedResources(ctx context.Context, config *appconfig.Config) ([]ManagedRuntimeResource, error) {
	runtime := &dockerRuntime{config: config}
	dockerClient, err := runtime.newClient()
	if err != nil {
		return nil, err
	}
	defer func() { _ = dockerClient.Close() }()
	args := filters.NewArgs()
	args.Add("label", dockerSandboxLabelID)
	args.Add("label", dockerSandboxLabelDriver+"="+RuntimeDriverDocker)
	containers, err := dockerClient.ContainerList(ctx, containerapi.ListOptions{All: true, Filters: args})
	if err != nil {
		return nil, fmt.Errorf("list agent-compose docker containers: %w", err)
	}
	resources := make([]ManagedRuntimeResource, 0, len(containers))
	for _, container := range containers {
		sandboxID := strings.TrimSpace(container.Labels[dockerSandboxLabelID])
		driver := strings.TrimSpace(container.Labels[dockerSandboxLabelDriver])
		valid := sandboxID != "" && driver == RuntimeDriverDocker
		resource := ManagedRuntimeResource{Driver: RuntimeDriverDocker, RuntimeID: container.ID, SandboxID: sandboxID, UpdatedAt: time.Unix(container.Created, 0).UTC(), OwnershipValid: valid, Removable: valid}
		if !valid {
			resource.BlockedReasons = append(resource.BlockedReasons, "docker ownership labels are incomplete")
		}
		resources = append(resources, resource)
	}
	return resources, nil
}

func RemoveDockerManagedResource(ctx context.Context, config *appconfig.Config, resource ManagedRuntimeResource) error {
	if !resource.OwnershipValid || resource.Driver != RuntimeDriverDocker || strings.TrimSpace(resource.RuntimeID) == "" || strings.TrimSpace(resource.SandboxID) == "" {
		return fmt.Errorf("docker managed resource ownership is incomplete")
	}
	runtime := &dockerRuntime{config: config}
	dockerClient, err := runtime.newClient()
	if err != nil {
		return err
	}
	defer func() { _ = dockerClient.Close() }()
	container, err := dockerClient.ContainerInspect(ctx, resource.RuntimeID)
	if err != nil {
		if isDockerNotFound(err) {
			return nil
		}
		return err
	}
	if container.Config == nil || container.Config.Labels[dockerSandboxLabelID] != resource.SandboxID || container.Config.Labels[dockerSandboxLabelDriver] != RuntimeDriverDocker {
		return fmt.Errorf("docker ownership labels changed before removal")
	}
	if err := dockerClient.ContainerRemove(ctx, resource.RuntimeID, containerapi.RemoveOptions{Force: true}); err != nil && !isDockerNotFound(err) {
		return err
	}
	return nil
}
