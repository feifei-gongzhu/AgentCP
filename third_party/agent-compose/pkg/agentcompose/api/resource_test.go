package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	"agent-compose/pkg/resources"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type resourceLocatorStub struct {
	options resources.ResolveOptions
}

func (s *resourceLocatorStub) ResolveID(_ context.Context, options resources.ResolveOptions) ([]resources.Target, []string, error) {
	s.options = options
	return []resources.Target{{Kind: resources.KindRun, ID: "run-id", ShortID: "run-short", ProjectID: "project-id"}}, []string{"partial source unavailable"}, nil
}

func TestResourceHandlerResolveID(t *testing.T) {
	locator := &resourceLocatorStub{}
	handler := NewResourceHandler(locator)
	response, err := handler.ResolveID(context.Background(), connect.NewRequest(&agentcomposev2.ResolveResourceIDRequest{
		Id: "123456789abc", Kinds: []agentcomposev2.ResourceKind{agentcomposev2.ResourceKind_RESOURCE_KIND_RUN},
	}))
	if err != nil {
		t.Fatalf("ResolveID returned error: %v", err)
	}
	if locator.options.ID != "123456789abc" || len(locator.options.Kinds) != 1 || locator.options.Kinds[0] != resources.KindRun {
		t.Fatalf("locator options = %#v", locator.options)
	}
	if len(response.Msg.GetTargets()) != 1 || response.Msg.GetTargets()[0].GetProjectId() != "project-id" || len(response.Msg.GetWarnings()) != 1 {
		t.Fatalf("response = %#v", response.Msg)
	}
}

func TestResourceHandlerRejectsMissingAndUnknownKinds(t *testing.T) {
	handler := NewResourceHandler(&resourceLocatorStub{})
	if _, err := handler.ResolveID(context.Background(), connect.NewRequest(&agentcomposev2.ResolveResourceIDRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("missing id error = %v", err)
	}
	if _, err := handler.ResolveID(context.Background(), connect.NewRequest(&agentcomposev2.ResolveResourceIDRequest{Id: "123456789abc", Kinds: []agentcomposev2.ResourceKind{agentcomposev2.ResourceKind_RESOURCE_KIND_UNSPECIFIED}})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unknown kind error = %v", err)
	}
}
