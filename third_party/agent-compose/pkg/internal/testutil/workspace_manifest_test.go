package testutil

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestWorkspaceManifestRecordsFilesDirectoriesAndModes(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "nested")
	file := filepath.Join(directory, "script.sh")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatalf("create directory: %v", err)
	}
	if err := os.Chmod(directory, 0o751); err != nil {
		t.Fatalf("set directory mode: %v", err)
	}
	if err := os.WriteFile(file, []byte("#!/bin/sh\necho manifest\n"), 0o600); err != nil {
		t.Fatalf("write regular file: %v", err)
	}
	if err := os.Chmod(file, 0o751); err != nil {
		t.Fatalf("set regular file mode: %v", err)
	}

	manifest, err := WorkspaceManifest(root)
	if err != nil {
		t.Fatalf("WorkspaceManifest returned error: %v", err)
	}

	entries := manifestByPath(t, manifest)
	assertManifestEntry(t, entries["."], WorkspaceManifestEntryTypeDirectory, mustLstat(t, root).Mode())
	assertManifestEntry(t, entries["nested"], WorkspaceManifestEntryTypeDirectory, fs.ModeDir|0o751)
	fileEntry := entries["nested/script.sh"]
	assertManifestEntry(t, fileEntry, WorkspaceManifestEntryTypeFile, 0o751)
	wantHash := sha256.Sum256([]byte("#!/bin/sh\necho manifest\n"))
	if fileEntry.ContentSHA256 != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("file content hash = %q, want %x", fileEntry.ContentSHA256, wantHash)
	}
	if fileEntry.SymlinkTarget != "" {
		t.Fatalf("regular file symlink target = %q, want empty", fileEntry.SymlinkTarget)
	}
	if entries["nested"].ContentSHA256 != "" {
		t.Fatalf("directory content hash = %q, want empty", entries["nested"].ContentSHA256)
	}
}

func TestWorkspaceManifestRecordsSymlinksWithoutFollowingThem(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeManifestFile(t, filepath.Join(root, "target.txt"), "inside")
	writeManifestFile(t, filepath.Join(outside, "secret.txt"), "outside secret")
	if err := os.Symlink("target.txt", filepath.Join(root, "inside-link")); err != nil {
		t.Fatalf("create in-tree symlink: %v", err)
	}
	if err := os.Symlink("missing.txt", filepath.Join(root, "broken-link")); err != nil {
		t.Fatalf("create broken symlink: %v", err)
	}
	outsideTarget := outside
	if err := os.Symlink(outsideTarget, filepath.Join(root, "outside-link")); err != nil {
		t.Fatalf("create outside symlink: %v", err)
	}

	manifest, err := WorkspaceManifest(root)
	if err != nil {
		t.Fatalf("WorkspaceManifest returned error: %v", err)
	}
	entries := manifestByPath(t, manifest)
	if len(entries) != 5 {
		t.Fatalf("manifest entry count = %d, want 5: %#v", len(entries), manifest)
	}

	for path, target := range map[string]string{
		"inside-link":  "target.txt",
		"broken-link":  "missing.txt",
		"outside-link": outsideTarget,
	} {
		entry := entries[path]
		assertManifestEntry(t, entry, WorkspaceManifestEntryTypeSymlink, mustLstat(t, filepath.Join(root, path)).Mode())
		if entry.SymlinkTarget != target {
			t.Errorf("%s symlink target = %q, want %q", path, entry.SymlinkTarget, target)
		}
		if entry.ContentSHA256 != "" {
			t.Errorf("%s content hash = %q, want empty", path, entry.ContentSHA256)
		}
	}
	if _, exists := entries["outside-link/secret.txt"]; exists {
		t.Fatal("outside symlink target was traversed into the workspace manifest")
	}
}

func TestWorkspaceManifestOrderIsDeterministic(t *testing.T) {
	root := t.TempDir()
	writeManifestFile(t, filepath.Join(root, "z.txt"), "z")
	writeManifestFile(t, filepath.Join(root, "a", "z.txt"), "nested z")
	writeManifestFile(t, filepath.Join(root, "a.txt"), "a")
	writeManifestFile(t, filepath.Join(root, "a", "a.txt"), "nested a")

	first, err := WorkspaceManifest(root)
	if err != nil {
		t.Fatalf("first WorkspaceManifest returned error: %v", err)
	}
	second, err := WorkspaceManifest(root)
	if err != nil {
		t.Fatalf("second WorkspaceManifest returned error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("repeated manifests differ:\nfirst:  %#v\nsecond: %#v", first, second)
	}

	gotPaths := make([]string, 0, len(first))
	for _, entry := range first {
		gotPaths = append(gotPaths, entry.Path)
	}
	wantPaths := []string{".", "a", "a.txt", "a/a.txt", "a/z.txt", "z.txt"}
	if !reflect.DeepEqual(gotPaths, wantPaths) {
		t.Fatalf("manifest paths = %#v, want sorted normalized paths %#v", gotPaths, wantPaths)
	}
}

func TestWorkspaceManifestReturnsRootErrors(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing")
		manifest, err := WorkspaceManifest(missing)
		if err == nil || !strings.Contains(err.Error(), "inspect workspace root") {
			t.Fatalf("WorkspaceManifest error = %v, want inspect workspace root error", err)
		}
		if manifest != nil {
			t.Fatalf("WorkspaceManifest = %#v, want nil on error", manifest)
		}
	})

	t.Run("regular file", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "file.txt")
		writeManifestFile(t, root, "not a directory")
		manifest, err := WorkspaceManifest(root)
		if err == nil || !strings.Contains(err.Error(), "is not a directory") {
			t.Fatalf("WorkspaceManifest error = %v, want not-a-directory error", err)
		}
		if manifest != nil {
			t.Fatalf("WorkspaceManifest = %#v, want nil on error", manifest)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		base := t.TempDir()
		target := filepath.Join(base, "target")
		if err := os.Mkdir(target, 0o755); err != nil {
			t.Fatalf("create target directory: %v", err)
		}
		root := filepath.Join(base, "root-link")
		if err := os.Symlink(target, root); err != nil {
			t.Fatalf("create root symlink: %v", err)
		}
		manifest, err := WorkspaceManifest(root)
		if err == nil || !strings.Contains(err.Error(), "is not a directory") {
			t.Fatalf("WorkspaceManifest error = %v, want root symlink rejection", err)
		}
		if manifest != nil {
			t.Fatalf("WorkspaceManifest = %#v, want nil on error", manifest)
		}
	})
}

func manifestByPath(t *testing.T, manifest []WorkspaceManifestEntry) map[string]WorkspaceManifestEntry {
	t.Helper()
	entries := make(map[string]WorkspaceManifestEntry, len(manifest))
	for _, entry := range manifest {
		if _, exists := entries[entry.Path]; exists {
			t.Fatalf("duplicate manifest path %q", entry.Path)
		}
		entries[entry.Path] = entry
	}
	return entries
}

func assertManifestEntry(t *testing.T, entry WorkspaceManifestEntry, wantType WorkspaceManifestEntryType, wantMode fs.FileMode) {
	t.Helper()
	if entry.Type != wantType || entry.Mode != wantMode {
		t.Fatalf("manifest entry = %#v, want type %q and mode %s", entry, wantType, wantMode)
	}
}

func mustLstat(t *testing.T, path string) fs.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	return info
}

func writeManifestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create parent for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
