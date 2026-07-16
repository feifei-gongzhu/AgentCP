package cache

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestEvaluateProtection(t *testing.T) {
	tests := []struct {
		name          string
		item          Item
		wantStatus    Status
		wantRemovable bool
		wantBlocked   bool
	}{
		{name: "active", item: Item{Status: StatusActive}, wantStatus: StatusActive, wantBlocked: true},
		{name: "unknown", item: Item{Status: StatusUnknown}, wantStatus: StatusUnknown, wantBlocked: true},
		{name: "empty status is unknown", item: Item{}, wantStatus: StatusUnknown, wantBlocked: true},
		{name: "referenced blocked by default", item: Item{Status: StatusReferenced}, wantStatus: StatusReferenced, wantBlocked: true},
		{name: "advisory reference is removable", item: Item{Status: StatusReferenced, References: []Reference{{Policy: ReferencePolicyAdvisory}}}, wantStatus: StatusReferenced, wantRemovable: true},
		{name: "unused", item: Item{Status: StatusUnused}, wantStatus: StatusUnused, wantRemovable: true},
		{name: "orphaned", item: Item{Status: StatusOrphaned}, wantStatus: StatusOrphaned, wantRemovable: true},
		{name: "expired", item: Item{Status: StatusExpired}, wantStatus: StatusExpired, wantRemovable: true},
		{name: "expired required reference blocked", item: Item{Status: StatusExpired, References: []Reference{{Type: "sandbox", ID: "s1"}}}, wantStatus: StatusReferenced, wantBlocked: true},
		{name: "expired advisory reference removable", item: Item{Status: StatusExpired, References: []Reference{{Policy: ReferencePolicyAdvisory, Type: "image"}}}, wantStatus: StatusExpired, wantRemovable: true},
		{name: "future status fails closed", item: Item{Status: Status("future")}, wantStatus: StatusUnknown, wantBlocked: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EvaluateProtection(tt.item)
			if got.Status != tt.wantStatus || got.Removable != tt.wantRemovable {
				t.Fatalf("EvaluateProtection = status %q removable %v, want %q %v", got.Status, got.Removable, tt.wantStatus, tt.wantRemovable)
			}
			if blocked := len(got.BlockedReasons) > 0; blocked != tt.wantBlocked {
				t.Fatalf("BlockedReasons = %#v, blocked %v want %v", got.BlockedReasons, blocked, tt.wantBlocked)
			}
		})
	}
}

func TestPruneItemsDryRunDoesNotRemove(t *testing.T) {
	items := []Item{
		mustCacheItem(t, "unused", StatusUnused),
		mustCacheItem(t, "active", StatusActive),
		mustCacheItem(t, "referenced", StatusReferenced),
	}
	calls := 0
	result, err := PruneItems(context.Background(), items, PruneRequest{}, time.Now(), func(context.Context, Item) error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if !result.DryRun || calls != 0 {
		t.Fatalf("dry-run = %v calls = %d, want dry-run without remover calls", result.DryRun, calls)
	}
	if got := cacheIDs(result.Matched); !reflect.DeepEqual(got, cacheIDs(items)) {
		t.Fatalf("Matched ids = %#v, want %#v", got, cacheIDs(items))
	}
	if got := cacheIDs(result.Skipped); !reflect.DeepEqual(got, []string{items[1].CacheID, items[2].CacheID}) {
		t.Fatalf("Skipped ids = %#v", got)
	}
	if len(result.Removed) != 0 {
		t.Fatalf("Removed = %#v, want none", result.Removed)
	}
}

func TestPruneItemsForceKeepsRequiredReferences(t *testing.T) {
	items := []Item{
		mustCacheItem(t, "unused", StatusUnused),
		mustCacheItem(t, "advisory", StatusReferenced, Reference{Policy: ReferencePolicyAdvisory, Type: "image", ID: "i1"}),
		mustCacheItem(t, "expired-required", StatusExpired, Reference{Type: "project", ID: "p1"}),
		mustCacheItem(t, "unknown", StatusUnknown),
		mustCacheItem(t, "active", StatusActive),
	}
	var removed []string
	result, err := PruneItems(context.Background(), items, PruneRequest{Force: true}, time.Now(), func(_ context.Context, item Item) error {
		removed = append(removed, item.CacheID)
		return nil
	})
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	wantRemoved := []string{items[0].CacheID, items[1].CacheID}
	if !reflect.DeepEqual(result.Removed, wantRemoved) || !reflect.DeepEqual(removed, wantRemoved) {
		t.Fatalf("Removed = %#v calls %#v, want %#v", result.Removed, removed, wantRemoved)
	}
	if got := cacheIDs(result.Skipped); !reflect.DeepEqual(got, []string{items[2].CacheID, items[3].CacheID, items[4].CacheID}) {
		t.Fatalf("Skipped ids = %#v", got)
	}
}

func TestPruneItemsRequiredReferenceCannotBeForced(t *testing.T) {
	item := mustCacheItem(t, "referenced", StatusReferenced)
	result, err := PruneItems(context.Background(), []Item{item}, PruneRequest{Force: true}, time.Now(), func(context.Context, Item) error {
		t.Fatal("remover should not be called")
		return nil
	})
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if len(result.Removed) != 0 || len(result.Skipped) != 1 {
		t.Fatalf("result = %#v, want referenced skipped", result)
	}
}

func TestPruneItemsContinuesAfterRemoveError(t *testing.T) {
	first := mustCacheItem(t, "first", StatusUnused)
	second := mustCacheItem(t, "second", StatusUnused)
	result, err := PruneItems(context.Background(), []Item{first, second}, PruneRequest{Force: true}, time.Now(), func(_ context.Context, item Item) error {
		if item.CacheID == first.CacheID {
			return errors.New("disk busy")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{second.CacheID}) {
		t.Fatalf("Removed = %#v, want second", result.Removed)
	}
	if got := cacheIDs(result.Skipped); !reflect.DeepEqual(got, []string{first.CacheID}) {
		t.Fatalf("Skipped = %#v, want first", got)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "disk busy") {
		t.Fatalf("Warnings = %#v, want remove warning", result.Warnings)
	}
}

func TestRemoveItem(t *testing.T) {
	item := mustCacheItem(t, "unused", StatusUnused)
	calls := 0
	result, err := RemoveItem(context.Background(), []Item{item}, RemoveRequest{CacheID: item.CacheID}, time.Now(), func(context.Context, Item) error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("RemoveItem dry-run returned error: %v", err)
	}
	if !result.DryRun || calls != 0 || len(result.Removed) != 0 {
		t.Fatalf("dry-run result = %#v calls=%d", result, calls)
	}

	result, err = RemoveItem(context.Background(), []Item{item}, RemoveRequest{CacheID: item.CacheID, Force: true}, time.Now(), func(context.Context, Item) error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("RemoveItem force returned error: %v", err)
	}
	if calls != 1 || !reflect.DeepEqual(result.Removed, []string{item.CacheID}) {
		t.Fatalf("force result = %#v calls=%d", result, calls)
	}
}

func TestRemoveItemInvalidNotFoundAndProtected(t *testing.T) {
	if _, err := RemoveItem(context.Background(), nil, RemoveRequest{CacheID: "../bad"}, time.Now(), nil); !errors.Is(err, ErrInvalidCacheID) {
		t.Fatalf("invalid id error = %v, want ErrInvalidCacheID", err)
	}

	item := mustCacheItem(t, "unused", StatusUnused)
	missing := mustCacheItem(t, "missing", StatusUnused)
	if _, err := RemoveItem(context.Background(), []Item{item}, RemoveRequest{CacheID: missing.CacheID}, time.Now(), nil); !errors.Is(err, ErrCacheNotFound) {
		t.Fatalf("missing error = %v, want ErrCacheNotFound", err)
	}

	active := mustCacheItem(t, "active", StatusActive)
	result, err := RemoveItem(context.Background(), []Item{active}, RemoveRequest{CacheID: active.CacheID, Force: true}, time.Now(), func(context.Context, Item) error {
		t.Fatal("remover should not be called for active item")
		return nil
	})
	if err != nil {
		t.Fatalf("active RemoveItem returned error: %v", err)
	}
	if len(result.Removed) != 0 || len(result.Skipped) != 1 {
		t.Fatalf("active result = %#v, want skipped", result)
	}
}

func mustCacheItem(t *testing.T, name string, status Status, refs ...Reference) Item {
	t.Helper()
	item := Item{
		Domain:     DomainRuntimeDerivedCache,
		Driver:     DriverBoxLite,
		Kind:       "boxlite-disk-image",
		Path:       "/tmp/runtime-cache-test/" + name,
		Status:     status,
		References: refs,
	}
	cacheID, err := GenerateCacheID(item)
	if err != nil {
		t.Fatalf("GenerateCacheID(%s) returned error: %v", name, err)
	}
	item.CacheID = cacheID
	return item
}
