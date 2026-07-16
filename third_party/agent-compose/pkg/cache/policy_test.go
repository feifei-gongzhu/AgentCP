package cache

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"agent-compose/pkg/imagecache"
)

func TestControllerTTLAndReferencePriority(t *testing.T) {
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	source := policySource{items: []Item{
		mustPolicyItem(t, "expired", StatusUnused, now.Add(-8*24*time.Hour)),
		mustPolicyItem(t, "unused", StatusUnused, now.Add(-time.Hour)),
		mustPolicyItem(t, "required", StatusUnused, now.Add(-8*24*time.Hour), Reference{Type: "sandbox", ID: "sandbox-1"}),
		mustPolicyItem(t, "advisory", StatusReferenced, now.Add(-8*24*time.Hour), Reference{Policy: ReferencePolicyAdvisory, Type: "image", ID: "image-1"}),
	}}
	controller := &Controller{Sources: []Source{source}, TTL: 7 * 24 * time.Hour, Now: func() time.Time { return now }}
	result, err := controller.ListCaches(context.Background(), ListRequest{})
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]Status{}
	removable := map[string]bool{}
	for _, item := range result.Items {
		statuses[filepath.Base(item.Path)] = item.Status
		removable[filepath.Base(item.Path)] = item.Removable
	}
	if statuses["expired"] != StatusExpired || statuses["unused"] != StatusUnused || statuses["required"] != StatusReferenced || statuses["advisory"] != StatusExpired {
		t.Fatalf("statuses = %#v", statuses)
	}
	if removable["required"] || !removable["advisory"] {
		t.Fatalf("removable = %#v", removable)
	}

	controller.TTL = 0
	result, err = controller.ListCaches(context.Background(), ListRequest{})
	if err != nil || result.Items[0].Status != StatusUnused {
		t.Fatalf("TTL disabled result=%#v err=%v", result, err)
	}
}

func TestSkillSourceManifestAndSafeRemoval(t *testing.T) {
	root := t.TempDir()
	artifact := filepath.Join(root, "artifact")
	if err := os.MkdirAll(artifact, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(-8 * 24 * time.Hour).UTC()
	manifest, _ := json.Marshal(SkillArtifactManifest{Version: 1, Source: "git", Identity: "commit", CreatedAt: now, LastUsedAt: now})
	if err := os.WriteFile(filepath.Join(artifact, skillManifestName), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artifact, skillReadyName), []byte("ready"), 0o644); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(root, ".tmp-stale")
	if err := os.Mkdir(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	source := SkillSource{Root: root}
	listed, err := source.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var completed Item
	for _, item := range listed.Items {
		if item.Path == artifact {
			completed = item
		}
	}
	if completed.Kind != KindSkillArtifact || completed.Status != StatusUnused || len(completed.References) != 1 || completed.References[0].Policy != ReferencePolicyAdvisory || !completed.Removable {
		t.Fatalf("completed artifact = %#v", completed)
	}
	if err := source.Remove(context.Background(), completed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("artifact remains: %v", err)
	}
}

func TestSkillSourceRemovalWaitsForActiveRootReader(t *testing.T) {
	root := t.TempDir()
	artifact := filepath.Join(root, "artifact")
	if err := os.MkdirAll(artifact, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	manifest, _ := json.Marshal(SkillArtifactManifest{Version: 1, Source: "file", Identity: "content", CreatedAt: now, LastUsedAt: now})
	for path, data := range map[string][]byte{
		filepath.Join(artifact, skillManifestName): manifest,
		filepath.Join(artifact, skillReadyName):    []byte("ready"),
	} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	source := SkillSource{Root: root}
	listed, err := source.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var item Item
	for _, candidate := range listed.Items {
		if candidate.Path == artifact {
			item = candidate
			break
		}
	}
	if item.CacheID == "" {
		t.Fatalf("artifact not found in %#v", listed.Items)
	}

	releaseReader, err := lockSkillRoot(root, syscall.LOCK_SH)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		done <- source.Remove(context.Background(), item)
	}()
	<-started
	select {
	case err := <-done:
		releaseReader()
		t.Fatalf("Remove returned while shared resolver lock was active: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	releaseReader()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Remove after resolver unlock: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Remove did not continue after resolver unlock")
	}
}

func TestMaterializedDependencyIsRequired(t *testing.T) {
	imageCache, err := imagecache.New(imagecache.Config{Root: filepath.Join(t.TempDir(), "images")})
	if err != nil {
		t.Fatal(err)
	}
	image := imagecache.ImageMetadata{RequestedRef: "guest:latest", NormalizedRef: "registry/guest:latest", ConfigDigest: "sha256:config", ManifestDigest: "sha256:manifest"}
	if err := imageCache.SaveMetadata(imagecache.MetadataFile{Images: []imagecache.ImageMetadata{image}}); err != nil {
		t.Fatal(err)
	}
	rootfs := imageCache.MaterializedRootFSPath(image.ConfigDigest)
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(rootfs), materializedRootFSReadyName), []byte("ready"), 0o644); err != nil {
		t.Fatal(err)
	}
	scanner := MaterializedScanner{Cache: imageCache, Dependencies: policyDependencies{{SandboxID: "sandbox-1", Identity: "guest:latest", Status: "stopped"}}}
	result, err := scanner.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	item := requireItem(t, result.Items, rootfs)
	item = EvaluateProtection(item)
	if item.Status != StatusReferenced || item.Removable || !HasRequiredReferences(item.References) {
		t.Fatalf("materialized item = %#v", item)
	}
}

type policySource struct{ items []Item }

func (s policySource) List(context.Context) (ListResult, error) {
	return ListResult{Items: s.items}, nil
}
func (policySource) Remove(context.Context, Item) error { return nil }

func mustPolicyItem(t *testing.T, name string, status Status, lastUsed time.Time, refs ...Reference) Item {
	t.Helper()
	item := Item{Domain: DomainRuntimeDerivedCache, Driver: DriverAll, Kind: "test-cache", Path: filepath.Join("/tmp", name), Status: status, LastUsedAt: lastUsed, References: refs}
	id, err := GenerateCacheID(item)
	if err != nil {
		t.Fatal(err)
	}
	item.CacheID = id
	return item
}

type policyDependencies []MaterializedDependency

func (p policyDependencies) MaterializedDependencies(context.Context) ([]MaterializedDependency, []string, error) {
	return p, nil, nil
}
