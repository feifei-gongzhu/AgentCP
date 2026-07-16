package sessionstore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteFileReplacesExistingFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "metadata.json")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatalf("write old file: %v", err)
	}
	if err := writeFileAtomically(path, []byte("new\n"), 0o644); err != nil {
		t.Fatalf("writeFileAtomically returned error: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if got, want := string(data), "new\n"; got != want {
		t.Fatalf("replaced file = %q, want %q", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat replaced file: %v", err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o644); got != want {
		t.Fatalf("replaced file mode = %o, want %o", got, want)
	}
	assertNoAtomicWriteTemps(t, root)
}

func TestAtomicWriteFileRenameFailurePreservesDestinationAndCleansTemp(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "metadata.json")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatalf("create destination directory: %v", err)
	}
	sentinel := filepath.Join(path, "preserved")
	if err := os.WriteFile(sentinel, []byte("old\n"), 0o644); err != nil {
		t.Fatalf("write destination sentinel: %v", err)
	}
	if err := writeFileAtomically(path, []byte("new\n"), 0o644); err == nil {
		t.Fatal("writeFileAtomically rename error = nil, want non-nil")
	}
	data, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatalf("read preserved destination sentinel: %v", err)
	}
	if got, want := string(data), "old\n"; got != want {
		t.Fatalf("destination sentinel = %q, want %q", got, want)
	}
	assertNoAtomicWriteTemps(t, root)
}

func assertNoAtomicWriteTemps(t *testing.T, root string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(root, ".metadata.json.tmp-*"))
	if err != nil {
		t.Fatalf("glob atomic write temps: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("atomic write temporary files remain: %v", matches)
	}
}
