//go:build linux && cgo && (boxlitecgo || microsandboxcgo)

package driver

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDockerJupyterAutomaticPortsSmoke(t *testing.T) {
	runtimeSmokeEnabled(t, RuntimeDriverDocker)
	image := strings.TrimSpace(os.Getenv("SMOKE_DOCKER_JUPYTER_IMAGE"))
	if image == "" {
		t.Skip("set SMOKE_DOCKER_JUPYTER_IMAGE to a Docker image containing JupyterLab")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	config := newRuntimeSmokeConfig(t, RuntimeDriverDocker)
	config.DockerDefaultImage = image
	config.JupyterReadyTimeout = 2 * time.Minute
	runtime := &dockerRuntime{config: config}

	type runningSandbox struct {
		sandbox    *Sandbox
		vmState    VMState
		proxyState ProxyState
	}
	running := make([]runningSandbox, 0, 2)
	hostPorts := map[int]struct{}{}
	for range 2 {
		sandbox, vmState, proxyState := newRuntimeSmokeSandbox(t, ctx, config, RuntimeDriverDocker)
		sandbox.Summary.GuestImage = image
		vmState.Image = image
		proxyState.Enabled = true
		proxyState.Token = sandbox.Summary.ID
		cleanupRuntimeSmokeSandbox(t, config, runtime, sandbox, vmState)
		info, err := runtime.EnsureSandbox(ctx, sandbox, vmState, proxyState)
		if err != nil {
			t.Fatalf("EnsureSandbox(%s) error = %v", sandbox.Summary.ID, err)
		}
		if info.ProxyState == nil || info.ProxyState.HostPort <= 0 || info.ProxyState.GuestHost != "127.0.0.1" {
			t.Fatalf("EnsureSandbox(%s) proxy state = %+v, want host-mapped target", sandbox.Summary.ID, info.ProxyState)
		}
		if _, duplicate := hostPorts[info.ProxyState.HostPort]; duplicate {
			t.Fatalf("Docker assigned duplicate Jupyter host port %d", info.ProxyState.HostPort)
		}
		hostPorts[info.ProxyState.HostPort] = struct{}{}
		vmState.BoxID = info.BoxID
		proxyState = *info.ProxyState
		running = append(running, runningSandbox{sandbox: sandbox, vmState: vmState, proxyState: proxyState})
	}

	first := running[0]
	missing, err := runtime.StopSandbox(ctx, first.sandbox, first.vmState)
	if err != nil || missing {
		t.Fatalf("StopSandbox() missing=%v error=%v", missing, err)
	}
	first.vmState.StoppedAt = time.Now().UTC()
	resumed, err := runtime.EnsureSandbox(ctx, first.sandbox, first.vmState, first.proxyState)
	if err != nil {
		t.Fatalf("resume EnsureSandbox() error = %v", err)
	}
	if resumed.ProxyState == nil || resumed.ProxyState.HostPort <= 0 || resumed.ProxyState.GuestHost != "127.0.0.1" {
		t.Fatalf("resumed proxy state = %+v, want refreshed host-mapped target", resumed.ProxyState)
	}
}

func TestDockerStopResumePreservesWritableLayerSmoke(t *testing.T) {
	runtimeSmokeEnabled(t, RuntimeDriverDocker)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	config := newRuntimeSmokeConfig(t, RuntimeDriverDocker)
	runtime := &dockerRuntime{config: config}
	session, vmState, proxyState := newRuntimeSmokeSandbox(t, ctx, config, RuntimeDriverDocker)
	assertRuntimeStopResumePreservesWritableLayer(t, ctx, config, runtime, session, vmState, proxyState)
}

func TestDockerCommandInteractionSmokeCatStdinEOF(t *testing.T) {
	runtimeSmokeEnabled(t, RuntimeDriverDocker)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	config := newRuntimeSmokeConfig(t, RuntimeDriverDocker)
	runtime := &dockerRuntime{config: config}
	session, vmState, proxyState := newRuntimeSmokeSandbox(t, ctx, config, RuntimeDriverDocker)
	proxyState.Enabled = false

	info, err := runtime.EnsureSandbox(ctx, session, vmState, proxyState)
	if err != nil {
		t.Fatalf("EnsureSandbox() error = %v", err)
	}
	vmState.BoxID = info.BoxID
	cleanupRuntimeSmokeSandbox(t, config, runtime, session, vmState)

	interaction, err := runtime.OpenInteraction(ctx, session, vmState, RuntimeStartSpec{
		OperationID: "smoke-cat",
		Kind:        RuntimeOperationCommand,
		AttachStdin: true,
		Command:     &RuntimeCommandSpec{Command: "cat"},
	})
	if err != nil {
		t.Fatalf("OpenInteraction() error = %v", err)
	}
	if frame, err := interaction.Recv(); err != nil || frame.Type != RuntimeOutputStarted {
		t.Fatalf("started frame = %#v, err=%v", frame, err)
	}
	if err := interaction.Send(RuntimeInputFrame{Type: RuntimeInputStdin, Data: []byte("hello attach\n")}); err != nil {
		t.Fatalf("Send(stdin) error = %v", err)
	}
	if err := interaction.CloseSend(); err != nil {
		t.Fatalf("CloseSend() error = %v", err)
	}

	var stdout string
	for {
		frame, err := interaction.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Recv() error = %v", err)
		}
		switch frame.Type {
		case RuntimeOutputStdout:
			stdout += string(frame.Data)
		case RuntimeOutputResult:
			if frame.Result == nil || !frame.Result.Success || frame.Result.ExitCode != 0 {
				t.Fatalf("result frame = %#v", frame)
			}
		case RuntimeOutputError:
			t.Fatalf("unexpected error frame = %#v", frame)
		}
	}
	result, err := interaction.Wait()
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if !result.Success || result.ExitCode != 0 {
		t.Fatalf("Wait() result = %#v", result)
	}
	if stdout != "hello attach\n" {
		t.Fatalf("stdout = %q, want %q", stdout, "hello attach\n")
	}
}
