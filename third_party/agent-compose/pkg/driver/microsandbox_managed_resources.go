//go:build linux && cgo && microsandboxcgo

package driver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	appconfig "agent-compose/pkg/config"
	microsandbox "github.com/superradcompany/microsandbox/sdk/go"
)

func ListMicrosandboxManagedResources(ctx context.Context, config *appconfig.Config) ([]ManagedRuntimeResource, []string, error) {
	if config == nil || strings.TrimSpace(config.MicrosandboxHome) == "" {
		return nil, nil, nil
	}
	bySandbox := map[string]*ManagedRuntimeResource{}
	handles, err := microsandbox.ListSandboxesWith(ctx, microsandbox.NewSandboxFilter().WithLabels(map[string]string{microsandboxManagedLabel: "true"}))
	if err != nil {
		return nil, nil, err
	}
	for _, handle := range handles {
		if handle == nil {
			continue
		}
		cfg, configErr := handle.Config()
		sandboxID := ""
		if configErr == nil && cfg != nil {
			sandboxID = strings.TrimSpace(cfg.Labels[microsandboxSandboxIDLabel])
		}
		valid := sandboxID != ""
		removable := valid && !strings.EqualFold(string(handle.Status()), "running")
		resource := &ManagedRuntimeResource{Driver: RuntimeDriverMicrosandbox, RuntimeID: handle.Name(), SandboxID: sandboxID, UpdatedAt: handle.UpdatedAt().UTC(), OwnershipValid: valid, Removable: removable}
		if configErr != nil {
			resource.BlockedReasons = append(resource.BlockedReasons, "microsandbox config cannot be decoded")
		}
		if !valid {
			resource.BlockedReasons = append(resource.BlockedReasons, "microsandbox sandbox id label is missing")
		}
		if !removable && valid {
			resource.BlockedReasons = append(resource.BlockedReasons, "microsandbox runtime is active")
		}
		bySandbox[sandboxID+"\x00"+handle.Name()] = resource
	}
	diskRoot := filepath.Join(config.MicrosandboxHome, "docker-disks")
	entries, readErr := os.ReadDir(diskRoot)
	var warnings []string
	if readErr != nil && !os.IsNotExist(readErr) {
		warnings = append(warnings, fmt.Sprintf("read microsandbox disk ownership: %v", readErr))
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".raw.owner.json") {
			continue
		}
		manifestPath := filepath.Join(diskRoot, entry.Name())
		ownership, ownershipErr := readMicrosandboxDiskOwnership(config.MicrosandboxHome, manifestPath)
		if ownershipErr != nil {
			warnings = append(warnings, ownershipErr.Error())
			bySandbox["unsafe-sidecar\x00"+entry.Name()] = &ManagedRuntimeResource{
				Driver: RuntimeDriverMicrosandbox, RuntimeID: entry.Name(),
				OwnershipValid: false, Removable: false,
				BlockedReasons: []string{"microsandbox disk ownership sidecar is invalid"},
			}
			continue
		}
		var resource *ManagedRuntimeResource
		for _, candidate := range bySandbox {
			if candidate.SandboxID == ownership.SandboxID {
				resource = candidate
				break
			}
		}
		if resource == nil {
			resource = &ManagedRuntimeResource{Driver: RuntimeDriverMicrosandbox, SandboxID: ownership.SandboxID, UpdatedAt: ownership.CreatedAt, OwnershipValid: true, Removable: true}
			bySandbox[ownership.SandboxID+"\x00"] = resource
		}
		resource.OwnedPaths = append(resource.OwnedPaths, ownership.DiskPath, manifestPath)
	}
	result := make([]ManagedRuntimeResource, 0, len(bySandbox))
	for _, resource := range bySandbox {
		result = append(result, *resource)
	}
	return result, warnings, nil
}

func RemoveMicrosandboxManagedResource(ctx context.Context, config *appconfig.Config, requested ManagedRuntimeResource) error {
	if !requested.OwnershipValid || requested.Driver != RuntimeDriverMicrosandbox || strings.TrimSpace(requested.SandboxID) == "" {
		return fmt.Errorf("microsandbox managed resource ownership is incomplete")
	}
	latest, _, err := ListMicrosandboxManagedResources(ctx, config)
	if err != nil {
		return err
	}
	var resource *ManagedRuntimeResource
	for i := range latest {
		if latest[i].SandboxID == requested.SandboxID && latest[i].RuntimeID == requested.RuntimeID {
			resource = &latest[i]
			break
		}
	}
	if resource == nil || !resource.OwnershipValid || !resource.Removable {
		return fmt.Errorf("microsandbox ownership changed before removal")
	}
	if resource.RuntimeID != "" {
		if err := microsandbox.RemoveSandbox(ctx, resource.RuntimeID); err != nil && !microsandbox.IsKind(err, microsandbox.ErrSandboxNotFound) {
			return err
		}
	}
	for _, path := range resource.OwnedPaths {
		if err := validateMicrosandboxOwnedPath(config.MicrosandboxHome, path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func readMicrosandboxDiskOwnership(home, manifestPath string) (microsandboxDiskOwnership, error) {
	if err := validateMicrosandboxOwnedPath(home, manifestPath); err != nil {
		return microsandboxDiskOwnership{}, err
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return microsandboxDiskOwnership{}, err
	}
	var ownership microsandboxDiskOwnership
	if err := json.Unmarshal(data, &ownership); err != nil {
		return microsandboxDiskOwnership{}, fmt.Errorf("decode microsandbox disk ownership %s: %w", manifestPath, err)
	}
	if ownership.Version != 1 || strings.TrimSpace(ownership.SandboxID) == "" || strings.TrimSpace(ownership.DiskPath) == "" || ownership.CreatedAt.IsZero() {
		return microsandboxDiskOwnership{}, fmt.Errorf("microsandbox disk ownership %s is incomplete", manifestPath)
	}
	if err := validateMicrosandboxOwnedPath(home, ownership.DiskPath); err != nil {
		return microsandboxDiskOwnership{}, err
	}
	wantManifest := filepath.Clean(ownership.DiskPath + ".owner.json")
	if filepath.Clean(manifestPath) != wantManifest {
		return microsandboxDiskOwnership{}, fmt.Errorf("microsandbox disk ownership sidecar does not match disk path")
	}
	return ownership, nil
}
