package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	domain "agent-compose/pkg/model"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
	"agent-compose/proto/agentcompose/v2/agentcomposev2connect"
)

const dockerJupyterE2EImageEnv = "AGENT_COMPOSE_E2E_DOCKER_JUPYTER_IMAGE"

func TestE2EDockerJupyterHostDaemonStopResume(t *testing.T) {
	image := strings.TrimSpace(os.Getenv(dockerJupyterE2EImageEnv))
	if image == "" {
		t.Skipf("set %s to a Docker image containing JupyterLab", dockerJupyterE2EImageEnv)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	repoRoot := e2eRepoRoot(t)
	testRoot, err := os.MkdirTemp(repoRoot, ".docker-jupyter-e2e-")
	if err != nil {
		t.Fatalf("create Docker-visible test root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(testRoot) })
	dockerClient := newE2EDockerClient(t, ctx, image)
	if hostname, hostErr := os.Hostname(); hostErr == nil {
		if _, inspectErr := dockerClient.ContainerInspect(ctx, hostname); inspectErr == nil {
			t.Skip("host-daemon Jupyter E2E requires the test runner to run outside Docker")
		}
	}

	binary := e2eDaemonBinary(t, ctx, repoRoot, testRoot)
	listenAddress := unusedLoopbackAddress(t)
	baseURL := "http://" + listenAddress
	daemon := startE2EDaemon(t, binary, repoRoot, testRoot, listenAddress, image)
	waitForE2EDaemon(t, ctx, daemon, baseURL)

	httpClient := newE2EHTTPClient()
	httpClient.Timeout = 3 * time.Minute
	projectClient := agentcomposev2connect.NewProjectServiceClient(httpClient, baseURL)
	runClient := agentcomposev2connect.NewRunServiceClient(httpClient, baseURL)
	sandboxClient := agentcomposev2connect.NewSandboxServiceClient(httpClient, baseURL)

	projectResp, err := projectClient.ApplyProject(ctx, connect.NewRequest(&agentcomposev2.ApplyProjectRequest{
		Spec: &agentcomposev2.ProjectSpec{
			Name: "docker-jupyter-e2e",
			Agents: []*agentcomposev2.AgentSpec{{
				Name:     "reviewer",
				Provider: "codex",
				Image:    image,
				Driver: &agentcomposev2.DriverSpec{
					Name:   "docker",
					Docker: &agentcomposev2.DockerDriverSpec{},
				},
			}},
		},
		Source: &agentcomposev2.ProjectSource{
			ComposePath: filepath.Join(testRoot, "agent-compose.yml"),
			ProjectDir:  testRoot,
		},
	}))
	if err != nil {
		t.Fatalf("ApplyProject returned error: %v\ndaemon log:\n%s", err, daemon.logs.String())
	}
	if !projectResp.Msg.GetApplied() || projectResp.Msg.GetProject() == nil || projectResp.Msg.GetProject().GetSummary() == nil {
		t.Fatalf("ApplyProject did not apply project; issues: %s", formatE2EProjectIssues(projectResp.Msg.GetIssues()))
	}
	projectID := projectResp.Msg.GetProject().GetSummary().GetProjectId()
	if projectID == "" {
		t.Fatalf("ApplyProject returned empty project ID: %#v", projectResp.Msg)
	}

	runResp, err := runClient.RunAgent(ctx, connect.NewRequest(&agentcomposev2.RunAgentRequest{
		ProjectId:       projectID,
		AgentName:       "reviewer",
		Command:         "printf docker-jupyter-e2e-ok",
		Source:          agentcomposev2.RunSource_RUN_SOURCE_API,
		CleanupPolicy:   agentcomposev2.RunSandboxCleanupPolicy_RUN_SANDBOX_CLEANUP_POLICY_KEEP_RUNNING,
		ClientRequestId: "docker-jupyter-e2e-" + strconv.FormatInt(time.Now().UnixNano(), 10),
		Jupyter: &agentcomposev2.RunJupyterSpec{
			Enabled: true,
			Expose:  true,
		},
	}))
	if err != nil {
		t.Fatalf("RunAgent returned error: %v\ndaemon log:\n%s", err, daemon.logs.String())
	}
	run := runResp.Msg.GetRun()
	sandboxID := run.GetSummary().GetSandboxId()
	if sandboxID == "" || run.GetSummary().GetStatus() != agentcomposev2.RunStatus_RUN_STATUS_SUCCEEDED || run.GetOutput() != "docker-jupyter-e2e-ok" {
		t.Fatalf("RunAgent sandbox_id=%q status=%s error=%q output_matches=%t", sandboxID, run.GetSummary().GetStatus(), run.GetSummary().GetError(), run.GetOutput() == "docker-jupyter-e2e-ok")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = sandboxClient.RemoveSandbox(cleanupCtx, connect.NewRequest(&agentcomposev2.RemoveSandboxRequest{SandboxId: sandboxID, Force: true}))
		removeE2EDockerSandboxFallback(t, cleanupCtx, dockerClient, sandboxID)
	})

	proxyPath := filepath.Join(testRoot, "sandboxes", sandboxID, "proxy", "jupyter.json")
	initialState := readE2EProxyState(t, proxyPath)
	assertE2EHostProxyState(t, initialState)
	containerID, initialDockerPort := inspectE2EDockerJupyterPort(t, ctx, dockerClient, sandboxID, initialState.GuestPort)
	if initialState.HostPort != initialDockerPort {
		t.Fatalf("initial proxy host port = %d, Docker binding = %d", initialState.HostPort, initialDockerPort)
	}
	assertE2EJupyterReady(t, ctx, httpClient, baseURL, sandboxID, initialState)
	assertE2EJupyterReady(t, ctx, httpClient, "http://127.0.0.1:"+strconv.Itoa(initialState.HostPort), sandboxID, initialState)

	if _, err := sandboxClient.StopSandbox(ctx, connect.NewRequest(&agentcomposev2.StopSandboxRequest{SandboxId: sandboxID})); err != nil {
		t.Fatalf("StopSandbox returned error: %v", err)
	}
	staleState := readE2EProxyState(t, proxyPath)
	staleState.HostPort = 1
	writeE2EProxyState(t, proxyPath, staleState)

	if _, err := sandboxClient.ResumeSandbox(ctx, connect.NewRequest(&agentcomposev2.ResumeSandboxRequest{SandboxId: sandboxID})); err != nil {
		t.Fatalf("ResumeSandbox returned error: %v\ndaemon log:\n%s", err, daemon.logs.String())
	}
	resumedState := readE2EProxyState(t, proxyPath)
	assertE2EHostProxyState(t, resumedState)
	if resumedState.HostPort == staleState.HostPort {
		t.Fatalf("resumed proxy state retained stale host port %d", staleState.HostPort)
	}
	resumedContainerID, resumedDockerPort := inspectE2EDockerJupyterPort(t, ctx, dockerClient, sandboxID, resumedState.GuestPort)
	if resumedContainerID != containerID {
		t.Fatalf("resume used container %s, want existing container %s", resumedContainerID, containerID)
	}
	if resumedState.HostPort != resumedDockerPort {
		t.Fatalf("resumed proxy host port = %d, Docker binding = %d", resumedState.HostPort, resumedDockerPort)
	}
	assertE2EJupyterReady(t, ctx, httpClient, baseURL, sandboxID, resumedState)
	t.Logf("Docker Jupyter binding refreshed from persisted stale port to 127.0.0.1:%d", resumedState.HostPort)
}

func inspectE2EDockerJupyterPort(t *testing.T, ctx context.Context, dockerClient *client.Client, sandboxID string, guestPort int) (string, int) {
	t.Helper()
	containerInfo := inspectE2EDockerSandboxContainer(t, ctx, dockerClient, sandboxID)
	if containerInfo.NetworkSettings == nil {
		t.Fatal("Docker sandbox has no network settings")
	}
	port := nat.Port(strconv.Itoa(guestPort) + "/tcp")
	bindings := containerInfo.NetworkSettings.Ports[port]
	for _, binding := range bindings {
		if binding.HostIP != "127.0.0.1" {
			continue
		}
		hostPort, err := strconv.Atoi(binding.HostPort)
		if err == nil && hostPort > 0 {
			return containerInfo.ID, hostPort
		}
	}
	t.Fatalf("Docker sandbox bindings for %s = %#v, want non-zero 127.0.0.1 binding", port, bindings)
	return "", 0
}

func assertE2EJupyterReady(t *testing.T, ctx context.Context, client *http.Client, baseURL, sandboxID string, state domain.ProxyState) {
	t.Helper()
	endpoint := strings.TrimRight(baseURL, "/") + "/jupyter/" + sandboxID + "/api/kernelspecs?" + url.Values{"token": []string{state.Token}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatalf("create Jupyter request: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET Jupyter kernelspecs: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET Jupyter kernelspecs status = %d, want 200", resp.StatusCode)
	}
	var payload struct {
		Kernelspecs map[string]json.RawMessage `json:"kernelspecs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode Jupyter kernelspecs: %v", err)
	}
	if len(payload.Kernelspecs) == 0 {
		t.Fatal("Jupyter kernelspecs response is empty")
	}
}

func assertE2EHostProxyState(t *testing.T, state domain.ProxyState) {
	t.Helper()
	if !state.Enabled || !state.Exposed || state.GuestHost != "127.0.0.1" || state.HostPort <= 0 || state.GuestPort <= 0 || state.Token == "" {
		t.Fatalf("host daemon proxy state enabled=%t exposed=%t guest_host_present=%t host_port=%d guest_port=%d token_present=%t",
			state.Enabled, state.Exposed, strings.TrimSpace(state.GuestHost) != "", state.HostPort, state.GuestPort, state.Token != "")
	}
}

func readE2EProxyState(t *testing.T, path string) domain.ProxyState {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read proxy state: %v", err)
	}
	var state domain.ProxyState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("decode proxy state: %v", err)
	}
	return state
}

func writeE2EProxyState(t *testing.T, path string, state domain.ProxyState) {
	t.Helper()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatalf("encode proxy state: %v", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write proxy state: %v", err)
	}
}

func formatE2EProjectIssues(issues []*agentcomposev2.ProjectValidationIssue) string {
	parts := make([]string, 0, len(issues))
	for _, issue := range issues {
		parts = append(parts, fmt.Sprintf("%s: %s", issue.GetPath(), issue.GetMessage()))
	}
	return strings.Join(parts, "; ")
}
