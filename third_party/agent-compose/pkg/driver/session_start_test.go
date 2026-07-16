package driver

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	appconfig "agent-compose/pkg/config"
)

func TestDockerFirstRuntimeImageResolverSkipsDockerForNonDockerPrepare(t *testing.T) {
	called := false
	resolver := dockerFirstRuntimeImageResolver{ensureDocker: func(ctx context.Context, imageRef string, pullPolicy string, pullTimeout time.Duration) (string, error) {
		called = true
		return "", errors.New("docker unavailable")
	}}
	for _, driver := range []string{RuntimeDriverBoxlite, RuntimeDriverMicrosandbox} {
		resolved, err := resolver.ResolvePrepareImage(context.Background(), &appconfig.Config{}, driver, "guest:latest", "", 10*time.Minute)
		if err != nil {
			t.Fatalf("ResolvePrepareImage(%s) returned error: %v", driver, err)
		}
		if resolved != "guest:latest" {
			t.Fatalf("ResolvePrepareImage(%s) = %q", driver, resolved)
		}
	}
	if called {
		t.Fatalf("Docker ensure was called for non-Docker prepare")
	}
}

func TestPrepareSandboxStartBoxLiteDoesNotFailWhenDockerUnavailable(t *testing.T) {
	root := t.TempDir()
	config := testPrepareSandboxStartConfig(root)
	session := testRuntimeMountSandbox(root)
	resolver := dockerFirstRuntimeImageResolver{ensureDocker: func(ctx context.Context, imageRef string, pullPolicy string, pullTimeout time.Duration) (string, error) {
		return "", errors.New("docker unavailable")
	}}

	state, err := prepareSandboxStartWithResolver(context.Background(), config, RuntimeDriverBoxlite, session, VMState{}, "", 10*time.Minute, resolver)
	if err != nil {
		t.Fatalf("PrepareSandboxStart boxlite returned error: %v", err)
	}
	if state.Image != config.DefaultImage || state.Registry != config.ImageRegistry {
		t.Fatalf("boxlite state = %#v", state)
	}
	if _, err := loadDirectoryRuntimeMountManifest(session, RuntimeDriverBoxlite); err != nil {
		t.Fatalf("boxlite mount manifest was not written: %v", err)
	}
}

func TestPrepareSandboxStartDockerStillRequiresDockerEnsure(t *testing.T) {
	root := t.TempDir()
	config := testPrepareSandboxStartConfig(root)
	session := testRuntimeMountSandbox(root)
	wantErr := errors.New("docker unavailable")
	resolver := dockerFirstRuntimeImageResolver{ensureDocker: func(ctx context.Context, imageRef string, pullPolicy string, pullTimeout time.Duration) (string, error) {
		if imageRef != config.DockerDefaultImage {
			t.Fatalf("ensure imageRef = %q, want %q", imageRef, config.DockerDefaultImage)
		}
		return "", wantErr
	}}

	_, err := prepareSandboxStartWithResolver(context.Background(), config, RuntimeDriverDocker, session, VMState{}, "", 10*time.Minute, resolver)
	if !errors.Is(err, wantErr) {
		t.Fatalf("PrepareSandboxStart docker error = %v, want %v", err, wantErr)
	}
}

func TestPrepareSandboxStartDockerUsesResolvedImage(t *testing.T) {
	root := t.TempDir()
	config := testPrepareSandboxStartConfig(root)
	session := testRuntimeMountSandbox(root)
	resolver := dockerFirstRuntimeImageResolver{ensureDocker: func(ctx context.Context, imageRef string, pullPolicy string, pullTimeout time.Duration) (string, error) {
		return "guest@sha256:resolved", nil
	}}

	state, err := prepareSandboxStartWithResolver(context.Background(), config, RuntimeDriverDocker, session, VMState{}, "", 10*time.Minute, resolver)
	if err != nil {
		t.Fatalf("PrepareSandboxStart docker returned error: %v", err)
	}
	if state.Image != "guest@sha256:resolved" || state.Registry != "" {
		t.Fatalf("docker state = %#v", state)
	}
}

func testPrepareSandboxStartConfig(root string) *appconfig.Config {
	config := testRuntimeMountConfig()
	config.DataRoot = root
	config.SandboxRoot = filepath.Join(root, "sandboxes")
	config.DefaultImage = "boxlite-guest:latest"
	config.DockerDefaultImage = "docker-guest:latest"
	config.ImageRegistry = "registry.example"
	return config
}
