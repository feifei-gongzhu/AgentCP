package main

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func TestIntegrationCLIInspectResolvesUntypedImageID(t *testing.T) {
	testCLIInspectResolvesUntypedImageID(t)
}

func TestE2ECLIInspectResolvesUntypedImageID(t *testing.T) {
	testCLIInspectResolvesUntypedImageID(t)
}

func testCLIInspectResolvesUntypedImageID(t *testing.T) {
	t.Helper()
	imageID := "sha256:" + strings.Repeat("a", 64)
	server := newComposeServiceStubServer(t, composeServiceStubs{
		resource: resourceServiceStub{resolveID: func(_ context.Context, req *connect.Request[agentcomposev2.ResolveResourceIDRequest]) (*connect.Response[agentcomposev2.ResolveResourceIDResponse], error) {
			if req.Msg.GetId() != strings.Repeat("a", 12) || len(req.Msg.GetKinds()) != 0 {
				t.Fatalf("ResolveID request = %#v", req.Msg)
			}
			return connect.NewResponse(&agentcomposev2.ResolveResourceIDResponse{Targets: []*agentcomposev2.ResourceTarget{{Kind: agentcomposev2.ResourceKind_RESOURCE_KIND_IMAGE, Id: imageID}}}), nil
		}},
		image: imageServiceStub{inspectImage: func(_ context.Context, req *connect.Request[agentcomposev2.InspectImageRequest]) (*connect.Response[agentcomposev2.InspectImageResponse], error) {
			if req.Msg.GetImageRef() != imageID {
				t.Fatalf("InspectImage ref = %q", req.Msg.GetImageRef())
			}
			return connect.NewResponse(&agentcomposev2.InspectImageResponse{Image: testCLIImage(imageID, "agent:latest")}), nil
		}},
	})
	defer server.Close()

	stdout, stderr, _, exitCode := executeCLICommand("inspect", "--host", server.URL, strings.Repeat("a", 12))
	if exitCode != 0 || stderr != "" || !strings.Contains(stdout, strings.Repeat("a", 64)) {
		t.Fatalf("inspect code/stdout/stderr = %d/%q/%q", exitCode, stdout, stderr)
	}
}

func TestIntegrationCLILogsResolvesUntypedRunIDWithoutComposeFile(t *testing.T) {
	testCLILogsResolvesUntypedRunIDWithoutComposeFile(t)
}

func TestE2ECLILogsResolvesUntypedRunIDWithoutComposeFile(t *testing.T) {
	testCLILogsResolvesUntypedRunIDWithoutComposeFile(t)
}

func testCLILogsResolvesUntypedRunIDWithoutComposeFile(t *testing.T) {
	t.Helper()
	projectID := strings.Repeat("b", 64)
	runID := strings.Repeat("c", 64)
	server := newComposeServiceStubServer(t, composeServiceStubs{
		resource: resourceServiceStub{resolveID: func(_ context.Context, req *connect.Request[agentcomposev2.ResolveResourceIDRequest]) (*connect.Response[agentcomposev2.ResolveResourceIDResponse], error) {
			if len(req.Msg.GetKinds()) != 4 {
				t.Fatalf("ResolveID kinds = %v", req.Msg.GetKinds())
			}
			return connect.NewResponse(&agentcomposev2.ResolveResourceIDResponse{Targets: []*agentcomposev2.ResourceTarget{{Kind: agentcomposev2.ResourceKind_RESOURCE_KIND_RUN, Id: runID, ProjectId: projectID}}}), nil
		}},
		run: runServiceStub{getRun: func(_ context.Context, req *connect.Request[agentcomposev2.GetRunRequest]) (*connect.Response[agentcomposev2.GetRunResponse], error) {
			if req.Msg.GetProjectId() != projectID || req.Msg.GetRunId() != runID {
				t.Fatalf("GetRun request = %#v", req.Msg)
			}
			return connect.NewResponse(&agentcomposev2.GetRunResponse{Run: testRunDetail(projectID, runID, "reviewer", "sandbox-id", agentcomposev2.RunStatus_RUN_STATUS_SUCCEEDED, 0, "resolved log output\n")}), nil
		}},
	})
	defer server.Close()

	stdout, stderr, _, exitCode := executeCLICommand("logs", "--host", server.URL, strings.Repeat("c", 12))
	if exitCode != 0 || stderr != "" || !strings.Contains(stdout, "resolved log output") {
		t.Fatalf("logs code/stdout/stderr = %d/%q/%q", exitCode, stdout, stderr)
	}
}
