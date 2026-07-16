package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	KindSkillArtifact = "skill-artifact"
	KindSkillTemp     = "skill-temp"
	KindSkillLock     = "skill-lock"
	skillManifestName = ".artifact.json"
	skillReadyName    = ".ready"
	skillRootLockName = ".cache.lock"
)

type SkillArtifactManifest struct {
	Version    int       `json:"version"`
	Source     string    `json:"source"`
	Identity   string    `json:"identity"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
}

type SkillSource struct {
	Root string
}

func (s SkillSource) List(ctx context.Context) (ListResult, error) {
	unlock, err := lockSkillRoot(s.Root, syscall.LOCK_SH)
	if err != nil {
		if os.IsNotExist(err) {
			return ListResult{}, nil
		}
		return ListResult{}, err
	}
	defer unlock()
	return s.listLocked(ctx)
}

func (s SkillSource) listLocked(ctx context.Context) (ListResult, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return ListResult{}, nil
		}
		return ListResult{}, fmt.Errorf("read skill cache root: %w", err)
	}
	result := ListResult{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return ListResult{}, err
		}
		if entry.Name() == skillRootLockName {
			continue
		}
		path := filepath.Join(s.Root, entry.Name())
		item := s.skillItem(path, entry)
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func (s SkillSource) skillItem(path string, entry os.DirEntry) Item {
	item := Item{Domain: DomainSkillArtifactCache, Driver: DriverAll, Path: path, LastUsedSource: LastUsedSourceMTime}
	info, err := entry.Info()
	if err != nil {
		item.Kind, item.Status = KindSkillArtifact, StatusUnknown
		item.Warnings = append(item.Warnings, err.Error())
		return withSkillCacheID(item)
	}
	item.LastUsedAt = info.ModTime().UTC()
	item.SizeBytes, item.Warnings = EstimateSize(path)
	if info.Mode()&os.ModeSymlink != 0 {
		item.Kind, item.Status = KindSkillArtifact, StatusUnknown
		item.Warnings = append(item.Warnings, "skill cache symlink is unsafe")
		return EvaluateProtection(withSkillCacheID(item))
	}
	switch {
	case strings.HasPrefix(entry.Name(), ".tmp-") && entry.IsDir():
		item.Kind, item.Status = KindSkillTemp, StatusOrphaned
	case strings.HasSuffix(entry.Name(), ".lock") && !entry.IsDir():
		item.Kind, item.Status = KindSkillLock, StatusOrphaned
		if skillLockBusy(path) {
			item.Status = StatusActive
		}
	case entry.IsDir():
		item.Kind = KindSkillArtifact
		manifest, manifestErr := loadSkillManifest(path)
		if manifestErr != nil {
			item.Status = StatusUnknown
			item.Warnings = append(item.Warnings, manifestErr.Error())
			break
		}
		if _, readyErr := os.Lstat(filepath.Join(path, skillReadyName)); readyErr != nil {
			item.Status = StatusOrphaned
			item.Warnings = append(item.Warnings, "skill artifact ready flag is missing")
			break
		}
		item.Status = StatusUnused
		item.LastUsedAt = manifest.LastUsedAt.UTC()
		item.LastUsedSource = "manifest"
		item.ResolvedRef = manifest.Identity
		item.References = []Reference{{Policy: ReferencePolicyAdvisory, Type: "skill-spec", ID: manifest.Identity, Name: manifest.Source, Description: "configured skill can be resolved again"}}
	default:
		item.Kind, item.Status = KindSkillArtifact, StatusUnknown
		item.Warnings = append(item.Warnings, "unrecognized skill cache entry")
	}
	return EvaluateProtection(withSkillCacheID(item))
}

func (s SkillSource) Remove(ctx context.Context, requested Item) error {
	unlock, err := lockSkillRoot(s.Root, syscall.LOCK_EX)
	if err != nil {
		return err
	}
	defer unlock()
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
			item = candidate
			break
		}
	}
	item = EvaluateProtection(item)
	if item.CacheID == "" || !item.Removable {
		return fmt.Errorf("skill cache item is no longer safely removable")
	}
	safe, err := ValidateCachePath(s.Root, item.Path)
	if err != nil {
		return err
	}
	var artifactLock *os.File
	if item.Kind == KindSkillArtifact {
		artifactLock, err = os.OpenFile(item.Path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return err
		}
		defer func() { _ = artifactLock.Close() }()
		if err := syscall.Flock(int(artifactLock.Fd()), syscall.LOCK_EX); err != nil {
			return err
		}
		defer func() { _ = syscall.Flock(int(artifactLock.Fd()), syscall.LOCK_UN) }()
	}
	if err := os.RemoveAll(safe.CanonicalTarget); err != nil {
		return fmt.Errorf("remove skill cache item: %w", err)
	}
	return nil
}

func loadSkillManifest(root string) (SkillArtifactManifest, error) {
	data, err := os.ReadFile(filepath.Join(root, skillManifestName))
	if err != nil {
		return SkillArtifactManifest{}, fmt.Errorf("read skill artifact manifest: %w", err)
	}
	var manifest SkillArtifactManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return SkillArtifactManifest{}, fmt.Errorf("decode skill artifact manifest: %w", err)
	}
	if manifest.Version != 1 || strings.TrimSpace(manifest.Source) == "" || strings.TrimSpace(manifest.Identity) == "" || manifest.CreatedAt.IsZero() || manifest.LastUsedAt.IsZero() {
		return SkillArtifactManifest{}, fmt.Errorf("skill artifact manifest is incomplete")
	}
	return manifest, nil
}

func lockSkillRoot(root string, mode int) (func(), error) {
	root = strings.TrimSpace(root)
	if root == "" || !filepath.IsAbs(root) {
		return nil, fmt.Errorf("skill cache root must be absolute")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(root, skillRootLockName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), mode); err != nil {
		_ = lock.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
	}, nil
}

func skillLockBusy(path string) bool {
	lock, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return true
	}
	defer func() { _ = lock.Close() }()
	err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		return false
	}
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

func withSkillCacheID(item Item) Item {
	cacheID, err := GenerateCacheID(item)
	if err != nil {
		item.Status = StatusUnknown
		item.Warnings = append(item.Warnings, err.Error())
		return item
	}
	item.CacheID = cacheID
	return item
}
