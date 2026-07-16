package api

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	"agent-compose/pkg/resources"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type ResourceLocator interface {
	ResolveID(context.Context, resources.ResolveOptions) ([]resources.Target, []string, error)
}

type ResourceHandler struct {
	locator ResourceLocator
}

func NewResourceHandler(locator ResourceLocator) *ResourceHandler {
	return &ResourceHandler{locator: locator}
}

func (h *ResourceHandler) ResolveID(ctx context.Context, req *connect.Request[agentcomposev2.ResolveResourceIDRequest]) (*connect.Response[agentcomposev2.ResolveResourceIDResponse], error) {
	if h == nil || h.locator == nil {
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("resource locator is unavailable"))
	}
	id := strings.TrimSpace(req.Msg.GetId())
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("resource id is required"))
	}
	kinds := make([]resources.Kind, 0, len(req.Msg.GetKinds()))
	for _, kind := range req.Msg.GetKinds() {
		mapped, ok := resourceKindFromProto(kind)
		if !ok {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported resource kind %s", kind.String()))
		}
		kinds = append(kinds, mapped)
	}
	targets, warnings, err := h.locator.ResolveID(ctx, resources.ResolveOptions{ID: id, Kinds: kinds})
	if err != nil {
		if errors.Is(err, resources.ErrInvalidID) || errors.Is(err, resources.ErrUnsupportedKind) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	response := &agentcomposev2.ResolveResourceIDResponse{Warnings: append([]string(nil), warnings...)}
	for _, item := range targets {
		response.Targets = append(response.Targets, resourceTargetToProto(item))
	}
	return connect.NewResponse(response), nil
}

func resourceKindFromProto(kind agentcomposev2.ResourceKind) (resources.Kind, bool) {
	switch kind {
	case agentcomposev2.ResourceKind_RESOURCE_KIND_PROJECT:
		return resources.KindProject, true
	case agentcomposev2.ResourceKind_RESOURCE_KIND_AGENT:
		return resources.KindAgent, true
	case agentcomposev2.ResourceKind_RESOURCE_KIND_RUN:
		return resources.KindRun, true
	case agentcomposev2.ResourceKind_RESOURCE_KIND_SANDBOX:
		return resources.KindSandbox, true
	case agentcomposev2.ResourceKind_RESOURCE_KIND_IMAGE:
		return resources.KindImage, true
	case agentcomposev2.ResourceKind_RESOURCE_KIND_CACHE:
		return resources.KindCache, true
	default:
		return "", false
	}
}

func resourceTargetToProto(item resources.Target) *agentcomposev2.ResourceTarget {
	kinds := map[resources.Kind]agentcomposev2.ResourceKind{
		resources.KindProject: agentcomposev2.ResourceKind_RESOURCE_KIND_PROJECT,
		resources.KindAgent:   agentcomposev2.ResourceKind_RESOURCE_KIND_AGENT,
		resources.KindRun:     agentcomposev2.ResourceKind_RESOURCE_KIND_RUN,
		resources.KindSandbox: agentcomposev2.ResourceKind_RESOURCE_KIND_SANDBOX,
		resources.KindImage:   agentcomposev2.ResourceKind_RESOURCE_KIND_IMAGE,
		resources.KindCache:   agentcomposev2.ResourceKind_RESOURCE_KIND_CACHE,
	}
	return &agentcomposev2.ResourceTarget{
		Kind: kinds[item.Kind], Id: item.ID, ShortId: item.ShortID,
		ProjectId: item.ProjectID, ProjectName: item.ProjectName, AgentName: item.AgentName,
	}
}
