package resources

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"agent-compose/pkg/cache"
	"agent-compose/pkg/identity"
	"agent-compose/pkg/images"
	domain "agent-compose/pkg/model"
)

type Kind string

var (
	ErrInvalidID       = errors.New("invalid resource id")
	ErrUnsupportedKind = errors.New("unsupported resource kind")
)

const (
	KindProject Kind = "project"
	KindAgent   Kind = "agent"
	KindRun     Kind = "run"
	KindSandbox Kind = "sandbox"
	KindImage   Kind = "image"
	KindCache   Kind = "cache"
)

type Target struct {
	Kind        Kind
	ID          string
	ShortID     string
	ProjectID   string
	ProjectName string
	AgentName   string
}

type ResolveOptions struct {
	ID    string
	Kinds []Kind
}

type StoredSource interface {
	FindResourceIDs(context.Context, ResolveOptions) ([]Target, error)
}

type SandboxSource interface {
	GetSandbox(context.Context, string) (*domain.Sandbox, error)
	ListSandboxes(context.Context, domain.SandboxListOptions) (domain.SandboxListResult, error)
}

type CacheSource interface {
	ListCaches(context.Context, cache.ListRequest) (cache.ListResult, error)
}

type Locator struct {
	stored    StoredSource
	sandboxes SandboxSource
	images    images.Backend
	caches    CacheSource
}

func NewLocator(stored StoredSource, sandboxes SandboxSource, imageBackend images.Backend, caches CacheSource) *Locator {
	return &Locator{stored: stored, sandboxes: sandboxes, images: imageBackend, caches: caches}
}

func (l *Locator) ResolveID(ctx context.Context, options ResolveOptions) ([]Target, []string, error) {
	options.ID = strings.TrimSpace(options.ID)
	if !identity.IsIDPrefix(options.ID) {
		return nil, nil, fmt.Errorf("%w: must be a full id or a hexadecimal id prefix", ErrInvalidID)
	}
	allowed, err := normalizeKinds(options.Kinds)
	if err != nil {
		return nil, nil, err
	}
	options.Kinds = orderedKinds(allowed)
	if l == nil || l.stored == nil {
		return nil, nil, fmt.Errorf("stored resource id source is required")
	}

	targets, err := l.stored.FindResourceIDs(ctx, options)
	if err != nil {
		return nil, nil, fmt.Errorf("find stored resource ids: %w", err)
	}
	var warnings []string
	if allows(allowed, KindSandbox) {
		matches, warning := l.findSandboxIDs(ctx, options.ID)
		targets = append(targets, matches...)
		warnings = appendWarning(warnings, warning)
	}
	if allows(allowed, KindCache) {
		matches, warning := l.findCacheIDs(ctx, options.ID)
		targets = append(targets, matches...)
		warnings = appendWarning(warnings, warning)
	}
	if allows(allowed, KindImage) {
		matches, warning := l.findImageIDs(ctx, options.ID)
		targets = append(targets, matches...)
		warnings = appendWarning(warnings, warning)
	}
	return bestTargets(targets, options.ID), uniqueStrings(warnings), nil
}

func (l *Locator) findSandboxIDs(ctx context.Context, ref string) ([]Target, string) {
	if l.sandboxes == nil {
		return nil, "sandbox id source is unavailable"
	}
	if isFullID(ref) {
		sandbox, err := l.sandboxes.GetSandbox(ctx, ref)
		if err == nil && sandbox != nil {
			return []Target{target(KindSandbox, sandbox.Summary.ID)}, ""
		}
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Sprintf("find sandbox id %q: %v", ref, err)
		}
		return nil, ""
	}
	result, err := l.sandboxes.ListSandboxes(ctx, domain.SandboxListOptions{Limit: int(^uint(0) >> 1)})
	if err != nil {
		return nil, fmt.Sprintf("find sandbox id %q: %v", ref, err)
	}
	var targets []Target
	for _, sandbox := range result.Sandboxes {
		if sandbox != nil && idMatches(sandbox.Summary.ID, ref) {
			targets = append(targets, target(KindSandbox, sandbox.Summary.ID))
		}
	}
	return targets, ""
}

func (l *Locator) findCacheIDs(ctx context.Context, ref string) ([]Target, string) {
	if l.caches == nil {
		return nil, "cache id source is unavailable"
	}
	result, err := l.caches.ListCaches(ctx, cache.ListRequest{})
	if err != nil {
		return nil, fmt.Sprintf("find cache id %q: %v", ref, err)
	}
	var targets []Target
	for _, item := range result.Items {
		if idMatches(item.CacheID, ref) {
			targets = append(targets, target(KindCache, item.CacheID))
		}
	}
	return targets, ""
}

func (l *Locator) findImageIDs(ctx context.Context, ref string) ([]Target, string) {
	if l.images == nil {
		return nil, "image id source is unavailable"
	}
	if isFullID(ref) {
		result, err := l.images.InspectImage(ctx, images.InspectRequest{ImageRef: ref})
		if err == nil && result.Image != nil && idMatches(result.Image.GetImageId(), ref) {
			return []Target{target(KindImage, result.Image.GetImageId())}, ""
		}
		if err != nil && !images.IsNotFound(err) {
			return nil, fmt.Sprintf("find image id %q: %v", ref, err)
		}
		return nil, ""
	}
	result, err := l.images.ListImages(ctx, images.ListRequest{All: true})
	if err != nil {
		return nil, fmt.Sprintf("find image id %q: %v", ref, err)
	}
	var targets []Target
	for _, image := range result.Images {
		if image != nil && idMatches(image.GetImageId(), ref) {
			targets = append(targets, target(KindImage, image.GetImageId()))
		}
	}
	return targets, ""
}

func target(kind Kind, id string) Target {
	return Target{Kind: kind, ID: strings.TrimSpace(id), ShortID: identity.ShortID(id)}
}

func idMatches(id, ref string) bool {
	hash, err := identity.Hash(id)
	if err != nil || !identity.IsIDPrefix(ref) {
		return false
	}
	ref = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(ref)), identity.Prefix)
	return strings.HasPrefix(hash, ref)
}

func isFullID(ref string) bool {
	_, err := identity.Hash(ref)
	return err == nil
}

func normalizeKinds(kinds []Kind) (map[Kind]bool, error) {
	allowed := make(map[Kind]bool, len(kinds))
	for _, kind := range kinds {
		switch kind {
		case KindProject, KindAgent, KindRun, KindSandbox, KindImage, KindCache:
			allowed[kind] = true
		default:
			return nil, fmt.Errorf("%w %q", ErrUnsupportedKind, kind)
		}
	}
	return allowed, nil
}

func orderedKinds(allowed map[Kind]bool) []Kind {
	all := []Kind{KindProject, KindAgent, KindRun, KindSandbox, KindImage, KindCache}
	if len(allowed) == 0 {
		return all
	}
	result := make([]Kind, 0, len(allowed))
	for _, kind := range all {
		if allowed[kind] {
			result = append(result, kind)
		}
	}
	return result
}

func allows(allowed map[Kind]bool, kind Kind) bool {
	return len(allowed) == 0 || allowed[kind]
}

func bestTargets(targets []Target, ref string) []Target {
	unique := make(map[string]Target)
	for _, item := range targets {
		if item.ID == "" || !idMatches(item.ID, ref) {
			continue
		}
		key := string(item.Kind) + "\x00" + item.ProjectID + "\x00" + item.ID
		unique[key] = item
	}
	exact := isFullID(ref)
	result := make([]Target, 0, len(unique))
	for _, item := range unique {
		if !exact || sameID(item.ID, ref) {
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		left := string(result[i].Kind) + "\x00" + result[i].ProjectName + "\x00" + result[i].AgentName + "\x00" + result[i].ID
		right := string(result[j].Kind) + "\x00" + result[j].ProjectName + "\x00" + result[j].AgentName + "\x00" + result[j].ID
		return left < right
	})
	return result
}

func sameID(left, right string) bool {
	leftHash, leftErr := identity.Hash(left)
	rightHash, rightErr := identity.Hash(right)
	return leftErr == nil && rightErr == nil && leftHash == rightHash
}

func appendWarning(values []string, value string) []string {
	if strings.TrimSpace(value) != "" {
		return append(values, value)
	}
	return values
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			if _, ok := seen[value]; !ok {
				seen[value] = struct{}{}
				result = append(result, value)
			}
		}
	}
	sort.Strings(result)
	return result
}
