package sessions

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const OwnershipRecordVersion = 1

type DeletionStage string

const (
	DeletionStageIntent      DeletionStage = "intent"
	DeletionStageRuntimeStop DeletionStage = "runtime-stop"
	DeletionStageRuntime     DeletionStage = "runtime-remove"
	DeletionStageAccessories DeletionStage = "accessories-release"
	DeletionStageSandboxData DeletionStage = "sandbox-data-remove"
)

type OwnedResource struct {
	Kind     string `json:"kind"`
	Identity string `json:"identity"`
	Path     string `json:"path,omitempty"`
}

type CacheDependency struct {
	Domain   string `json:"domain"`
	Identity string `json:"identity"`
}

type OwnershipRecord struct {
	Version           int               `json:"version"`
	SandboxID         string            `json:"sandbox_id"`
	Driver            string            `json:"driver"`
	RuntimeID         string            `json:"runtime_id"`
	SandboxPath       string            `json:"sandbox_path"`
	OwnedResources    []OwnedResource   `json:"owned_resources,omitempty"`
	CacheDependencies []CacheDependency `json:"cache_dependencies,omitempty"`
	LifecycleState    string            `json:"lifecycle_state"`
	StopRequired      bool              `json:"stop_required,omitempty"`
	CompletedStages   []DeletionStage   `json:"completed_stages,omitempty"`
	UpdatedAt         time.Time         `json:"updated_at"`
}

func LifecycleRoot(sandboxRoot string) string {
	return filepath.Join(strings.TrimSpace(sandboxRoot), ".lifecycle")
}

func OwnershipRecordPath(sandboxRoot, sandboxID string) (string, error) {
	if err := validateOwnershipID(sandboxID); err != nil {
		return "", err
	}
	return filepath.Join(LifecycleRoot(sandboxRoot), sandboxID+".json"), nil
}

func WriteOwnershipRecord(sandboxRoot string, record OwnershipRecord) error {
	path, err := OwnershipRecordPath(sandboxRoot, record.SandboxID)
	if err != nil {
		return err
	}
	if record.Version == 0 {
		record.Version = OwnershipRecordVersion
	}
	if record.Version != OwnershipRecordVersion {
		return fmt.Errorf("unsupported ownership record version %d", record.Version)
	}
	if err := validateOwnedPath(sandboxRoot, record.SandboxPath); err != nil {
		return err
	}
	record.UpdatedAt = time.Now().UTC()
	record.CompletedStages = uniqueDeletionStages(record.CompletedStages)
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal sandbox ownership record: %w", err)
	}
	root := filepath.Dir(path)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("create lifecycle root: %w", err)
	}
	tmp, err := os.CreateTemp(root, ".ownership-*.tmp")
	if err != nil {
		return fmt.Errorf("create ownership temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write ownership temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync ownership temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close ownership temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace ownership record: %w", err)
	}
	return syncDirectory(root)
}

func ReadOwnershipRecord(sandboxRoot, sandboxID string) (OwnershipRecord, error) {
	path, err := OwnershipRecordPath(sandboxRoot, sandboxID)
	if err != nil {
		return OwnershipRecord{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return OwnershipRecord{}, err
	}
	var record OwnershipRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return OwnershipRecord{}, fmt.Errorf("decode ownership record %s: %w", sandboxID, err)
	}
	if record.Version != OwnershipRecordVersion || record.SandboxID != sandboxID {
		return OwnershipRecord{}, fmt.Errorf("ownership record %s has unsupported identity or version", sandboxID)
	}
	if err := validateOwnedPath(sandboxRoot, record.SandboxPath); err != nil {
		return OwnershipRecord{}, err
	}
	return record, nil
}

func ListOwnershipRecords(sandboxRoot string) ([]OwnershipRecord, []string) {
	entries, err := os.ReadDir(LifecycleRoot(sandboxRoot))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, []string{err.Error()}
	}
	var records []OwnershipRecord
	var warnings []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		record, readErr := ReadOwnershipRecord(sandboxRoot, id)
		if readErr != nil {
			warnings = append(warnings, fmt.Sprintf("read lifecycle record %s: %v", entry.Name(), readErr))
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].SandboxID < records[j].SandboxID })
	return records, warnings
}

func RemoveOwnershipRecord(sandboxRoot, sandboxID string) error {
	path, err := OwnershipRecordPath(sandboxRoot, sandboxID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (r OwnershipRecord) StageCompleted(stage DeletionStage) bool {
	for _, completed := range r.CompletedStages {
		if completed == stage {
			return true
		}
	}
	return false
}

func (r *OwnershipRecord) Complete(stage DeletionStage) {
	if !r.StageCompleted(stage) {
		r.CompletedStages = append(r.CompletedStages, stage)
	}
}

func validateOwnershipID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" || id == "." || id == ".." || filepath.Base(id) != id || strings.ContainsAny(id, `/\\`) {
		return fmt.Errorf("invalid sandbox ownership id %q", id)
	}
	return nil
}

func validateOwnedPath(root, target string) error {
	rootAbs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return err
	}
	targetAbs, err := filepath.Abs(strings.TrimSpace(target))
	if err != nil {
		return err
	}
	resolvedRoot, err := resolvePathFromExistingAncestor(rootAbs)
	if err != nil {
		return err
	}
	resolvedTarget, err := resolvePathFromExistingAncestor(targetAbs)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("sandbox ownership path %s is outside sandbox root %s", target, root)
	}
	return nil
}

func resolvePathFromExistingAncestor(path string) (string, error) {
	path = filepath.Clean(path)
	current := path
	var missing []string
	for {
		_, err := os.Lstat(current)
		if err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func uniqueDeletionStages(stages []DeletionStage) []DeletionStage {
	seen := make(map[DeletionStage]struct{}, len(stages))
	out := make([]DeletionStage, 0, len(stages))
	for _, stage := range stages {
		if stage == "" {
			continue
		}
		if _, ok := seen[stage]; ok {
			continue
		}
		seen[stage] = struct{}{}
		out = append(out, stage)
	}
	return out
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	if err := dir.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}
