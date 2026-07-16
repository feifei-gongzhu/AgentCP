package adapters

import (
	"testing"

	"connectrpc.com/connect"

	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func TestImageBackendsBackendForStoreErrorCodes(t *testing.T) {
	if _, err := (*ImageBackends)(nil).BackendForStore(agentcomposev2.ImageStoreKind_IMAGE_STORE_KIND_DOCKER_DAEMON); connect.CodeOf(err) != connect.CodeInternal {
		t.Fatalf("missing docker backend error code = %v, want %v", connect.CodeOf(err), connect.CodeInternal)
	}
	if _, err := (*ImageBackends)(nil).BackendForStore(agentcomposev2.ImageStoreKind(99)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unsupported image store error code = %v, want %v", connect.CodeOf(err), connect.CodeInvalidArgument)
	}
}
