package cache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agent-compose/pkg/imagecache"
)

const (
	KindMaterializedOCILayout   = "materialized-oci-layout"
	KindMaterializedRootFS      = "materialized-rootfs"
	KindMaterializedTempDir     = "materialized-temp-dir"
	LastUsedSourceMTime         = "mtime"
	LastUsedSourceMetadata      = "metadata"
	materializedOCIDirName      = "oci"
	materializedRootFSDirName   = "rootfs"
	materializedOCIReadyName    = ".ready"
	materializedRootFSReadyName = ".rootfs.ready"
	materializedOCITempName     = "oci.tmp"
	materializedRootFSTempName  = "rootfs.tmp"
)

type MaterializedScanner struct {
	Cache        *imagecache.Cache
	Dependencies MaterializedDependencyProvider
}

type MaterializedDependency struct {
	SandboxID string
	Identity  string
	Status    string
}

type MaterializedDependencyProvider interface {
	MaterializedDependencies(context.Context) ([]MaterializedDependency, []string, error)
}

func (s MaterializedScanner) List(ctx context.Context) (ListResult, error) {
	if err := ctx.Err(); err != nil {
		return ListResult{}, err
	}
	if s.Cache == nil {
		return ListResult{}, fmt.Errorf("runtime cache materialized scanner requires image cache")
	}
	root := s.Cache.MaterializationRoot()
	metadata, warnings := s.loadMetadata()
	refs, metadataWarnings := materializedMetadataRefs(s.Cache, metadata.Images)
	result := ListResult{Warnings: AppendWarnings(warnings, metadataWarnings...)}
	if s.Dependencies != nil {
		dependencies, dependencyWarnings, err := s.Dependencies.MaterializedDependencies(ctx)
		result.Warnings = AppendWarnings(result.Warnings, dependencyWarnings...)
		if err != nil {
			return ListResult{}, err
		}
		applyMaterializedDependencies(s.Cache, metadata.Images, refs, dependencies)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		result.Warnings = AppendWarnings(result.Warnings, fmt.Sprintf("scan materialized root %s: %v", root, err))
		return result, nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return ListResult{}, err
		}
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		result.Items = append(result.Items, s.scanMaterializedDir(dir, refs)...)
	}
	return result, nil
}

func applyMaterializedDependencies(imageCache *imagecache.Cache, images []imagecache.ImageMetadata, refs map[string][]Reference, dependencies []MaterializedDependency) {
	for _, dependency := range dependencies {
		identity := strings.TrimSpace(dependency.Identity)
		if identity == "" {
			continue
		}
		for _, image := range images {
			if !materializedImageMatchesIdentity(image, identity) {
				continue
			}
			imageID := firstMaterializedNonEmpty(image.ConfigDigest, image.CacheKey, image.ManifestDigest)
			if imageID == "" {
				continue
			}
			ref := Reference{Policy: ReferencePolicyRequired, Type: "sandbox", ID: dependency.SandboxID, Name: dependency.SandboxID, Status: dependency.Status, Description: "sandbox runtime materialization dependency"}
			for _, path := range []string{imageCache.MaterializedOCILayoutPath(imageID), imageCache.MaterializedRootFSPath(imageID)} {
				addMaterializedRef(refs, ref, path)
			}
		}
	}
}

func materializedImageMatchesIdentity(image imagecache.ImageMetadata, identity string) bool {
	for _, candidate := range []string{image.ConfigDigest, image.CacheKey, image.ManifestDigest, image.RequestedRef, image.NormalizedRef, firstMaterializedImageRef(image)} {
		if strings.TrimSpace(candidate) == identity {
			return true
		}
	}
	return false
}

func (s MaterializedScanner) loadMetadata() (imagecache.MetadataFile, []string) {
	metadata, err := s.Cache.LoadMetadata()
	if err != nil {
		return imagecache.MetadataFile{}, []string{fmt.Sprintf("load image metadata %s: %v", s.Cache.MetadataPath(), err)}
	}
	return metadata, nil
}

func (s MaterializedScanner) scanMaterializedDir(dir string, refs map[string][]Reference) []Item {
	var items []Item
	for _, child := range []struct {
		name string
		kind string
	}{
		{name: materializedOCIDirName, kind: KindMaterializedOCILayout},
		{name: materializedRootFSDirName, kind: KindMaterializedRootFS},
		{name: materializedOCITempName, kind: KindMaterializedTempDir},
		{name: materializedRootFSTempName, kind: KindMaterializedTempDir},
	} {
		path := filepath.Join(dir, child.name)
		info, err := os.Lstat(path)
		if err != nil {
			if !os.IsNotExist(err) {
				items = append(items, warningItem(path, child.kind, fmt.Sprintf("stat materialized path %s: %v", path, err)))
			}
			continue
		}
		item := s.materializedItem(path, child.kind, info, refs[path])
		items = append(items, item)
	}
	if len(items) == 0 {
		info, err := os.Lstat(dir)
		if err != nil {
			return []Item{warningItem(dir, "materialized-image-dir", fmt.Sprintf("stat materialized image dir %s: %v", dir, err))}
		}
		items = append(items, s.materializedItem(dir, KindMaterializedTempDir, info, nil))
		items[len(items)-1].Status = StatusOrphaned
	}
	return items
}

func (s MaterializedScanner) materializedItem(path, kind string, info os.FileInfo, refs []Reference) Item {
	size, warnings := EstimateSize(path)
	status := StatusOrphaned
	if len(refs) > 0 {
		status = StatusReferenced
	}
	if kind == KindMaterializedTempDir {
		status = StatusOrphaned
	}
	item := Item{
		Domain:         DomainMaterializedImageCache,
		Driver:         DriverAll,
		Kind:           kind,
		Path:           path,
		SizeBytes:      size,
		Status:         status,
		LastUsedAt:     info.ModTime().UTC(),
		LastUsedSource: LastUsedSourceMTime,
		References:     refs,
		Warnings:       warnings,
	}
	if readyName := materializedReadyName(kind); readyName != "" {
		readyPath := filepath.Join(filepath.Dir(path), readyName)
		readyInfo, readyErr := os.Lstat(readyPath)
		switch {
		case readyErr != nil:
			item.Status = StatusOrphaned
			item.Warnings = AppendWarnings(item.Warnings, fmt.Sprintf("materialized cache ready flag %s is missing: %v", readyPath, readyErr))
		case !readyInfo.Mode().IsRegular():
			item.Status = StatusUnknown
			item.Warnings = AppendWarnings(item.Warnings, fmt.Sprintf("materialized cache ready flag %s is not a regular file", readyPath))
		default:
			item.SizeBytes += uint64(readyInfo.Size())
			if readyInfo.ModTime().After(item.LastUsedAt) {
				item.LastUsedAt = readyInfo.ModTime().UTC()
			}
		}
	}
	if len(refs) > 0 {
		item.ImageID = refs[0].ID
		item.ImageRef = refs[0].Name
		item.ResolvedRef = refs[0].Description
	}
	if cacheID, err := GenerateCacheID(item); err == nil {
		item.CacheID = cacheID
	} else {
		item.Status = StatusUnknown
		item.Warnings = AppendWarnings(item.Warnings, err.Error())
	}
	return EvaluateProtection(item)
}

func materializedReadyName(kind string) string {
	switch kind {
	case KindMaterializedOCILayout:
		return materializedOCIReadyName
	case KindMaterializedRootFS:
		return materializedRootFSReadyName
	default:
		return ""
	}
}

func materializedMetadataRefs(cache *imagecache.Cache, images []imagecache.ImageMetadata) (map[string][]Reference, []string) {
	refs := make(map[string][]Reference)
	var warnings []string
	materializationRoot := cache.MaterializationRoot()
	for _, image := range images {
		imageID := firstMaterializedNonEmpty(image.ConfigDigest, image.CacheKey, image.ManifestDigest, image.NormalizedRef)
		if imageID == "" {
			continue
		}
		ref := Reference{
			Policy:      ReferencePolicyAdvisory,
			Type:        "image-metadata",
			ID:          imageID,
			Name:        firstMaterializedNonEmpty(image.RequestedRef, image.NormalizedRef),
			Description: firstMaterializedNonEmpty(firstMaterializedImageRef(image), image.ManifestDigest, image.CacheKey),
		}
		for _, path := range []string{cache.MaterializedOCILayoutPath(imageID), cache.MaterializedRootFSPath(imageID)} {
			addMaterializedRef(refs, ref, path)
		}
		for _, path := range []string{image.LayoutCachePath, image.RootFSCachePath} {
			path = strings.TrimSpace(path)
			if path == "" {
				continue
			}
			abs, err := filepath.Abs(path)
			if err != nil {
				continue
			}
			addMaterializedRef(refs, ref, abs)
			if pathWithinRoot(materializationRoot, abs) {
				if _, err := os.Lstat(abs); err != nil {
					warnings = AppendWarnings(warnings, fmt.Sprintf("metadata materialized path %s for image %s: %v", abs, imageID, err))
				}
			}
		}
	}
	return refs, warnings
}

func addMaterializedRef(refs map[string][]Reference, ref Reference, path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return
	}
	ref.Path = abs
	appendMaterializedRef(refs, abs, ref)
	switch filepath.Base(abs) {
	case materializedOCIDirName:
		ready := filepath.Join(filepath.Dir(abs), materializedOCIReadyName)
		readyRef := ref
		readyRef.Path = ready
		appendMaterializedRef(refs, ready, readyRef)
	case materializedRootFSDirName:
		ready := filepath.Join(filepath.Dir(abs), materializedRootFSReadyName)
		readyRef := ref
		readyRef.Path = ready
		appendMaterializedRef(refs, ready, readyRef)
	}
}

func appendMaterializedRef(refs map[string][]Reference, path string, ref Reference) {
	for _, existing := range refs[path] {
		if existing.Type == ref.Type && existing.ID == ref.ID && existing.Name == ref.Name && existing.Description == ref.Description {
			return
		}
	}
	refs[path] = append(refs[path], ref)
}

func warningItem(path, kind, warning string) Item {
	item := Item{
		Domain:         DomainMaterializedImageCache,
		Driver:         DriverAll,
		Kind:           kind,
		Path:           path,
		Status:         StatusUnknown,
		LastUsedAt:     time.Time{},
		LastUsedSource: LastUsedSourceMTime,
		Warnings:       []string{warning},
	}
	if cacheID, err := GenerateCacheID(item); err == nil {
		item.CacheID = cacheID
	}
	return EvaluateProtection(item)
}

func firstMaterializedImageRef(image imagecache.ImageMetadata) string {
	if len(image.RepoDigests) > 0 && strings.TrimSpace(image.RepoDigests[0]) != "" {
		return image.RepoDigests[0]
	}
	if len(image.RepoTags) > 0 && strings.TrimSpace(image.RepoTags[0]) != "" {
		return image.RepoTags[0]
	}
	return ""
}

func firstMaterializedNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
