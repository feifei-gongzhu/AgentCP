package resources

import (
	"context"
	"strings"
	"testing"

	"agent-compose/pkg/cache"
	domain "agent-compose/pkg/model"
)

type storedIDSourceStub struct {
	targets []Target
	options ResolveOptions
}

func (s *storedIDSourceStub) FindResourceIDs(_ context.Context, options ResolveOptions) ([]Target, error) {
	s.options = options
	return append([]Target(nil), s.targets...), nil
}

type sandboxIDSourceStub struct {
	listed domain.SandboxListResult
}

func (s sandboxIDSourceStub) GetSandbox(context.Context, string) (*domain.Sandbox, error) {
	return nil, nil
}

func (s sandboxIDSourceStub) ListSandboxes(context.Context, domain.SandboxListOptions) (domain.SandboxListResult, error) {
	return s.listed, nil
}

type cacheIDSourceStub struct {
	result cache.ListResult
}

func (s cacheIDSourceStub) ListCaches(context.Context, cache.ListRequest) (cache.ListResult, error) {
	return s.result, nil
}

func TestLocatorResolvesOnlyIDCandidates(t *testing.T) {
	prefix := "123456789abc"
	projectID := prefix + strings.Repeat("1", 52)
	runID := prefix + strings.Repeat("2", 52)
	stored := &storedIDSourceStub{targets: []Target{
		{Kind: KindProject, ID: projectID, ProjectID: projectID},
		{Kind: KindRun, ID: runID, ProjectID: "project-id"},
	}}
	locator := NewLocator(stored, nil, nil, nil)

	targets, _, err := locator.ResolveID(context.Background(), ResolveOptions{ID: prefix, Kinds: []Kind{KindProject, KindRun}})
	if err != nil {
		t.Fatalf("ResolveID returned error: %v", err)
	}
	if len(targets) != 2 {
		t.Fatalf("targets = %#v, want two ambiguous prefix matches", targets)
	}
	if len(stored.options.Kinds) != 2 || stored.options.ID != prefix {
		t.Fatalf("stored options = %#v", stored.options)
	}

	targets, _, err = locator.ResolveID(context.Background(), ResolveOptions{ID: projectID})
	if err != nil {
		t.Fatalf("ResolveID exact returned error: %v", err)
	}
	if len(targets) != 1 || targets[0].ID != projectID {
		t.Fatalf("exact targets = %#v", targets)
	}
}

func TestLocatorRejectsNames(t *testing.T) {
	locator := NewLocator(&storedIDSourceStub{}, nil, nil, nil)
	if _, _, err := locator.ResolveID(context.Background(), ResolveOptions{ID: "project-name"}); err == nil {
		t.Fatal("ResolveID returned nil error for a name")
	}
}

func TestLocatorCombinesRuntimeIDCandidates(t *testing.T) {
	prefix := "abcdef123456"
	sandboxID := prefix + strings.Repeat("a", 52)
	cacheID := prefix + strings.Repeat("b", 52)
	locator := NewLocator(
		&storedIDSourceStub{},
		sandboxIDSourceStub{listed: domain.SandboxListResult{Sandboxes: []*domain.Sandbox{{Summary: domain.SandboxSummary{ID: sandboxID}}}}},
		nil,
		cacheIDSourceStub{result: cache.ListResult{Items: []cache.Item{{CacheID: cacheID}}}},
	)
	targets, warnings, err := locator.ResolveID(context.Background(), ResolveOptions{ID: prefix, Kinds: []Kind{KindSandbox, KindCache}})
	if err != nil {
		t.Fatalf("ResolveID returned error: %v", err)
	}
	if len(targets) != 2 || len(warnings) != 0 {
		t.Fatalf("targets/warnings = %#v / %#v", targets, warnings)
	}
}
