//go:build linux && cgo && microsandboxcgo

package driver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type microsandboxDiskOwnership struct {
	Version   int       `json:"version"`
	SandboxID string    `json:"sandbox_id"`
	DiskPath  string    `json:"disk_path"`
	CreatedAt time.Time `json:"created_at"`
}

func writeMicrosandboxDiskOwnership(diskPath, sandboxID string) error {
	diskPath = filepath.Clean(strings.TrimSpace(diskPath))
	sandboxID = strings.TrimSpace(sandboxID)
	if diskPath == "." || sandboxID == "" {
		return fmt.Errorf("microsandbox disk ownership requires disk path and sandbox id")
	}
	manifestPath := diskPath + ".owner.json"
	createdAt := time.Now().UTC()
	if data, err := os.ReadFile(manifestPath); err == nil {
		var existing microsandboxDiskOwnership
		if json.Unmarshal(data, &existing) == nil && existing.Version == 1 && existing.SandboxID == sandboxID && !existing.CreatedAt.IsZero() {
			createdAt = existing.CreatedAt
		}
	}
	data, err := json.MarshalIndent(microsandboxDiskOwnership{Version: 1, SandboxID: sandboxID, DiskPath: diskPath, CreatedAt: createdAt}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(manifestPath), ".disk-owner-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, manifestPath); err != nil {
		return err
	}
	return nil
}
