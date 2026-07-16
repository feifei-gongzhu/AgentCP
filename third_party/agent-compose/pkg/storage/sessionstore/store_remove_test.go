package sessionstore

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "agent-compose/pkg/config"
)

func TestRemoveSessionDeletesSessionDirectory(t *testing.T) {
	store := newRemoveSessionTestStore(t)
	sessionID := "session-remove"
	sandboxDir := store.SandboxDir(sessionID)
	if err := os.MkdirAll(filepath.Join(sandboxDir, "state"), 0o755); err != nil {
		t.Fatalf("create sandbox dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sandboxDir, "state", "events.json"), []byte("[]\n"), 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
	unlock := store.lockSandbox(sessionID)
	unlock()
	if _, ok := store.sandboxLocks.Load(sessionID); !ok {
		t.Fatalf("session lock was not initialized")
	}

	if err := store.RemoveSandbox(context.Background(), sessionID); err != nil {
		t.Fatalf("RemoveSession returned error: %v", err)
	}
	if _, err := os.Stat(sandboxDir); !os.IsNotExist(err) {
		t.Fatalf("sandbox dir stat err = %v, want not exist", err)
	}
	if _, ok := store.sandboxLocks.Load(sessionID); ok {
		t.Fatalf("session lock was not removed")
	}
}

func TestRemoveSessionRejectsUnsafeIDs(t *testing.T) {
	store := newRemoveSessionTestStore(t)
	outside := filepath.Join(filepath.Dir(store.config.SandboxRoot), "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatalf("create outside dir: %v", err)
	}

	for _, id := range []string{"", " ", ".", "..", "../outside", "nested/session"} {
		err := store.RemoveSandbox(context.Background(), id)
		if err == nil {
			t.Fatalf("RemoveSandbox(%q) returned nil error", id)
		}
		if !strings.Contains(err.Error(), "sandbox id") {
			t.Fatalf("RemoveSandbox(%q) error = %v, want sandbox id validation", id, err)
		}
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("outside dir stat err = %v, want preserved", err)
	}
}

func TestRemoveSessionMissingDirectoryReturnsError(t *testing.T) {
	store := newRemoveSessionTestStore(t)
	sessionID := "missing-session"
	err := store.RemoveSandbox(context.Background(), sessionID)
	if err == nil {
		t.Fatal("RemoveSession missing session returned nil error")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("RemoveSession missing error = %v, want not exist", err)
	}
	if _, ok := store.sandboxLocks.Load(sessionID); ok {
		t.Fatalf("missing session created a lock entry")
	}
}

func newRemoveSessionTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := NewWithConfig(&appconfig.Config{SandboxRoot: filepath.Join(t.TempDir(), "sandboxes")})
	if err != nil {
		t.Fatalf("NewWithConfig returned error: %v", err)
	}
	return store
}
