package cache

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidFilter = errors.New("invalid runtime cache filter")

func NormalizeDriver(driver string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "":
		return "", true
	case DriverAll:
		return DriverAll, true
	case DriverDocker:
		return DriverDocker, true
	case DriverBoxLite:
		return DriverBoxLite, true
	case DriverMicrosandbox:
		return DriverMicrosandbox, true
	default:
		return "", false
	}
}

func NormalizeDomain(domain Domain) (Domain, bool) {
	switch Domain(strings.ToLower(strings.TrimSpace(string(domain)))) {
	case "":
		return "", true
	case DomainOCIImageStore:
		return DomainOCIImageStore, true
	case DomainMaterializedImageCache:
		return DomainMaterializedImageCache, true
	case DomainRuntimeDerivedCache:
		return DomainRuntimeDerivedCache, true
	case DomainSkillArtifactCache:
		return DomainSkillArtifactCache, true
	default:
		return "", false
	}
}

func NormalizeType(cacheType CacheType) (CacheType, bool) {
	switch CacheType(strings.ToLower(strings.TrimSpace(string(cacheType)))) {
	case "":
		return "", true
	case CacheTypeOCI:
		return CacheTypeOCI, true
	case CacheTypeMaterialized:
		return CacheTypeMaterialized, true
	case CacheTypeRuntime:
		return CacheTypeRuntime, true
	case CacheTypeSkill:
		return CacheTypeSkill, true
	default:
		return "", false
	}
}

func NormalizeStatus(status Status) (Status, bool) {
	switch Status(strings.ToLower(strings.TrimSpace(string(status)))) {
	case "":
		return "", true
	case StatusActive:
		return StatusActive, true
	case StatusReferenced:
		return StatusReferenced, true
	case StatusUnused:
		return StatusUnused, true
	case StatusExpired:
		return StatusExpired, true
	case StatusOrphaned:
		return StatusOrphaned, true
	case StatusUnknown:
		return StatusUnknown, true
	default:
		return "", false
	}
}

func DomainType(domain Domain) (CacheType, bool) {
	switch domain {
	case DomainOCIImageStore:
		return CacheTypeOCI, true
	case DomainMaterializedImageCache:
		return CacheTypeMaterialized, true
	case DomainRuntimeDerivedCache:
		return CacheTypeRuntime, true
	case DomainSkillArtifactCache:
		return CacheTypeSkill, true
	default:
		return "", false
	}
}

func TypeDomain(cacheType CacheType) (Domain, bool) {
	switch cacheType {
	case CacheTypeOCI:
		return DomainOCIImageStore, true
	case CacheTypeMaterialized:
		return DomainMaterializedImageCache, true
	case CacheTypeRuntime:
		return DomainRuntimeDerivedCache, true
	case CacheTypeSkill:
		return DomainSkillArtifactCache, true
	default:
		return "", false
	}
}

func FilterItems(items []Item, filter Filter, now time.Time) ([]Item, error) {
	normalized, err := NormalizeFilter(filter)
	if err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(items))
	for _, item := range items {
		if !itemMatchesFilter(item, normalized, now) {
			continue
		}
		out = append(out, item)
	}
	return out, nil
}

func NormalizeFilter(filter Filter) (Filter, error) {
	driver, ok := NormalizeDriver(filter.Driver)
	if !ok {
		return Filter{}, fmt.Errorf("%w: unknown driver %q", ErrInvalidFilter, filter.Driver)
	}
	domain, ok := NormalizeDomain(filter.Domain)
	if !ok {
		return Filter{}, fmt.Errorf("%w: unknown domain %q", ErrInvalidFilter, filter.Domain)
	}
	cacheType, ok := NormalizeType(filter.Type)
	if !ok {
		return Filter{}, fmt.Errorf("%w: unknown type %q", ErrInvalidFilter, filter.Type)
	}
	status, ok := NormalizeStatus(filter.Status)
	if !ok {
		return Filter{}, fmt.Errorf("%w: unknown status %q", ErrInvalidFilter, filter.Status)
	}
	if filter.OlderThan < 0 {
		return Filter{}, fmt.Errorf("%w: older_than cannot be negative", ErrInvalidFilter)
	}
	filter.Driver = driver
	filter.Domain = domain
	filter.Type = cacheType
	filter.Status = status
	filter.CacheID = strings.TrimSpace(filter.CacheID)
	return filter, nil
}

func itemMatchesFilter(item Item, filter Filter, now time.Time) bool {
	if filter.CacheID != "" && item.CacheID != filter.CacheID {
		return false
	}
	if filter.Driver != "" && filter.Driver != DriverAll {
		driver, ok := NormalizeDriver(item.Driver)
		if !ok || driver != filter.Driver {
			return false
		}
	}
	if filter.Domain != "" {
		domain, ok := NormalizeDomain(item.Domain)
		if !ok || domain != filter.Domain {
			return false
		}
	}
	if filter.Type != "" {
		cacheType, ok := DomainType(item.Domain)
		if !ok || cacheType != filter.Type {
			return false
		}
	}
	if filter.Status != "" {
		status, ok := NormalizeStatus(item.Status)
		if !ok || status != filter.Status {
			return false
		}
	}
	if filter.OlderThan > 0 {
		if item.LastUsedAt.IsZero() || now.IsZero() || now.Sub(item.LastUsedAt) < filter.OlderThan {
			return false
		}
	}
	return true
}
