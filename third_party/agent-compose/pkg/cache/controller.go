package cache

import (
	"context"
	"fmt"
	"time"
)

type Source interface {
	List(context.Context) (ListResult, error)
	Remove(context.Context, Item) error
}

type Controller struct {
	Sources []Source
	Now     func() time.Time
	TTL     time.Duration
}

func (c *Controller) ListCaches(ctx context.Context, req ListRequest) (ListResult, error) {
	items, warnings, _, err := c.inventory(ctx)
	if err != nil {
		return ListResult{}, err
	}
	filtered, err := FilterItems(items, req.Filter, c.now())
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Items: filtered, Warnings: warnings}, nil
}

func (c *Controller) InspectCache(ctx context.Context, cacheID string) (ListResult, error) {
	items, warnings, _, err := c.inventory(ctx)
	if err != nil {
		return ListResult{}, err
	}
	resolved, err := ResolveCacheID(items, cacheID)
	if err != nil {
		return ListResult{Warnings: warnings}, err
	}
	for _, item := range items {
		if item.CacheID == resolved {
			return ListResult{Items: []Item{item}, Warnings: warnings}, nil
		}
	}
	return ListResult{Warnings: warnings}, fmt.Errorf("%w: %s", ErrCacheNotFound, cacheID)
}

func (c *Controller) PruneCaches(ctx context.Context, req PruneRequest) (Result, error) {
	items, warnings, sources, err := c.inventory(ctx)
	if err != nil {
		return Result{}, err
	}
	result, err := PruneItems(ctx, items, req, c.now(), sourceRemoveFunc(sources))
	if err != nil {
		return result, err
	}
	result.Warnings = AppendWarnings(warnings, result.Warnings...)
	return result, nil
}

func (c *Controller) RemoveCache(ctx context.Context, req RemoveRequest) (Result, error) {
	items, warnings, sources, err := c.inventory(ctx)
	if err != nil {
		return Result{}, err
	}
	resolved, err := ResolveCacheID(items, req.CacheID)
	if err != nil {
		return Result{Warnings: warnings}, err
	}
	req.CacheID = resolved
	result, err := RemoveItem(ctx, items, req, c.now(), sourceRemoveFunc(sources))
	if err != nil {
		return result, err
	}
	result.Warnings = AppendWarnings(warnings, result.Warnings...)
	return result, nil
}

func (c *Controller) inventory(ctx context.Context) ([]Item, []string, map[string]Source, error) {
	var items []Item
	var warnings []string
	sources := make(map[string]Source)
	for _, source := range c.Sources {
		if source == nil {
			continue
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, nil, err
		}
		result, err := source.List(ctx)
		if err != nil {
			return nil, nil, nil, err
		}
		warnings = AppendWarnings(warnings, result.Warnings...)
		for _, item := range result.Items {
			item = c.evaluateStatus(item)
			items = append(items, item)
			if item.CacheID != "" {
				sources[item.CacheID] = source
			}
		}
	}
	return items, warnings, sources, nil
}

func (c *Controller) evaluateStatus(item Item) Item {
	if item.Status == StatusActive || item.Status == StatusUnknown || item.Status == StatusOrphaned {
		return EvaluateProtection(item)
	}
	if HasRequiredReferences(item.References) {
		item.Status = StatusReferenced
		return EvaluateProtection(item)
	}
	if c.TTL > 0 && !item.LastUsedAt.IsZero() && c.now().Sub(item.LastUsedAt) >= c.TTL {
		item.Status = StatusExpired
	} else {
		item.Status = StatusUnused
	}
	return EvaluateProtection(item)
}

func (c *Controller) now() time.Time {
	if c != nil && c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func sourceRemoveFunc(sources map[string]Source) RemoveFunc {
	return func(ctx context.Context, item Item) error {
		source := sources[item.CacheID]
		if source == nil {
			return ErrRemoveUnavailable
		}
		return source.Remove(ctx, item)
	}
}

type MaterializedSource struct {
	Scanner MaterializedScanner
	Remover MaterializedRemover
}

func (s MaterializedSource) List(ctx context.Context) (ListResult, error) {
	if s.Scanner.Cache == nil {
		return s.Scanner.List(ctx)
	}
	unlock, err := s.Scanner.Cache.Lock()
	if err != nil {
		return ListResult{}, err
	}
	defer func() { _ = unlock() }()
	return s.Scanner.List(ctx)
}

func (s MaterializedSource) Remove(ctx context.Context, item Item) error {
	if s.Scanner.Cache == nil || s.Remover.Cache == nil || s.Scanner.Cache.Root() != s.Remover.Cache.Root() {
		return fmt.Errorf("materialized cache source requires one shared image cache")
	}
	unlock, err := s.Remover.Cache.Lock()
	if err != nil {
		return err
	}
	defer func() { _ = unlock() }()
	latest, err := s.Scanner.List(ctx)
	if err != nil {
		return err
	}
	resolved, err := ResolveCacheID(latest.Items, item.CacheID)
	if err != nil {
		return err
	}
	for _, candidate := range latest.Items {
		candidate = EvaluateProtection(candidate)
		if candidate.CacheID == resolved {
			if !candidate.Removable {
				return fmt.Errorf("materialized cache item is no longer safely removable")
			}
			return s.Remover.removeLocked(ctx, candidate)
		}
	}
	return fmt.Errorf("%w: %s", ErrCacheNotFound, item.CacheID)
}
