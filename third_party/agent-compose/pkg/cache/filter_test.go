package cache

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestFilterItems(t *testing.T) {
	now := time.Date(2026, 7, 6, 10, 0, 0, 0, time.UTC)
	items := sampleFilterItems(now)

	tests := []struct {
		name   string
		filter Filter
		want   []string
	}{
		{
			name: "empty filter returns all items in stable order",
			want: []string{"materialized-old", "skill-active", "runtime-unknown", "oci-referenced"},
		},
		{
			name:   "driver",
			filter: Filter{Driver: DriverBoxLite},
			want:   []string{"materialized-old", "runtime-unknown"},
		},
		{
			name:   "driver all does not filter",
			filter: Filter{Driver: DriverAll},
			want:   []string{"materialized-old", "skill-active", "runtime-unknown", "oci-referenced"},
		},
		{
			name:   "domain",
			filter: Filter{Domain: DomainMaterializedImageCache},
			want:   []string{"materialized-old"},
		},
		{
			name:   "type",
			filter: Filter{Type: CacheTypeSkill},
			want:   []string{"skill-active"},
		},
		{
			name:   "status",
			filter: Filter{Status: StatusUnknown},
			want:   []string{"runtime-unknown"},
		},
		{
			name:   "older than",
			filter: Filter{OlderThan: 7 * 24 * time.Hour},
			want:   []string{"materialized-old", "oci-referenced"},
		},
		{
			name:   "cache id",
			filter: Filter{CacheID: "skill-active"},
			want:   []string{"skill-active"},
		},
		{
			name: "combined filters",
			filter: Filter{
				Driver:    DriverBoxLite,
				Type:      CacheTypeMaterialized,
				Status:    StatusUnused,
				OlderThan: 7 * 24 * time.Hour,
			},
			want: []string{"materialized-old"},
		},
		{
			name:   "no match",
			filter: Filter{Driver: DriverDocker, Status: StatusUnused},
			want:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := FilterItems(items, tt.filter, now)
			if err != nil {
				t.Fatalf("FilterItems returned error: %v", err)
			}
			if gotIDs := cacheIDs(got); !reflect.DeepEqual(gotIDs, tt.want) {
				t.Fatalf("FilterItems ids = %#v, want %#v", gotIDs, tt.want)
			}
		})
	}
}

func TestFilterItemsRejectsInvalidFilters(t *testing.T) {
	tests := []struct {
		name   string
		filter Filter
	}{
		{name: "driver", filter: Filter{Driver: "podman"}},
		{name: "domain", filter: Filter{Domain: Domain("bad-domain")}},
		{name: "type", filter: Filter{Type: CacheType("bad-type")}},
		{name: "status", filter: Filter{Status: Status("bad-status")}},
		{name: "duration", filter: Filter{OlderThan: -time.Second}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := FilterItems(sampleFilterItems(time.Now()), tt.filter, time.Now())
			if !errors.Is(err, ErrInvalidFilter) {
				t.Fatalf("FilterItems error = %v, want ErrInvalidFilter", err)
			}
		})
	}
}

func TestNormalizeHelpers(t *testing.T) {
	if got, ok := NormalizeDriver(" BOXLITE "); !ok || got != DriverBoxLite {
		t.Fatalf("NormalizeDriver = %q, %v", got, ok)
	}
	if got, ok := NormalizeDomain(Domain(" MATERIALIZED-IMAGE-CACHE ")); !ok || got != DomainMaterializedImageCache {
		t.Fatalf("NormalizeDomain = %q, %v", got, ok)
	}
	if got, ok := NormalizeType(CacheType(" Runtime ")); !ok || got != CacheTypeRuntime {
		t.Fatalf("NormalizeType = %q, %v", got, ok)
	}
	if got, ok := NormalizeStatus(Status(" Orphaned ")); !ok || got != StatusOrphaned {
		t.Fatalf("NormalizeStatus = %q, %v", got, ok)
	}
	if got, ok := DomainType(DomainSkillArtifactCache); !ok || got != CacheTypeSkill {
		t.Fatalf("DomainType = %q, %v", got, ok)
	}
	for _, tc := range []struct {
		cacheType CacheType
		domain    Domain
	}{
		{CacheTypeOCI, DomainOCIImageStore},
		{CacheTypeMaterialized, DomainMaterializedImageCache},
		{CacheTypeRuntime, DomainRuntimeDerivedCache},
		{CacheTypeSkill, DomainSkillArtifactCache},
	} {
		if got, ok := TypeDomain(tc.cacheType); !ok || got != tc.domain {
			t.Fatalf("TypeDomain(%q) = %q, %v", tc.cacheType, got, ok)
		}
	}
	if got, ok := TypeDomain(CacheType("bad")); ok || got != "" {
		t.Fatalf("TypeDomain bad = %q, %v", got, ok)
	}
}

func TestUnknownItemValuesDoNotMatchTypedFilters(t *testing.T) {
	now := time.Date(2026, 7, 6, 10, 0, 0, 0, time.UTC)
	items := []Item{
		{
			CacheID:    "unknown-domain",
			Domain:     Domain("future-domain"),
			Driver:     DriverBoxLite,
			Status:     StatusUnknown,
			LastUsedAt: now.Add(-10 * 24 * time.Hour),
		},
		{
			CacheID:    "unknown-status",
			Domain:     DomainRuntimeDerivedCache,
			Driver:     DriverBoxLite,
			Status:     Status("future-status"),
			LastUsedAt: now.Add(-10 * 24 * time.Hour),
		},
	}

	got, err := FilterItems(items, Filter{Type: CacheTypeRuntime, Status: StatusUnknown}, now)
	if err != nil {
		t.Fatalf("FilterItems returned error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("FilterItems matched unknown values: %#v", got)
	}
}

func sampleFilterItems(now time.Time) []Item {
	return []Item{
		{
			CacheID:        "materialized-old",
			Domain:         DomainMaterializedImageCache,
			Driver:         DriverBoxLite,
			Kind:           "materialized-oci-layout",
			Status:         StatusUnused,
			LastUsedAt:     now.Add(-8 * 24 * time.Hour),
			LastUsedSource: "metadata",
		},
		{
			CacheID:        "skill-active",
			Domain:         DomainSkillArtifactCache,
			Driver:         DriverMicrosandbox,
			Kind:           "skill-artifact",
			Status:         StatusActive,
			LastUsedAt:     now.Add(-2 * time.Hour),
			LastUsedSource: "mtime",
		},
		{
			CacheID: "runtime-unknown",
			Domain:  DomainRuntimeDerivedCache,
			Driver:  DriverBoxLite,
			Kind:    "boxlite-disk-image",
			Status:  StatusUnknown,
		},
		{
			CacheID:        "oci-referenced",
			Domain:         DomainOCIImageStore,
			Driver:         DriverDocker,
			Kind:           "oci-layout",
			Status:         StatusReferenced,
			LastUsedAt:     now.Add(-10 * 24 * time.Hour),
			LastUsedSource: "metadata",
		},
	}
}

func cacheIDs(items []Item) []string {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.CacheID)
	}
	return ids
}
