package cache

import "time"

const (
	DriverAll          = "all"
	DriverDocker       = "docker"
	DriverBoxLite      = "boxlite"
	DriverMicrosandbox = "microsandbox"
)

type Domain string

const (
	DomainOCIImageStore          Domain = "oci-image-store"
	DomainMaterializedImageCache Domain = "materialized-image-cache"
	DomainRuntimeDerivedCache    Domain = "runtime-derived-cache"
	DomainSkillArtifactCache     Domain = "skill-artifact-cache"
)

type CacheType string

const (
	CacheTypeOCI          CacheType = "oci"
	CacheTypeMaterialized CacheType = "materialized"
	CacheTypeRuntime      CacheType = "runtime"
	CacheTypeSkill        CacheType = "skill"
)

type Status string

const (
	StatusActive     Status = "active"
	StatusReferenced Status = "referenced"
	StatusUnused     Status = "unused"
	StatusExpired    Status = "expired"
	StatusOrphaned   Status = "orphaned"
	StatusUnknown    Status = "unknown"
)

type Reference struct {
	Policy      ReferencePolicy
	Type        string
	ID          string
	Name        string
	Path        string
	Status      string
	Description string
}

type ReferencePolicy string

const (
	// The empty policy is treated as required so older inventory producers fail
	// closed instead of accidentally making referenced artifacts removable.
	ReferencePolicyRequired ReferencePolicy = "required"
	ReferencePolicyAdvisory ReferencePolicy = "advisory"
)

type Item struct {
	CacheID        string
	Domain         Domain
	Driver         string
	Kind           string
	Path           string
	SizeBytes      uint64
	ImageID        string
	ImageRef       string
	ResolvedRef    string
	Status         Status
	Removable      bool
	BlockedReasons []string
	LastUsedAt     time.Time
	LastUsedSource string
	References     []Reference
	Warnings       []string
}

type Filter struct {
	Driver    string
	Domain    Domain
	Type      CacheType
	Status    Status
	OlderThan time.Duration
	CacheID   string
}

type ListRequest struct {
	Filter Filter
}

type ListResult struct {
	Items    []Item
	Warnings []string
}

type PruneRequest struct {
	Filter Filter
	Force  bool
}

type RemoveRequest struct {
	CacheID string
	Force   bool
}

type Result struct {
	DryRun   bool
	Matched  []Item
	Removed  []string
	Skipped  []Item
	Warnings []string
}
