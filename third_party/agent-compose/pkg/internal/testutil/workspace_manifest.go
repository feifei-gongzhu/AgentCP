// Package testutil contains reusable helpers for tests across pkg.
package testutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// WorkspaceManifestEntryType identifies the filesystem object represented by
// a WorkspaceManifestEntry.
type WorkspaceManifestEntryType string

const (
	WorkspaceManifestEntryTypeDirectory WorkspaceManifestEntryType = "directory"
	WorkspaceManifestEntryTypeFile      WorkspaceManifestEntryType = "file"
	WorkspaceManifestEntryTypeSymlink   WorkspaceManifestEntryType = "symlink"
)

// WorkspaceManifestEntry describes one filesystem object in a workspace.
// ContentSHA256 is populated only for regular files, and SymlinkTarget is
// populated only for symlinks.
type WorkspaceManifestEntry struct {
	Path          string
	Type          WorkspaceManifestEntryType
	Mode          fs.FileMode
	ContentSHA256 string
	SymlinkTarget string
}

// WorkspaceManifest recursively snapshots root without following symlinks.
// Paths are slash-normalized relative paths, including "." for root, and the
// returned entries are sorted by Path. Root must name a directory.
func WorkspaceManifest(root string) ([]WorkspaceManifestEntry, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("inspect workspace root %q: %w", root, err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("workspace root %q is not a directory (mode %s)", root, rootInfo.Mode())
	}

	manifest := make([]WorkspaceManifestEntry, 0)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return fmt.Errorf("make workspace path %q relative to %q: %w", path, root, err)
		}
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect workspace entry %q: %w", path, err)
		}

		item := WorkspaceManifestEntry{
			Path: filepath.ToSlash(relPath),
			Mode: info.Mode(),
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			item.Type = WorkspaceManifestEntryTypeSymlink
			item.SymlinkTarget, err = os.Readlink(path)
			if err != nil {
				return fmt.Errorf("read workspace symlink %q: %w", path, err)
			}
		case info.IsDir():
			item.Type = WorkspaceManifestEntryTypeDirectory
		case info.Mode().IsRegular():
			item.Type = WorkspaceManifestEntryTypeFile
			item.ContentSHA256, err = fileSHA256(path)
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported workspace entry %q with mode %s", path, info.Mode())
		}

		manifest = append(manifest, item)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("build workspace manifest for %q: %w", root, err)
	}

	sort.Slice(manifest, func(i, j int) bool {
		return manifest[i].Path < manifest[j].Path
	})
	return manifest, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open workspace file %q: %w", path, err)
	}

	hash := sha256.New()
	_, hashErr := io.Copy(hash, file)
	closeErr := file.Close()
	if hashErr != nil {
		return "", fmt.Errorf("hash workspace file %q: %w", path, hashErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close workspace file %q: %w", path, closeErr)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
