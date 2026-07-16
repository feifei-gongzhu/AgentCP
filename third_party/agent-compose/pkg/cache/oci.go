package cache

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"agent-compose/pkg/imagecache"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/match"
)

const (
	KindOCIManifest   = "oci-manifest"
	KindOCIOrphanBlob = "oci-orphan-blob"
	KindOCITemp       = "oci-temp"
)

type OCISource struct {
	Cache *imagecache.Cache
}

func (s OCISource) List(ctx context.Context) (ListResult, error) {
	if s.Cache == nil {
		return ListResult{}, fmt.Errorf("OCI cache source requires image cache")
	}
	unlock, err := s.Cache.Lock()
	if err != nil {
		return ListResult{}, err
	}
	defer func() { _ = unlock() }()
	return s.listLocked(ctx)
}

func (s OCISource) listLocked(ctx context.Context) (ListResult, error) {
	metadata, metadataErr := s.Cache.LoadMetadata()
	if metadataErr != nil {
		return ListResult{Items: []Item{ociUnknownItem(s.Cache.OCILayoutPath(), metadataErr)}}, nil
	}
	path := layout.Path(s.Cache.OCILayoutPath())
	index, err := path.ImageIndex()
	if err != nil {
		return ListResult{Items: []Item{ociUnknownItem(s.Cache.OCILayoutPath(), err)}}, nil
	}
	manifest, err := index.IndexManifest()
	if err != nil {
		return ListResult{Items: []Item{ociUnknownItem(s.Cache.OCILayoutPath(), err)}}, nil
	}
	reachable := make(map[string]struct{})
	if err := collectOCIIndexReachability(index, reachable); err != nil {
		return ListResult{Items: []Item{ociUnknownItem(s.Cache.OCILayoutPath(), err)}}, nil
	}
	result := ListResult{}
	for _, descriptor := range manifest.Manifests {
		if err := ctx.Err(); err != nil {
			return ListResult{}, err
		}
		blobPath := ociBlobPath(s.Cache.OCILayoutPath(), descriptor.Digest)
		item := Item{Domain: DomainOCIImageStore, Driver: DriverAll, Kind: KindOCIManifest, Path: blobPath, ImageID: descriptor.Digest.String(), ResolvedRef: descriptor.Digest.String(), Status: StatusUnused, LastUsedSource: "oci-index"}
		if info, statErr := os.Stat(blobPath); statErr == nil {
			item.SizeBytes = uint64(info.Size())
			item.LastUsedAt = info.ModTime().UTC()
		} else {
			item.Status = StatusUnknown
			item.Warnings = append(item.Warnings, statErr.Error())
		}
		for _, image := range metadata.Images {
			if strings.TrimSpace(image.ManifestDigest) != descriptor.Digest.String() {
				continue
			}
			item.ImageRef = firstMaterializedNonEmpty(image.RequestedRef, image.NormalizedRef)
			item.References = append(item.References, Reference{Policy: ReferencePolicyRequired, Type: "image-metadata", ID: image.ConfigDigest, Name: item.ImageRef, Status: "present", Description: image.ManifestDigest})
			item.Status = StatusReferenced
			if !image.PulledAt.IsZero() {
				item.LastUsedAt = image.PulledAt.UTC()
				item.LastUsedSource = "image-metadata"
			}
		}
		result.Items = append(result.Items, EvaluateProtection(withOCIItemID(item)))
	}
	blobsRoot := filepath.Join(s.Cache.OCILayoutPath(), "blobs")
	_ = filepath.WalkDir(blobsRoot, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			result.Warnings = AppendWarnings(result.Warnings, walkErr.Error())
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(blobsRoot, current)
		if relErr != nil {
			return nil
		}
		digest := strings.Replace(filepath.ToSlash(rel), "/", ":", 1)
		if _, ok := reachable[digest]; ok {
			return nil
		}
		info, _ := entry.Info()
		item := Item{Domain: DomainOCIImageStore, Driver: DriverAll, Kind: KindOCIOrphanBlob, Path: current, ImageID: digest, Status: StatusOrphaned, LastUsedSource: LastUsedSourceMTime}
		if info != nil {
			item.SizeBytes = uint64(info.Size())
			item.LastUsedAt = info.ModTime().UTC()
		}
		result.Items = append(result.Items, EvaluateProtection(withOCIItemID(item)))
		return nil
	})
	tmpRoot := filepath.Join(s.Cache.Root(), "tmp")
	if entries, readErr := os.ReadDir(tmpRoot); readErr == nil {
		for _, entry := range entries {
			path := filepath.Join(tmpRoot, entry.Name())
			info, _ := entry.Info()
			item := Item{Domain: DomainOCIImageStore, Driver: DriverAll, Kind: KindOCITemp, Path: path, Status: StatusOrphaned, LastUsedSource: LastUsedSourceMTime}
			item.SizeBytes, item.Warnings = EstimateSize(path)
			if info != nil {
				item.LastUsedAt = info.ModTime().UTC()
			}
			result.Items = append(result.Items, EvaluateProtection(withOCIItemID(item)))
		}
	}
	return result, nil
}

func (s OCISource) Remove(ctx context.Context, requested Item) error {
	if s.Cache == nil {
		return ErrRemoveUnavailable
	}
	unlock, err := s.Cache.Lock()
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()
	latest, err := s.listLocked(ctx)
	if err != nil {
		return err
	}
	resolved, err := ResolveCacheID(latest.Items, requested.CacheID)
	if err != nil {
		return err
	}
	var item Item
	for _, candidate := range latest.Items {
		if candidate.CacheID == resolved {
			item = EvaluateProtection(candidate)
			break
		}
	}
	if item.CacheID == "" || !item.Removable {
		return fmt.Errorf("OCI cache item is no longer safely removable")
	}
	switch item.Kind {
	case KindOCIManifest:
		digest, err := v1.NewHash(item.ImageID)
		if err != nil {
			return err
		}
		ociPath := layout.Path(s.Cache.OCILayoutPath())
		if err := ociPath.RemoveDescriptors(match.Digests(digest)); err != nil {
			return fmt.Errorf("update OCI index: %w", err)
		}
		orphans, err := ociPath.GarbageCollect()
		if err != nil {
			return fmt.Errorf("mark OCI orphan blobs: %w", err)
		}
		for _, orphan := range orphans {
			if err := ociPath.RemoveBlob(orphan); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("sweep OCI blob %s: %w", orphan, err)
			}
		}
		return nil
	case KindOCIOrphanBlob:
		digest, err := v1.NewHash(item.ImageID)
		if err != nil {
			return err
		}
		return layout.Path(s.Cache.OCILayoutPath()).RemoveBlob(digest)
	case KindOCITemp:
		safe, err := ValidateCachePath(filepath.Join(s.Cache.Root(), "tmp"), item.Path)
		if err != nil {
			return err
		}
		return os.RemoveAll(safe.CanonicalTarget)
	default:
		return fmt.Errorf("unsupported OCI cache kind %q", item.Kind)
	}
}

func collectOCIIndexReachability(index v1.ImageIndex, reachable map[string]struct{}) error {
	manifest, err := index.IndexManifest()
	if err != nil {
		return err
	}
	for _, descriptor := range manifest.Manifests {
		reachable[descriptor.Digest.String()] = struct{}{}
		if descriptor.MediaType.IsImage() {
			image, err := index.Image(descriptor.Digest)
			if err != nil {
				return err
			}
			config, err := image.ConfigName()
			if err != nil {
				return err
			}
			reachable[config.String()] = struct{}{}
			layers, err := image.Layers()
			if err != nil {
				return err
			}
			for _, layer := range layers {
				digest, digestErr := layer.Digest()
				if digestErr != nil {
					return digestErr
				}
				reachable[digest.String()] = struct{}{}
			}
		} else if descriptor.MediaType.IsIndex() {
			nested, err := index.ImageIndex(descriptor.Digest)
			if err != nil {
				return err
			}
			if err := collectOCIIndexReachability(nested, reachable); err != nil {
				return err
			}
		}
	}
	return nil
}

func ociBlobPath(root string, digest v1.Hash) string {
	return filepath.Join(root, "blobs", digest.Algorithm, digest.Hex)
}

func ociUnknownItem(path string, err error) Item {
	info, _ := os.Stat(path)
	item := Item{Domain: DomainOCIImageStore, Driver: DriverAll, Kind: "oci-layout", Path: path, Status: StatusUnknown, LastUsedSource: LastUsedSourceMTime, Warnings: []string{err.Error()}}
	if info != nil {
		item.LastUsedAt = info.ModTime().UTC()
	}
	return EvaluateProtection(withOCIItemID(item))
}

func withOCIItemID(item Item) Item {
	cacheID, err := GenerateCacheID(item)
	if err != nil {
		item.Status = StatusUnknown
		item.Warnings = append(item.Warnings, err.Error())
		return item
	}
	item.CacheID = cacheID
	return item
}
