package cache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agent-compose/pkg/imagecache"
)

func TestMaterializedPruneSkipsReferencedByDefault(t *testing.T) {
	cache, image := materializedRemovalFixture(t)
	layoutPath := cache.MaterializedOCILayoutPath(image.ConfigDigest)
	items := scanMaterializedItems(t, cache)
	layout := requireItem(t, items, layoutPath)
	layout.References[0].Policy = ReferencePolicyRequired

	result, err := PruneItems(context.Background(), []Item{layout}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if len(result.Removed) != 0 || len(result.Skipped) != 1 {
		t.Fatalf("result = %#v, want referenced skipped", result)
	}
	assertPathExists(t, layoutPath)
}

func TestMaterializedPruneAdvisoryReferenceDeletesLayoutAndReadyOnly(t *testing.T) {
	cache, image := materializedRemovalFixture(t)
	imageDir := cache.MaterializedImageDir(image.ConfigDigest)
	layoutPath := cache.MaterializedOCILayoutPath(image.ConfigDigest)
	rootfsPath := cache.MaterializedRootFSPath(image.ConfigDigest)
	layoutReady := filepath.Join(imageDir, ".ready")
	items := scanMaterializedItems(t, cache)
	layout := requireItem(t, items, layoutPath)

	result, err := PruneItems(context.Background(), []Item{layout}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{layout.CacheID}) {
		t.Fatalf("Removed = %#v, want layout id", result.Removed)
	}
	assertPathMissing(t, layoutPath)
	assertPathMissing(t, layoutReady)
	assertPathExists(t, rootfsPath)
}

func TestMaterializedSourceRechecksRequiredDependenciesBeforeRemoval(t *testing.T) {
	imageCache, image := materializedRemovalFixture(t)
	layoutPath := imageCache.MaterializedOCILayoutPath(image.ConfigDigest)
	dependencies := &changingMaterializedDependencies{dependency: MaterializedDependency{SandboxID: "sandbox-new", Identity: image.ConfigDigest, Status: "stopped"}}
	source := MaterializedSource{
		Scanner: MaterializedScanner{Cache: imageCache, Dependencies: dependencies},
		Remover: MaterializedRemover{Cache: imageCache},
	}
	controller := &Controller{Sources: []Source{source}}
	listed, err := controller.ListCaches(context.Background(), ListRequest{})
	if err != nil {
		t.Fatal(err)
	}
	item := requireItem(t, listed.Items, layoutPath)
	if !item.Removable || HasRequiredReferences(item.References) {
		t.Fatalf("initial item = %#v", item)
	}

	result, err := controller.RemoveCache(context.Background(), RemoveRequest{CacheID: item.CacheID, Force: true})
	if err != nil {
		t.Fatalf("RemoveCache returned controller error: %v", err)
	}
	if len(result.Removed) != 0 || len(result.Skipped) != 1 || len(result.Warnings) == 0 {
		t.Fatalf("RemoveCache result = %#v", result)
	}
	assertPathExists(t, layoutPath)
}

func TestMaterializedRemoveRootFSDeletesRootFSReady(t *testing.T) {
	cache, image := materializedRemovalFixture(t)
	imageDir := cache.MaterializedImageDir(image.ConfigDigest)
	rootfsPath := cache.MaterializedRootFSPath(image.ConfigDigest)
	rootfsReady := filepath.Join(imageDir, ".rootfs.ready")
	items := scanMaterializedItems(t, cache)
	rootfs := requireItem(t, items, rootfsPath)

	result, err := PruneItems(context.Background(), []Item{rootfs}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{rootfs.CacheID}) {
		t.Fatalf("Removed = %#v, want rootfs id", result.Removed)
	}
	assertPathMissing(t, rootfsPath)
	assertPathMissing(t, rootfsReady)
}

func TestMaterializedRemoveTempDirDoesNotDeleteSiblings(t *testing.T) {
	cache, image := materializedRemovalFixture(t)
	imageDir := cache.MaterializedImageDir(image.ConfigDigest)
	tmpPath := filepath.Join(imageDir, "rootfs.tmp")
	layoutPath := cache.MaterializedOCILayoutPath(image.ConfigDigest)
	rootfsPath := cache.MaterializedRootFSPath(image.ConfigDigest)
	items := scanMaterializedItems(t, cache)
	tmp := requireItem(t, items, tmpPath)

	result, err := PruneItems(context.Background(), []Item{tmp}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{tmp.CacheID}) {
		t.Fatalf("Removed = %#v, want temp id", result.Removed)
	}
	assertPathMissing(t, tmpPath)
	assertPathExists(t, layoutPath)
	assertPathExists(t, rootfsPath)
}

func TestMaterializedRemoveOrphanedAndExpiredItems(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	orphanPath := filepath.Join(cache.MaterializationRoot(), "orphaned-image", "oci")
	if err := os.MkdirAll(orphanPath, 0o755); err != nil {
		t.Fatalf("mkdir orphan: %v", err)
	}
	orphan := requireItem(t, scanMaterializedItems(t, cache), orphanPath)
	result, err := PruneItems(context.Background(), []Item{orphan}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems orphan returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{orphan.CacheID}) {
		t.Fatalf("orphan Removed = %#v, want orphan id", result.Removed)
	}
	assertPathMissing(t, orphanPath)

	expiredPath := filepath.Join(cache.MaterializationRoot(), "expired-image", "oci")
	if err := os.MkdirAll(expiredPath, 0o755); err != nil {
		t.Fatalf("mkdir expired: %v", err)
	}
	expired := requireItem(t, scanMaterializedItems(t, cache), expiredPath)
	expired.Status = StatusExpired
	result, err = PruneItems(context.Background(), []Item{expired}, PruneRequest{Force: true}, time.Now(), MaterializedRemover{Cache: cache}.Remove)
	if err != nil {
		t.Fatalf("PruneItems expired returned error: %v", err)
	}
	if !reflect.DeepEqual(result.Removed, []string{expired.CacheID}) {
		t.Fatalf("expired Removed = %#v, want expired id", result.Removed)
	}
	assertPathMissing(t, expiredPath)
}

func TestMaterializedRemoverRejectsMismatchedCacheID(t *testing.T) {
	cache, image := materializedRemovalFixture(t)
	item := requireItem(t, scanMaterializedItems(t, cache), cache.MaterializedOCILayoutPath(image.ConfigDigest))
	item.CacheID = "sha256:" + strings.Repeat("0", 64)
	if err := (MaterializedRemover{Cache: cache}).Remove(context.Background(), item); err == nil {
		t.Fatal("Remove returned nil error for mismatched cache id")
	}
}

func TestValidateMaterializedRemoveItemRejectsInvalidItems(t *testing.T) {
	valid := Item{
		Domain:  DomainMaterializedImageCache,
		Driver:  DriverAll,
		Kind:    KindMaterializedOCILayout,
		Path:    filepath.Join(t.TempDir(), "image", "oci"),
		CacheID: "sha256:" + strings.Repeat("0", 64),
	}

	tests := []struct {
		name        string
		item        Item
		wantInvalid bool
	}{
		{
			name: "wrong domain",
			item: Item{
				Domain:  DomainOCIImageStore,
				Driver:  DriverAll,
				Kind:    KindMaterializedOCILayout,
				Path:    valid.Path,
				CacheID: valid.CacheID,
			},
		},
		{
			name:        "empty cache id",
			item:        Item{Domain: DomainMaterializedImageCache},
			wantInvalid: true,
		},
		{
			name: "malformed cache id",
			item: Item{
				Domain:  DomainMaterializedImageCache,
				CacheID: "sha256:not-a-hash",
			},
			wantInvalid: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateMaterializedRemoveItem(tt.item)
			if err == nil {
				t.Fatal("validateMaterializedRemoveItem returned nil error")
			}
			if tt.wantInvalid && !errors.Is(err, ErrInvalidCacheID) {
				t.Fatalf("error = %v, want ErrInvalidCacheID", err)
			}
		})
	}

	if err := validateMaterializedRemoveItem(valid); err != nil {
		t.Fatalf("validateMaterializedRemoveItem(valid) returned error: %v", err)
	}
}

func TestMaterializedRemoverRejectsPreflightAndUnsafeItems(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	remover := MaterializedRemover{Cache: cache}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := remover.Remove(ctx, Item{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Remove canceled error = %v, want context.Canceled", err)
	}

	if err := (MaterializedRemover{}).Remove(context.Background(), Item{}); err == nil || !strings.Contains(err.Error(), "requires image cache") {
		t.Fatalf("Remove without cache error = %v, want image cache requirement", err)
	}

	outsidePath := filepath.Join(t.TempDir(), "outside-cache")
	if err := os.WriteFile(outsidePath, []byte("x"), 0o644); err != nil {
		t.Fatalf("write outside path: %v", err)
	}
	outside := Item{
		Domain: DomainMaterializedImageCache,
		Driver: DriverAll,
		Kind:   KindMaterializedTempDir,
		Path:   outsidePath,
	}
	var err error
	outside.CacheID, err = GenerateCacheID(outside)
	if err != nil {
		t.Fatalf("GenerateCacheID(outside) returned error: %v", err)
	}
	if err := remover.Remove(context.Background(), outside); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Remove outside path error = %v, want ErrUnsafePath", err)
	}

	unsupportedPath := filepath.Join(cache.MaterializationRoot(), "unsupported", "custom")
	if err := os.MkdirAll(unsupportedPath, 0o755); err != nil {
		t.Fatalf("mkdir unsupported path: %v", err)
	}
	unsupported := Item{
		Domain: DomainMaterializedImageCache,
		Driver: DriverAll,
		Kind:   "materialized-custom",
		Path:   unsupportedPath,
	}
	unsupported.CacheID, err = GenerateCacheID(unsupported)
	if err != nil {
		t.Fatalf("GenerateCacheID(unsupported) returned error: %v", err)
	}
	if err := remover.Remove(context.Background(), unsupported); err == nil || !strings.Contains(err.Error(), "unsupported materialized cache kind") {
		t.Fatalf("Remove unsupported kind error = %v", err)
	}
	assertPathExists(t, unsupportedPath)
}

func materializedRemovalFixture(t *testing.T) (*imagecache.Cache, imagecache.ImageMetadata) {
	t.Helper()
	cache := newRuntimeCacheImageCache(t)
	image := imagecache.ImageMetadata{
		CacheKey:       "sha256:config-remove",
		RequestedRef:   "remove",
		NormalizedRef:  "registry.example/remove:latest",
		ManifestDigest: "sha256:manifest-remove",
		ConfigDigest:   "sha256:config-remove",
	}
	if err := cache.SaveMetadata(imagecache.MetadataFile{Images: []imagecache.ImageMetadata{image}}); err != nil {
		t.Fatalf("SaveMetadata returned error: %v", err)
	}
	imageDir := cache.MaterializedImageDir(image.ConfigDigest)
	for _, dir := range []string{
		cache.MaterializedOCILayoutPath(image.ConfigDigest),
		cache.MaterializedRootFSPath(image.ConfigDigest),
		filepath.Join(imageDir, "rootfs.tmp", "rootfs"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	for _, path := range []string{
		filepath.Join(cache.MaterializedOCILayoutPath(image.ConfigDigest), "index.json"),
		filepath.Join(cache.MaterializedRootFSPath(image.ConfigDigest), "bin"),
		filepath.Join(imageDir, ".ready"),
		filepath.Join(imageDir, ".rootfs.ready"),
	} {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	return cache, image
}

type changingMaterializedDependencies struct {
	calls      int
	dependency MaterializedDependency
}

func (d *changingMaterializedDependencies) MaterializedDependencies(context.Context) ([]MaterializedDependency, []string, error) {
	d.calls++
	if d.calls < 3 {
		return nil, nil, nil
	}
	return []MaterializedDependency{d.dependency}, nil, nil
}

func scanMaterializedItems(t *testing.T, cache *imagecache.Cache) []Item {
	t.Helper()
	result, err := (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	return result.Items
}

func assertPathExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func assertPathMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be missing, stat err=%v", path, err)
	}
}
