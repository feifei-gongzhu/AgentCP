package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"

	"agent-compose/pkg/cache"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func TestCacheHandlerListCachesMapsFilterAndResponse(t *testing.T) {
	item := testRuntimeCacheItem(t, cache.StatusOrphaned)
	controller := &fakeCacheController{
		listResult: cache.ListResult{Items: []cache.Item{item}, Warnings: []string{"top warning"}},
	}
	handler := NewCacheHandler(controller)

	resp, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{
		Driver:           cache.DriverMicrosandbox,
		Domain:           agentcomposev2.CacheDomain_CACHE_DOMAIN_SKILL_ARTIFACT_CACHE,
		Type:             string(cache.CacheTypeSkill),
		Status:           agentcomposev2.CacheStatus_CACHE_STATUS_ORPHANED,
		OlderThanSeconds: 7,
		CacheId:          item.CacheID,
	}}))
	if err != nil {
		t.Fatalf("ListCaches: %v", err)
	}
	if controller.listReq.Filter.Driver != cache.DriverMicrosandbox ||
		controller.listReq.Filter.Domain != cache.DomainSkillArtifactCache ||
		controller.listReq.Filter.Type != cache.CacheTypeSkill ||
		controller.listReq.Filter.Status != cache.StatusOrphaned ||
		controller.listReq.Filter.OlderThan != 7*time.Second ||
		controller.listReq.Filter.CacheID != item.CacheID {
		t.Fatalf("mapped filter = %#v", controller.listReq.Filter)
	}
	if len(resp.Msg.GetCaches()) != 1 {
		t.Fatalf("cache count = %d, want 1", len(resp.Msg.GetCaches()))
	}
	got := resp.Msg.GetCaches()[0]
	if got.GetCacheId() != item.CacheID ||
		got.GetDomain() != agentcomposev2.CacheDomain_CACHE_DOMAIN_SKILL_ARTIFACT_CACHE ||
		got.GetStatus() != agentcomposev2.CacheStatus_CACHE_STATUS_ORPHANED ||
		got.GetLastUsedAt() == "" ||
		len(got.GetReferences()) != 1 ||
		len(resp.Msg.GetWarnings()) != 1 {
		t.Fatalf("mapped response cache = %#v warnings=%#v", got, resp.Msg.GetWarnings())
	}
}

func TestCacheDomainFourRemainsReserved(t *testing.T) {
	if got := int32(agentcomposev2.CacheDomain_CACHE_DOMAIN_SKILL_ARTIFACT_CACHE); got != 5 {
		t.Fatalf("skill cache domain number = %d, want 5", got)
	}
	if _, err := RuntimeCacheDomainFromProto(agentcomposev2.CacheDomain(4)); err == nil {
		t.Fatal("reserved sandbox cache domain number 4 was accepted")
	}
}

func TestCacheHandlerInspectCache(t *testing.T) {
	item := testRuntimeCacheItem(t, cache.StatusUnknown)
	controller := &fakeCacheController{
		inspectResult: cache.ListResult{Items: []cache.Item{item}, Warnings: []string{"inspect warning"}},
	}
	handler := NewCacheHandler(controller)

	resp, err := handler.InspectCache(context.Background(), connect.NewRequest(&agentcomposev2.InspectCacheRequest{CacheId: item.CacheID}))
	if err != nil {
		t.Fatalf("InspectCache: %v", err)
	}
	if controller.inspectID != item.CacheID {
		t.Fatalf("inspectID = %q, want %q", controller.inspectID, item.CacheID)
	}
	if resp.Msg.GetCache().GetStatus() != agentcomposev2.CacheStatus_CACHE_STATUS_UNKNOWN ||
		resp.Msg.GetCache().GetRemovable() ||
		len(resp.Msg.GetWarnings()) != 1 {
		t.Fatalf("InspectCache response = %#v warnings=%#v", resp.Msg.GetCache(), resp.Msg.GetWarnings())
	}
}

func TestCacheHandlerInspectCacheAllowsIDPrefix(t *testing.T) {
	item := testRuntimeCacheItem(t, cache.StatusUnknown)
	prefix := cache.ShortCacheID(item.CacheID)
	controller := &fakeCacheController{
		inspectResult: cache.ListResult{Items: []cache.Item{item}},
	}
	handler := NewCacheHandler(controller)

	_, err := handler.InspectCache(context.Background(), connect.NewRequest(&agentcomposev2.InspectCacheRequest{CacheId: prefix}))
	if err != nil {
		t.Fatalf("InspectCache prefix: %v", err)
	}
	if controller.inspectID != prefix {
		t.Fatalf("inspectID = %q, want prefix %q", controller.inspectID, prefix)
	}
}

func TestCacheHandlerInspectCacheNotFound(t *testing.T) {
	handler := NewCacheHandler(&fakeCacheController{})
	_, err := handler.InspectCache(context.Background(), connect.NewRequest(&agentcomposev2.InspectCacheRequest{CacheId: testRuntimeCacheID(t, cache.StatusOrphaned)}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("InspectCache code = %v, want NotFound (err=%v)", connect.CodeOf(err), err)
	}
}

func TestCacheHandlerPruneCachesMapsRequestAndResult(t *testing.T) {
	matched := testRuntimeCacheItem(t, cache.StatusOrphaned)
	controller := &fakeCacheController{
		pruneResult: cache.Result{
			DryRun:   false,
			Matched:  []cache.Item{matched},
			Removed:  []string{matched.CacheID},
			Warnings: []string{"removed"},
		},
	}
	handler := NewCacheHandler(controller)

	resp, err := handler.PruneCaches(context.Background(), connect.NewRequest(&agentcomposev2.PruneCachesRequest{
		Filter: &agentcomposev2.CacheFilter{Status: agentcomposev2.CacheStatus_CACHE_STATUS_ORPHANED},
		Force:  true,
	}))
	if err != nil {
		t.Fatalf("PruneCaches: %v", err)
	}
	if controller.pruneReq.Filter.Status != cache.StatusOrphaned || !controller.pruneReq.Force {
		t.Fatalf("prune request = %#v", controller.pruneReq)
	}
	if resp.Msg.GetDryRun() || len(resp.Msg.GetMatched()) != 1 || len(resp.Msg.GetRemoved()) != 1 || len(resp.Msg.GetWarnings()) != 1 {
		t.Fatalf("PruneCaches response = %#v", resp.Msg)
	}
}

func TestCacheHandlerRemoveCacheProtectedSkipped(t *testing.T) {
	active := testRuntimeCacheItem(t, cache.StatusActive)
	controller := &fakeCacheController{
		removeResult: cache.Result{
			DryRun:  false,
			Matched: []cache.Item{active},
			Skipped: []cache.Item{active},
		},
	}
	handler := NewCacheHandler(controller)

	resp, err := handler.RemoveCache(context.Background(), connect.NewRequest(&agentcomposev2.RemoveCacheRequest{CacheId: active.CacheID, Force: true}))
	if err != nil {
		t.Fatalf("RemoveCache: %v", err)
	}
	if controller.removeReq.CacheID != active.CacheID || !controller.removeReq.Force {
		t.Fatalf("remove request = %#v", controller.removeReq)
	}
	if len(resp.Msg.GetSkipped()) != 1 || resp.Msg.GetSkipped()[0].GetStatus() != agentcomposev2.CacheStatus_CACHE_STATUS_ACTIVE {
		t.Fatalf("RemoveCache response = %#v", resp.Msg)
	}
}

func TestCacheHandlerValidationErrors(t *testing.T) {
	handler := NewCacheHandler(&fakeCacheController{})
	for _, tc := range []struct {
		name string
		call func() error
		code connect.Code
	}{
		{
			name: "unknown domain",
			call: func() error {
				_, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{Domain: agentcomposev2.CacheDomain(99)}}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "unknown status",
			call: func() error {
				_, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{Status: agentcomposev2.CacheStatus(99)}}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "unknown driver",
			call: func() error {
				_, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{Driver: "bogus"}}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "unknown type",
			call: func() error {
				_, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{Type: "bogus"}}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "older than overflow",
			call: func() error {
				_, err := handler.ListCaches(context.Background(), connect.NewRequest(&agentcomposev2.ListCachesRequest{Filter: &agentcomposev2.CacheFilter{OlderThanSeconds: ^uint64(0)}}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "missing inspect id",
			call: func() error {
				_, err := handler.InspectCache(context.Background(), connect.NewRequest(&agentcomposev2.InspectCacheRequest{}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "invalid remove id",
			call: func() error {
				_, err := handler.RemoveCache(context.Background(), connect.NewRequest(&agentcomposev2.RemoveCacheRequest{CacheId: "not-valid"}))
				return err
			},
			code: connect.CodeInvalidArgument,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); connect.CodeOf(err) != tc.code {
				t.Fatalf("code = %v, want %v (err=%v)", connect.CodeOf(err), tc.code, err)
			}
		})
	}
}

func TestConnectErrorForRuntimeCache(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code connect.Code
	}{
		{cache.ErrCacheNotFound, connect.CodeNotFound},
		{cache.ErrInvalidFilter, connect.CodeInvalidArgument},
		{cache.ErrInvalidCacheID, connect.CodeInvalidArgument},
		{cache.ErrUnsafePath, connect.CodeFailedPrecondition},
		{cache.ErrRemoveUnavailable, connect.CodeUnavailable},
		{errors.New("boom"), connect.CodeInternal},
	} {
		if got := connect.CodeOf(ConnectErrorForRuntimeCache(tc.err)); got != tc.code {
			t.Fatalf("ConnectErrorForRuntimeCache(%v) = %v, want %v", tc.err, got, tc.code)
		}
	}
}

type fakeCacheController struct {
	listReq       cache.ListRequest
	listResult    cache.ListResult
	listErr       error
	inspectID     string
	inspectResult cache.ListResult
	inspectErr    error
	pruneReq      cache.PruneRequest
	pruneResult   cache.Result
	pruneErr      error
	removeReq     cache.RemoveRequest
	removeResult  cache.Result
	removeErr     error
}

func (f *fakeCacheController) ListCaches(_ context.Context, req cache.ListRequest) (cache.ListResult, error) {
	f.listReq = req
	return f.listResult, f.listErr
}

func (f *fakeCacheController) InspectCache(_ context.Context, cacheID string) (cache.ListResult, error) {
	f.inspectID = cacheID
	return f.inspectResult, f.inspectErr
}

func (f *fakeCacheController) PruneCaches(_ context.Context, req cache.PruneRequest) (cache.Result, error) {
	f.pruneReq = req
	return f.pruneResult, f.pruneErr
}

func (f *fakeCacheController) RemoveCache(_ context.Context, req cache.RemoveRequest) (cache.Result, error) {
	f.removeReq = req
	return f.removeResult, f.removeErr
}

func testRuntimeCacheItem(t *testing.T, status cache.Status) cache.Item {
	t.Helper()
	item := cache.EvaluateProtection(cache.Item{
		Domain:         cache.DomainSkillArtifactCache,
		Driver:         cache.DriverMicrosandbox,
		Kind:           "skill-artifact",
		Path:           "/tmp/microsandbox/docker-disks/sandbox.raw",
		SizeBytes:      12,
		Status:         status,
		LastUsedAt:     time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC),
		LastUsedSource: "mtime",
		References: []cache.Reference{{
			Policy:      cache.ReferencePolicyAdvisory,
			Type:        "sandbox",
			ID:          "sandbox",
			Name:        "Sandbox",
			Path:        "/tmp/sandbox.json",
			Status:      string(status),
			Description: "test reference",
		}},
		Warnings: []string{"item warning"},
	})
	cacheID, err := cache.GenerateCacheID(item)
	if err != nil {
		t.Fatalf("GenerateCacheID: %v", err)
	}
	item.CacheID = cacheID
	return item
}

func testRuntimeCacheID(t *testing.T, status cache.Status) string {
	t.Helper()
	return testRuntimeCacheItem(t, status).CacheID
}
