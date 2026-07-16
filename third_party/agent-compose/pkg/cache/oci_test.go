package cache

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"agent-compose/pkg/imagecache"
	"github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

func TestOCISourceRemovalPreservesSharedLayersAndRequiredMetadata(t *testing.T) {
	imageCache, err := imagecache.New(imagecache.Config{Root: filepath.Join(t.TempDir(), "images")})
	if err != nil {
		t.Fatal(err)
	}
	shared := randomOCILayer(t)
	imageA := ociTestImage(t, shared, randomOCILayer(t))
	imageB := ociTestImage(t, shared, randomOCILayer(t))
	ociPath, err := layout.Write(imageCache.OCILayoutPath(), empty.Index)
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range []v1.Image{imageA, imageB} {
		if err := ociPath.AppendImage(image, layout.WithPlatform(v1.Platform{OS: "linux", Architecture: "amd64"})); err != nil {
			t.Fatal(err)
		}
	}

	digestA, _ := imageA.Digest()
	digestB, _ := imageB.Digest()
	configB, _ := imageB.ConfigName()
	sharedDigest, _ := shared.Digest()
	metadataB := imagecache.ImageMetadata{
		RequestedRef: "example/b:latest", NormalizedRef: "registry.example/b:latest",
		ManifestDigest: digestB.String(), ConfigDigest: configB.String(), PulledAt: time.Now().UTC(),
	}
	if err := imageCache.SaveMetadata(imagecache.MetadataFile{Images: []imagecache.ImageMetadata{metadataB}}); err != nil {
		t.Fatal(err)
	}

	source := OCISource{Cache: imageCache}
	listed, err := source.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	itemA := requireOCIManifest(t, listed.Items, digestA.String())
	itemB := requireOCIManifest(t, listed.Items, digestB.String())
	if itemA.Status != StatusUnused || !itemA.Removable {
		t.Fatalf("unreferenced manifest = %#v", itemA)
	}
	if itemB.Status != StatusReferenced || itemB.Removable || !HasRequiredReferences(itemB.References) {
		t.Fatalf("metadata-referenced manifest = %#v", itemB)
	}
	if err := source.Remove(context.Background(), itemB); err == nil {
		t.Fatal("Remove deleted a manifest with REQUIRED metadata reference")
	}
	if err := source.Remove(context.Background(), itemA); err != nil {
		t.Fatalf("Remove unreferenced manifest: %v", err)
	}
	if _, err := os.Stat(ociBlobPath(imageCache.OCILayoutPath(), sharedDigest)); err != nil {
		t.Fatalf("shared layer was removed: %v", err)
	}
	index, err := layout.Path(imageCache.OCILayoutPath()).ImageIndex()
	if err != nil {
		t.Fatal(err)
	}
	remaining, err := index.Image(digestB)
	if err != nil {
		t.Fatalf("remaining manifest is unreadable: %v", err)
	}
	if layers, err := remaining.Layers(); err != nil || len(layers) != 2 {
		t.Fatalf("remaining layers = %d, err=%v", len(layers), err)
	}

	if err := imageCache.SaveMetadata(imagecache.MetadataFile{}); err != nil {
		t.Fatal(err)
	}
	listed, err = source.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	itemB = requireOCIManifest(t, listed.Items, digestB.String())
	if itemB.Status != StatusUnused || !itemB.Removable {
		t.Fatalf("manifest after metadata removal = %#v", itemB)
	}
	if err := source.Remove(context.Background(), itemB); err != nil {
		t.Fatalf("Remove final unreferenced manifest: %v", err)
	}
}

func randomOCILayer(t *testing.T) v1.Layer {
	t.Helper()
	layer, err := random.Layer(1024, types.OCILayer)
	if err != nil {
		t.Fatal(err)
	}
	return layer
}

func ociTestImage(t *testing.T, layers ...v1.Layer) v1.Image {
	t.Helper()
	image, err := mutate.AppendLayers(empty.Image, layers...)
	if err != nil {
		t.Fatal(err)
	}
	config, err := image.ConfigFile()
	if err != nil {
		t.Fatal(err)
	}
	config.OS, config.Architecture = "linux", "amd64"
	image, err = mutate.ConfigFile(image, config)
	if err != nil {
		t.Fatal(err)
	}
	return mutate.ConfigMediaType(mutate.MediaType(image, types.OCIManifestSchema1), types.OCIConfigJSON)
}

func requireOCIManifest(t *testing.T, items []Item, digest string) Item {
	t.Helper()
	for _, item := range items {
		if item.Kind == KindOCIManifest && item.ImageID == digest {
			return item
		}
	}
	t.Fatalf("OCI manifest %s not found in %#v", digest, items)
	return Item{}
}
