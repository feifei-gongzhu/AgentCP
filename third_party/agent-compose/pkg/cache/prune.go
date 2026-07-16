package cache

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrCacheNotFound     = errors.New("runtime cache item not found")
	ErrRemoveUnavailable = errors.New("runtime cache remover is unavailable")
)

type RemoveFunc func(context.Context, Item) error

func EvaluateProtection(item Item) Item {
	item.Status, _ = NormalizeStatus(item.Status)
	item.Removable = false
	item.BlockedReasons = nil
	hasRequired := HasRequiredReferences(item.References)

	switch item.Status {
	case StatusActive:
		item.BlockedReasons = AppendWarnings(item.BlockedReasons, "cache is active")
	case StatusUnknown, "":
		item.Status = StatusUnknown
		item.BlockedReasons = AppendWarnings(item.BlockedReasons, "cache safety is unknown")
	case StatusReferenced:
		if hasRequired || len(item.References) == 0 {
			item.BlockedReasons = AppendWarnings(item.BlockedReasons, "cache has a required reference")
		} else {
			item.Removable = true
		}
	case StatusUnused, StatusOrphaned:
		if hasRequired {
			item.Status = StatusReferenced
			item.BlockedReasons = AppendWarnings(item.BlockedReasons, "cache has a required reference")
		} else {
			item.Removable = true
		}
	case StatusExpired:
		if hasRequired {
			item.Status = StatusReferenced
			item.BlockedReasons = AppendWarnings(item.BlockedReasons, "expired cache has a required reference")
		} else {
			item.Removable = true
		}
	default:
		item.Status = StatusUnknown
		item.BlockedReasons = AppendWarnings(item.BlockedReasons, "cache safety is unknown")
	}
	return item
}

func NormalizeReferencePolicy(policy ReferencePolicy) ReferencePolicy {
	if policy == ReferencePolicyAdvisory {
		return ReferencePolicyAdvisory
	}
	return ReferencePolicyRequired
}

func HasRequiredReferences(refs []Reference) bool {
	for _, ref := range refs {
		if NormalizeReferencePolicy(ref.Policy) == ReferencePolicyRequired {
			return true
		}
	}
	return false
}

func PruneItems(ctx context.Context, items []Item, req PruneRequest, now time.Time, remove RemoveFunc) (Result, error) {
	matched, err := FilterItems(items, req.Filter, now)
	if err != nil {
		return Result{}, err
	}
	result := Result{DryRun: !req.Force}
	for _, item := range matched {
		item = EvaluateProtection(item)
		result.Matched = append(result.Matched, item)
		if !item.Removable {
			result.Skipped = append(result.Skipped, item)
			continue
		}
		if result.DryRun {
			continue
		}
		if remove == nil {
			return result, ErrRemoveUnavailable
		}
		if err := remove(ctx, item); err != nil {
			item.Removable = false
			item.BlockedReasons = AppendWarnings(item.BlockedReasons, "remove failed")
			result.Skipped = append(result.Skipped, item)
			result.Warnings = AppendWarnings(result.Warnings, fmt.Sprintf("remove %s: %v", item.CacheID, err))
			continue
		}
		result.Removed = append(result.Removed, item.CacheID)
	}
	return result, nil
}

func RemoveItem(ctx context.Context, items []Item, req RemoveRequest, now time.Time, remove RemoveFunc) (Result, error) {
	cacheID, err := ResolveCacheID(items, req.CacheID)
	if err != nil {
		return Result{}, err
	}
	if _, err := ParseCacheID(cacheID); err != nil {
		return Result{}, err
	}
	result, err := PruneItems(ctx, items, PruneRequest{
		Filter: Filter{
			CacheID: cacheID,
		},
		Force: req.Force,
	}, now, remove)
	if err != nil {
		return result, err
	}
	if len(result.Matched) == 0 {
		return result, fmt.Errorf("%w: %s", ErrCacheNotFound, cacheID)
	}
	return result, nil
}
