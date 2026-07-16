package cache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"agent-compose/pkg/imagecache"
)

type MaterializedRemover struct {
	Cache *imagecache.Cache
}

func (r MaterializedRemover) Remove(ctx context.Context, item Item) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r.Cache == nil {
		return fmt.Errorf("runtime cache materialized remover requires image cache")
	}
	if err := validateMaterializedRemoveItem(item); err != nil {
		return err
	}
	expectedID, err := GenerateCacheID(item)
	if err != nil {
		return err
	}
	if item.CacheID != expectedID {
		return fmt.Errorf("%w: cache id does not match inventory item", ErrInvalidCacheID)
	}

	unlock, err := r.Cache.Lock()
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()
	return r.removeLocked(ctx, item)
}

func (r MaterializedRemover) removeLocked(ctx context.Context, item Item) error {
	safe, err := ValidateCachePath(r.Cache.MaterializationRoot(), item.Path)
	if err != nil {
		return err
	}
	paths := []string{safe.CanonicalTarget}
	switch item.Kind {
	case KindMaterializedOCILayout:
		paths = append(paths, filepath.Join(safe.CanonicalParent, materializedOCIReadyName))
	case KindMaterializedRootFS:
		paths = append(paths, filepath.Join(safe.CanonicalParent, materializedRootFSReadyName))
	case KindMaterializedTempDir:
	default:
		return fmt.Errorf("unsupported materialized cache kind %q", item.Kind)
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

func validateMaterializedRemoveItem(item Item) error {
	if item.Domain != DomainMaterializedImageCache {
		return fmt.Errorf("materialized remover cannot remove domain %q", item.Domain)
	}
	if item.CacheID == "" {
		return fmt.Errorf("%w: cache id is required", ErrInvalidCacheID)
	}
	if _, err := ParseCacheID(item.CacheID); err != nil {
		return err
	}
	return nil
}
