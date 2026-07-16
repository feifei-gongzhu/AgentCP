package api

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"connectrpc.com/connect"

	"agent-compose/pkg/cache"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type CacheController interface {
	ListCaches(context.Context, cache.ListRequest) (cache.ListResult, error)
	InspectCache(context.Context, string) (cache.ListResult, error)
	PruneCaches(context.Context, cache.PruneRequest) (cache.Result, error)
	RemoveCache(context.Context, cache.RemoveRequest) (cache.Result, error)
}

type CacheHandler struct {
	controller CacheController
}

func NewCacheHandler(controller CacheController) *CacheHandler {
	return &CacheHandler{controller: controller}
}

func (h *CacheHandler) ListCaches(ctx context.Context, req *connect.Request[agentcomposev2.ListCachesRequest]) (*connect.Response[agentcomposev2.ListCachesResponse], error) {
	if h == nil || h.controller == nil {
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("cache controller is unavailable"))
	}
	filter, err := RuntimeCacheFilterFromProto(req.Msg.GetFilter())
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	result, err := h.controller.ListCaches(ctx, cache.ListRequest{Filter: filter})
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	return connect.NewResponse(&agentcomposev2.ListCachesResponse{
		Caches:   RuntimeCacheItemsToProto(result.Items),
		Warnings: result.Warnings,
	}), nil
}

func (h *CacheHandler) InspectCache(ctx context.Context, req *connect.Request[agentcomposev2.InspectCacheRequest]) (*connect.Response[agentcomposev2.InspectCacheResponse], error) {
	if h == nil || h.controller == nil {
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("cache controller is unavailable"))
	}
	cacheID := strings.TrimSpace(req.Msg.GetCacheId())
	if cacheID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("cache_id is required"))
	}
	if err := cache.ValidateCacheIDReference(cacheID); err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	result, err := h.controller.InspectCache(ctx, cacheID)
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	if len(result.Items) == 0 {
		return nil, ConnectErrorForRuntimeCache(fmt.Errorf("%w: %s", cache.ErrCacheNotFound, cacheID))
	}
	return connect.NewResponse(&agentcomposev2.InspectCacheResponse{
		Cache:    RuntimeCacheItemToProto(result.Items[0]),
		Warnings: result.Warnings,
	}), nil
}

func (h *CacheHandler) PruneCaches(ctx context.Context, req *connect.Request[agentcomposev2.PruneCachesRequest]) (*connect.Response[agentcomposev2.PruneCachesResponse], error) {
	if h == nil || h.controller == nil {
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("cache controller is unavailable"))
	}
	filter, err := RuntimeCacheFilterFromProto(req.Msg.GetFilter())
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	result, err := h.controller.PruneCaches(ctx, cache.PruneRequest{
		Filter: filter,
		Force:  req.Msg.GetForce(),
	})
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	return connect.NewResponse(RuntimeCacheResultToPruneProto(result)), nil
}

func (h *CacheHandler) RemoveCache(ctx context.Context, req *connect.Request[agentcomposev2.RemoveCacheRequest]) (*connect.Response[agentcomposev2.RemoveCacheResponse], error) {
	if h == nil || h.controller == nil {
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("cache controller is unavailable"))
	}
	cacheID := strings.TrimSpace(req.Msg.GetCacheId())
	if cacheID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("cache_id is required"))
	}
	if err := cache.ValidateCacheIDReference(cacheID); err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	result, err := h.controller.RemoveCache(ctx, cache.RemoveRequest{
		CacheID: cacheID,
		Force:   req.Msg.GetForce(),
	})
	if err != nil {
		return nil, ConnectErrorForRuntimeCache(err)
	}
	return connect.NewResponse(RuntimeCacheResultToRemoveProto(result)), nil
}

func RuntimeCacheFilterFromProto(filter *agentcomposev2.CacheFilter) (cache.Filter, error) {
	if filter == nil {
		return cache.Filter{}, nil
	}
	domain, err := RuntimeCacheDomainFromProto(filter.GetDomain())
	if err != nil {
		return cache.Filter{}, err
	}
	status, err := RuntimeCacheStatusFromProto(filter.GetStatus())
	if err != nil {
		return cache.Filter{}, err
	}
	olderThan, err := RuntimeCacheOlderThanFromProto(filter.GetOlderThanSeconds())
	if err != nil {
		return cache.Filter{}, err
	}
	cacheType, ok := cache.NormalizeType(cache.CacheType(filter.GetType()))
	if !ok {
		return cache.Filter{}, fmt.Errorf("%w: unknown type %q", cache.ErrInvalidFilter, filter.GetType())
	}
	out := cache.Filter{
		Driver:    strings.TrimSpace(filter.GetDriver()),
		Domain:    domain,
		Type:      cacheType,
		Status:    status,
		OlderThan: olderThan,
		CacheID:   strings.TrimSpace(filter.GetCacheId()),
	}
	if _, err := cache.NormalizeFilter(out); err != nil {
		return cache.Filter{}, err
	}
	return out, nil
}

func RuntimeCacheOlderThanFromProto(seconds uint64) (time.Duration, error) {
	if seconds == 0 {
		return 0, nil
	}
	if seconds > uint64(math.MaxInt64/int64(time.Second)) {
		return 0, fmt.Errorf("%w: older_than_seconds is too large", cache.ErrInvalidFilter)
	}
	return time.Duration(seconds) * time.Second, nil
}

func RuntimeCacheDomainFromProto(domain agentcomposev2.CacheDomain) (cache.Domain, error) {
	switch domain {
	case agentcomposev2.CacheDomain_CACHE_DOMAIN_UNSPECIFIED:
		return "", nil
	case agentcomposev2.CacheDomain_CACHE_DOMAIN_OCI_IMAGE_STORE:
		return cache.DomainOCIImageStore, nil
	case agentcomposev2.CacheDomain_CACHE_DOMAIN_MATERIALIZED_IMAGE_CACHE:
		return cache.DomainMaterializedImageCache, nil
	case agentcomposev2.CacheDomain_CACHE_DOMAIN_RUNTIME_DERIVED_CACHE:
		return cache.DomainRuntimeDerivedCache, nil
	case agentcomposev2.CacheDomain_CACHE_DOMAIN_SKILL_ARTIFACT_CACHE:
		return cache.DomainSkillArtifactCache, nil
	default:
		return "", fmt.Errorf("%w: unknown domain %d", cache.ErrInvalidFilter, domain)
	}
}

func RuntimeCacheDomainToProto(domain cache.Domain) agentcomposev2.CacheDomain {
	switch domain {
	case cache.DomainOCIImageStore:
		return agentcomposev2.CacheDomain_CACHE_DOMAIN_OCI_IMAGE_STORE
	case cache.DomainMaterializedImageCache:
		return agentcomposev2.CacheDomain_CACHE_DOMAIN_MATERIALIZED_IMAGE_CACHE
	case cache.DomainRuntimeDerivedCache:
		return agentcomposev2.CacheDomain_CACHE_DOMAIN_RUNTIME_DERIVED_CACHE
	case cache.DomainSkillArtifactCache:
		return agentcomposev2.CacheDomain_CACHE_DOMAIN_SKILL_ARTIFACT_CACHE
	default:
		return agentcomposev2.CacheDomain_CACHE_DOMAIN_UNSPECIFIED
	}
}

func RuntimeCacheStatusFromProto(status agentcomposev2.CacheStatus) (cache.Status, error) {
	switch status {
	case agentcomposev2.CacheStatus_CACHE_STATUS_UNSPECIFIED:
		return "", nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_ACTIVE:
		return cache.StatusActive, nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_REFERENCED:
		return cache.StatusReferenced, nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_UNUSED:
		return cache.StatusUnused, nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_EXPIRED:
		return cache.StatusExpired, nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_ORPHANED:
		return cache.StatusOrphaned, nil
	case agentcomposev2.CacheStatus_CACHE_STATUS_UNKNOWN:
		return cache.StatusUnknown, nil
	default:
		return "", fmt.Errorf("%w: unknown status %d", cache.ErrInvalidFilter, status)
	}
}

func RuntimeCacheStatusToProto(status cache.Status) agentcomposev2.CacheStatus {
	switch status {
	case cache.StatusActive:
		return agentcomposev2.CacheStatus_CACHE_STATUS_ACTIVE
	case cache.StatusReferenced:
		return agentcomposev2.CacheStatus_CACHE_STATUS_REFERENCED
	case cache.StatusUnused:
		return agentcomposev2.CacheStatus_CACHE_STATUS_UNUSED
	case cache.StatusExpired:
		return agentcomposev2.CacheStatus_CACHE_STATUS_EXPIRED
	case cache.StatusOrphaned:
		return agentcomposev2.CacheStatus_CACHE_STATUS_ORPHANED
	case cache.StatusUnknown:
		return agentcomposev2.CacheStatus_CACHE_STATUS_UNKNOWN
	default:
		return agentcomposev2.CacheStatus_CACHE_STATUS_UNSPECIFIED
	}
}

func RuntimeCacheItemToProto(item cache.Item) *agentcomposev2.CacheItem {
	out := &agentcomposev2.CacheItem{
		CacheId:        item.CacheID,
		Domain:         RuntimeCacheDomainToProto(item.Domain),
		Driver:         item.Driver,
		Kind:           item.Kind,
		Path:           item.Path,
		SizeBytes:      item.SizeBytes,
		ImageId:        item.ImageID,
		ImageRef:       item.ImageRef,
		ResolvedRef:    item.ResolvedRef,
		Status:         RuntimeCacheStatusToProto(item.Status),
		Removable:      item.Removable,
		BlockedReasons: item.BlockedReasons,
		LastUsedSource: item.LastUsedSource,
		References:     RuntimeCacheReferencesToProto(item.References),
		Warnings:       item.Warnings,
	}
	if !item.LastUsedAt.IsZero() {
		out.LastUsedAt = item.LastUsedAt.UTC().Format(time.RFC3339Nano)
	}
	return out
}

func RuntimeCacheItemsToProto(items []cache.Item) []*agentcomposev2.CacheItem {
	out := make([]*agentcomposev2.CacheItem, 0, len(items))
	for _, item := range items {
		out = append(out, RuntimeCacheItemToProto(item))
	}
	return out
}

func RuntimeCacheReferencesToProto(refs []cache.Reference) []*agentcomposev2.CacheReference {
	out := make([]*agentcomposev2.CacheReference, 0, len(refs))
	for _, ref := range refs {
		out = append(out, &agentcomposev2.CacheReference{
			Policy:      RuntimeCacheReferencePolicyToProto(ref.Policy),
			Type:        ref.Type,
			Id:          ref.ID,
			Name:        ref.Name,
			Path:        ref.Path,
			Status:      ref.Status,
			Description: ref.Description,
		})
	}
	return out
}

func RuntimeCacheReferencePolicyToProto(policy cache.ReferencePolicy) agentcomposev2.CacheReferencePolicy {
	if cache.NormalizeReferencePolicy(policy) == cache.ReferencePolicyAdvisory {
		return agentcomposev2.CacheReferencePolicy_CACHE_REFERENCE_POLICY_ADVISORY
	}
	return agentcomposev2.CacheReferencePolicy_CACHE_REFERENCE_POLICY_REQUIRED
}

func RuntimeCacheResultToPruneProto(result cache.Result) *agentcomposev2.PruneCachesResponse {
	return &agentcomposev2.PruneCachesResponse{
		DryRun:   result.DryRun,
		Matched:  RuntimeCacheItemsToProto(result.Matched),
		Removed:  result.Removed,
		Skipped:  RuntimeCacheItemsToProto(result.Skipped),
		Warnings: result.Warnings,
	}
}

func RuntimeCacheResultToRemoveProto(result cache.Result) *agentcomposev2.RemoveCacheResponse {
	return &agentcomposev2.RemoveCacheResponse{
		DryRun:   result.DryRun,
		Matched:  RuntimeCacheItemsToProto(result.Matched),
		Removed:  result.Removed,
		Skipped:  RuntimeCacheItemsToProto(result.Skipped),
		Warnings: result.Warnings,
	}
}

func ConnectErrorForRuntimeCache(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, cache.ErrCacheNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, cache.ErrInvalidFilter), errors.Is(err, cache.ErrInvalidCacheID), errors.Is(err, cache.ErrAmbiguousCacheID):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, cache.ErrUnsafePath):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, cache.ErrRemoveUnavailable):
		return connect.NewError(connect.CodeUnavailable, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}
