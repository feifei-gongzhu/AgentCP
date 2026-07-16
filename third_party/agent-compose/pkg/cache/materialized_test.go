package cache

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-compose/pkg/imagecache"
)

func TestMaterializedScannerListsReferencedItemsAndMetadataWarnings(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	image := imagecache.ImageMetadata{
		CacheKey:        "sha256:config-app",
		RequestedRef:    "app",
		NormalizedRef:   "registry.example/app:latest",
		RepoTags:        []string{"registry.example/app:latest"},
		RepoDigests:     []string{"registry.example/app@sha256:manifest-app"},
		ManifestDigest:  "sha256:manifest-app",
		ConfigDigest:    "sha256:config-app",
		LayoutCachePath: cache.MaterializedOCILayoutPath("sha256:config-app"),
		RootFSCachePath: cache.MaterializedRootFSPath("sha256:config-app"),
		PulledAt:        time.Date(2026, 7, 1, 1, 2, 3, 0, time.UTC),
	}
	if err := cache.SaveMetadata(imagecache.MetadataFile{Images: []imagecache.ImageMetadata{image}}); err != nil {
		t.Fatalf("SaveMetadata returned error: %v", err)
	}
	layoutPath := cache.MaterializedOCILayoutPath(image.ConfigDigest)
	if err := os.MkdirAll(layoutPath, 0o755); err != nil {
		t.Fatalf("mkdir layout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(layoutPath, "index.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write layout file: %v", err)
	}
	readyPath := filepath.Join(cache.MaterializedImageDir(image.ConfigDigest), ".ready")
	if err := os.WriteFile(readyPath, []byte("ready"), 0o644); err != nil {
		t.Fatalf("write ready: %v", err)
	}

	result, err := (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	layout := requireItem(t, result.Items, layoutPath)
	if layout.Kind != KindMaterializedOCILayout || layout.Status != StatusReferenced || len(layout.References) != 1 {
		t.Fatalf("layout item = %#v", layout)
	}
	if layout.ImageID != image.ConfigDigest || layout.ImageRef != image.RequestedRef || layout.ResolvedRef != image.RepoDigests[0] {
		t.Fatalf("layout image fields = %#v", layout)
	}
	for _, item := range result.Items {
		if item.Path == readyPath {
			t.Fatalf("ready flag was listed separately from layout: %#v", item)
		}
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], image.RootFSCachePath) {
		t.Fatalf("Warnings = %#v, want missing rootfs metadata path", result.Warnings)
	}
}

func TestMaterializedScannerListsRootFSTempAndOrphanedDirs(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	image := imagecache.ImageMetadata{
		CacheKey:       "sha256:config-root",
		RequestedRef:   "rootfs",
		NormalizedRef:  "registry.example/rootfs:latest",
		ManifestDigest: "sha256:manifest-root",
		ConfigDigest:   "sha256:config-root",
	}
	if err := cache.SaveMetadata(imagecache.MetadataFile{Images: []imagecache.ImageMetadata{image}}); err != nil {
		t.Fatalf("SaveMetadata returned error: %v", err)
	}
	rootfsPath := cache.MaterializedRootFSPath(image.ConfigDigest)
	if err := os.MkdirAll(filepath.Join(rootfsPath, "bin"), 0o755); err != nil {
		t.Fatalf("mkdir rootfs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootfsPath, "bin", "tool"), []byte("tool"), 0o644); err != nil {
		t.Fatalf("write rootfs file: %v", err)
	}
	rootfsReadyPath := filepath.Join(cache.MaterializedImageDir(image.ConfigDigest), ".rootfs.ready")
	if err := os.WriteFile(rootfsReadyPath, []byte("ready"), 0o644); err != nil {
		t.Fatalf("write rootfs ready: %v", err)
	}
	tmpPath := filepath.Join(cache.MaterializedImageDir(image.ConfigDigest), "rootfs.tmp")
	if err := os.MkdirAll(filepath.Join(tmpPath, "rootfs"), 0o755); err != nil {
		t.Fatalf("mkdir tmp: %v", err)
	}
	orphanDir := filepath.Join(cache.MaterializationRoot(), "orphaned-image", "oci")
	if err := os.MkdirAll(orphanDir, 0o755); err != nil {
		t.Fatalf("mkdir orphan: %v", err)
	}

	result, err := (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	rootfs := requireItem(t, result.Items, rootfsPath)
	if rootfs.Kind != KindMaterializedRootFS || rootfs.Status != StatusReferenced || rootfs.SizeBytes != 9 {
		t.Fatalf("rootfs item = %#v", rootfs)
	}
	for _, item := range result.Items {
		if item.Path == rootfsReadyPath {
			t.Fatalf("rootfs ready flag was listed separately: %#v", item)
		}
	}
	tmp := requireItem(t, result.Items, tmpPath)
	if tmp.Kind != KindMaterializedTempDir || tmp.Status != StatusOrphaned || !tmp.Removable {
		t.Fatalf("tmp item = %#v", tmp)
	}
	orphan := requireItem(t, result.Items, orphanDir)
	if orphan.Kind != KindMaterializedOCILayout || orphan.Status != StatusOrphaned || !orphan.Removable {
		t.Fatalf("orphan item = %#v", orphan)
	}
}

func TestMaterializedScannerHandlesMissingAndCorruptMetadata(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	orphanRootFS := filepath.Join(cache.MaterializationRoot(), "orphaned", "rootfs")
	if err := os.MkdirAll(orphanRootFS, 0o755); err != nil {
		t.Fatalf("mkdir orphan rootfs: %v", err)
	}

	result, err := (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List without metadata returned error: %v", err)
	}
	if len(result.Warnings) != 0 {
		t.Fatalf("missing metadata warnings = %#v, want none", result.Warnings)
	}
	orphan := requireItem(t, result.Items, orphanRootFS)
	if orphan.Status != StatusOrphaned {
		t.Fatalf("orphan status = %q", orphan.Status)
	}

	if err := os.WriteFile(cache.MetadataPath(), []byte("{broken"), 0o644); err != nil {
		t.Fatalf("write corrupt metadata: %v", err)
	}
	result, err = (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List with corrupt metadata returned error: %v", err)
	}
	if len(result.Warnings) == 0 || !strings.Contains(result.Warnings[0], "load image metadata") {
		t.Fatalf("corrupt metadata warnings = %#v", result.Warnings)
	}
}

func TestMaterializedScannerEmptyRoot(t *testing.T) {
	cache := newRuntimeCacheImageCache(t)
	result, err := (MaterializedScanner{Cache: cache}).List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(result.Items) != 0 || len(result.Warnings) != 0 {
		t.Fatalf("empty result = %#v", result)
	}
}

func TestMaterializedWarningItemBuildsUnknownProtectedItem(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "oci")
	item := warningItem(path, KindMaterializedOCILayout, "stat failed")

	if item.Domain != DomainMaterializedImageCache || item.Driver != DriverAll || item.Kind != KindMaterializedOCILayout {
		t.Fatalf("warning item identity = %#v", item)
	}
	if item.Path != path || item.CacheID == "" {
		t.Fatalf("warning item path/id = %#v", item)
	}
	if item.Status != StatusUnknown || item.Removable {
		t.Fatalf("warning item protection = %#v", item)
	}
	if len(item.Warnings) != 1 || item.Warnings[0] != "stat failed" {
		t.Fatalf("warning item warnings = %#v", item.Warnings)
	}
	if len(item.BlockedReasons) != 1 || !strings.Contains(item.BlockedReasons[0], "unknown") {
		t.Fatalf("warning item blocked reasons = %#v", item.BlockedReasons)
	}
}

func newRuntimeCacheImageCache(t *testing.T) *imagecache.Cache {
	t.Helper()
	cache, err := imagecache.New(imagecache.Config{Root: filepath.Join(t.TempDir(), "images")})
	if err != nil {
		t.Fatalf("imagecache.New returned error: %v", err)
	}
	return cache
}

func requireItem(t *testing.T, items []Item, path string) Item {
	t.Helper()
	for _, item := range items {
		if item.Path == path {
			if item.CacheID == "" {
				t.Fatalf("item for %s has empty cache id: %#v", path, item)
			}
			if item.LastUsedSource != LastUsedSourceMTime {
				t.Fatalf("item for %s LastUsedSource = %q", path, item.LastUsedSource)
			}
			return item
		}
	}
	t.Fatalf("missing item for path %s in %#v", path, items)
	return Item{}
}
