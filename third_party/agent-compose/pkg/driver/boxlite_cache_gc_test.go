//go:build linux && cgo && boxlitecgo

package driver

import (
	"context"
	"database/sql"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-compose/pkg/cache"
	appconfig "agent-compose/pkg/config"

	_ "modernc.org/sqlite"
)

func TestBoxliteStartupPathsDoNotCallCacheCleanupHelpers(t *testing.T) {
	ensureCalls := boxliteMethodCalls(t, "EnsureSandbox")
	if containsString(ensureCalls, "cleanupLegacyBoxliteCaches") {
		t.Fatalf("EnsureSandbox calls cleanupLegacyBoxliteCaches: %#v", ensureCalls)
	}
	resolveCalls := boxliteMethodCalls(t, "resolveRootfsPath")
	if containsString(resolveCalls, "maybeRunCacheGC") {
		t.Fatalf("resolveRootfsPath calls maybeRunCacheGC: %#v", resolveCalls)
	}
}

func TestResolveRootfsPathDoesNotPruneMaterializedCache(t *testing.T) {
	dataRoot := t.TempDir()
	cacheDir := filepath.Join(dataRoot, "image-cache", "stale-image")
	for _, path := range []string{
		filepath.Join(cacheDir, "rootfs", "bin"),
		filepath.Join(cacheDir, "oci.tmp", "index.json"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir parent for %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	staleAt := time.Now().UTC().Add(-2 * time.Hour)
	for _, path := range []string{cacheDir, filepath.Join(cacheDir, "rootfs"), filepath.Join(cacheDir, "oci.tmp")} {
		if err := os.Chtimes(path, staleAt, staleAt); err != nil {
			t.Fatalf("chtimes %s: %v", path, err)
		}
	}
	runtime := &cgoSandboxRuntime{config: &appconfig.Config{
		DataRoot:      dataRoot,
		BoxRootfsPath: "/prebuilt/rootfs",
		CacheTTL:      time.Nanosecond,
	}}

	rootfsPath, err := runtime.resolveRootfsPath(context.Background(), "guest:latest", "", defaultImagePullTimeout)
	if err != nil {
		t.Fatalf("resolveRootfsPath: %v", err)
	}
	if rootfsPath != "/prebuilt/rootfs" {
		t.Fatalf("rootfsPath = %q, want /prebuilt/rootfs", rootfsPath)
	}
	for _, path := range []string{cacheDir, filepath.Join(cacheDir, "rootfs"), filepath.Join(cacheDir, "oci.tmp")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("materialized cache path %s missing after resolveRootfsPath: %v", path, err)
		}
	}
}

func TestHasActiveBoxliteBoxes(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "boxlite.db")
	db := createBoxliteStateDB(t, dbPath)
	insertBoxliteState(t, db, "stopped-box", "stopped")
	active, err := hasActiveBoxliteBoxes(dbPath)
	if err != nil {
		t.Fatalf("hasActiveBoxliteBoxes(stopped): %v", err)
	}
	if active {
		t.Fatalf("active = true, want false")
	}
	insertBoxliteState(t, db, "running-box", "running")
	active, err = hasActiveBoxliteBoxes(dbPath)
	if err != nil {
		t.Fatalf("hasActiveBoxliteBoxes(running): %v", err)
	}
	if !active {
		t.Fatalf("active = false, want true")
	}
}

func TestListBoxliteRuntimeDerivedCachesScansLegacyRoots(t *testing.T) {
	boxliteHome := t.TempDir()
	db := createBoxliteStateDB(t, filepath.Join(boxliteHome, boxliteDBFileName))
	insertBoxliteState(t, db, "stopped-box", "stopped")
	localPath := writeBoxliteCacheFile(t, boxliteHome, "images", "local", "legacy-a", "layer.txt")
	diskPath := writeBoxliteCacheFile(t, boxliteHome, "images", "disk-images", "legacy-b.ext4")

	result, err := listBoxliteRuntimeDerivedCaches(context.Background(), boxliteHome)
	if err != nil {
		t.Fatalf("listBoxliteRuntimeDerivedCaches: %v", err)
	}
	if len(result.Warnings) != 0 {
		t.Fatalf("warnings = %#v, want none", result.Warnings)
	}
	if len(result.Items) != 2 {
		t.Fatalf("item count = %d, want 2 (%#v)", len(result.Items), result.Items)
	}
	items := map[string]cache.Item{}
	for _, item := range result.Items {
		items[item.Kind] = item
		if item.Domain != cache.DomainRuntimeDerivedCache {
			t.Fatalf("domain = %q, want %q", item.Domain, cache.DomainRuntimeDerivedCache)
		}
		if item.Driver != cache.DriverBoxLite {
			t.Fatalf("driver = %q, want %q", item.Driver, cache.DriverBoxLite)
		}
		if item.Status != cache.StatusUnknown || item.Removable || len(item.Warnings) == 0 {
			t.Fatalf("item status/removable = %s/%v, want unknown/false (%#v)", item.Status, item.Removable, item)
		}
		if item.CacheID == "" {
			t.Fatalf("cache id is empty for item %#v", item)
		}
	}
	if got := items[boxliteLocalImageCacheKind].Path; got != filepath.Dir(localPath) {
		t.Fatalf("local item path = %q, want %q", got, filepath.Dir(localPath))
	}
	if got := items[boxliteDiskImageCacheKind].Path; got != diskPath {
		t.Fatalf("disk item path = %q, want %q", got, diskPath)
	}
}

func TestBoxliteRuntimeDerivedPruneActiveBlocksDeletion(t *testing.T) {
	boxliteHome := t.TempDir()
	db := createBoxliteStateDB(t, filepath.Join(boxliteHome, boxliteDBFileName))
	insertBoxliteState(t, db, "running-box", "running")
	target := filepath.Dir(writeBoxliteCacheFile(t, boxliteHome, "images", "local", "legacy-a", "layer.txt"))

	result, err := pruneBoxliteRuntimeDerivedCaches(context.Background(), boxliteHome, cache.PruneRequest{
		Filter: cache.Filter{
			Driver: cache.DriverBoxLite,
			Domain: cache.DomainRuntimeDerivedCache,
		},
		Force: true,
	})
	if err != nil {
		t.Fatalf("pruneBoxliteRuntimeDerivedCaches: %v", err)
	}
	if len(result.Removed) != 0 {
		t.Fatalf("removed = %#v, want none", result.Removed)
	}
	if len(result.Skipped) != 1 {
		t.Fatalf("skipped count = %d, want 1 (%#v)", len(result.Skipped), result.Skipped)
	}
	if item := result.Skipped[0]; item.Status != cache.StatusActive || item.Removable {
		t.Fatalf("skipped item status/removable = %s/%v, want active/false (%#v)", item.Status, item.Removable, item)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("target missing after active prune: %v", err)
	}
}

func TestBoxliteRuntimeDerivedRemoveIsInventoryOnly(t *testing.T) {
	boxliteHome := t.TempDir()
	db := createBoxliteStateDB(t, filepath.Join(boxliteHome, boxliteDBFileName))
	insertBoxliteState(t, db, "stopped-box", "stopped")
	target := filepath.Dir(writeBoxliteCacheFile(t, boxliteHome, "images", "local", "legacy-a", "layer.txt"))
	sibling := filepath.Dir(writeBoxliteCacheFile(t, boxliteHome, "images", "local", "legacy-b", "layer.txt"))
	disk := writeBoxliteCacheFile(t, boxliteHome, "images", "disk-images", "legacy-c.ext4")
	list, err := listBoxliteRuntimeDerivedCaches(context.Background(), boxliteHome)
	if err != nil {
		t.Fatalf("listBoxliteRuntimeDerivedCaches: %v", err)
	}
	var cacheID string
	for _, item := range list.Items {
		if item.Path == target {
			cacheID = item.CacheID
			break
		}
	}
	if cacheID == "" {
		t.Fatalf("target cache id not found in %#v", list.Items)
	}

	dryRun, err := removeBoxliteRuntimeDerivedCache(context.Background(), boxliteHome, cache.RemoveRequest{CacheID: cacheID})
	if err != nil {
		t.Fatalf("removeBoxliteRuntimeDerivedCache dry-run: %v", err)
	}
	if !dryRun.DryRun || len(dryRun.Removed) != 0 {
		t.Fatalf("dry-run result = %#v, want dry run with no removals", dryRun)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("target missing after dry-run: %v", err)
	}

	forced, err := removeBoxliteRuntimeDerivedCache(context.Background(), boxliteHome, cache.RemoveRequest{CacheID: cacheID, Force: true})
	if err != nil {
		t.Fatalf("removeBoxliteRuntimeDerivedCache force: %v", err)
	}
	if forced.DryRun || len(forced.Removed) != 0 || len(forced.Skipped) != 1 {
		t.Fatalf("force result = %#v, want protected inventory item", forced)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("target missing after force remove, err=%v", err)
	}
	for _, path := range []string{sibling, disk} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("sibling path %s missing after targeted remove: %v", path, err)
		}
	}
}

func TestBoxliteRuntimeDerivedRemoveRejectsSymlinkEscape(t *testing.T) {
	boxliteHome := t.TempDir()
	db := createBoxliteStateDB(t, filepath.Join(boxliteHome, boxliteDBFileName))
	insertBoxliteState(t, db, "stopped-box", "stopped")
	outside := filepath.Join(t.TempDir(), "outside-cache")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatalf("mkdir outside target: %v", err)
	}
	root := filepath.Join(boxliteHome, "images", "local")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir local root: %v", err)
	}
	linkPath := filepath.Join(root, "escape")
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Fatalf("symlink escape target: %v", err)
	}
	list, err := listBoxliteRuntimeDerivedCaches(context.Background(), boxliteHome)
	if err != nil {
		t.Fatalf("listBoxliteRuntimeDerivedCaches: %v", err)
	}
	var cacheID string
	for _, item := range list.Items {
		if item.Path == linkPath {
			cacheID = item.CacheID
			break
		}
	}
	if cacheID == "" {
		t.Fatalf("symlink cache id not found in %#v", list.Items)
	}

	result, err := removeBoxliteRuntimeDerivedCache(context.Background(), boxliteHome, cache.RemoveRequest{CacheID: cacheID, Force: true})
	if err != nil {
		t.Fatalf("removeBoxliteRuntimeDerivedCache symlink escape: %v", err)
	}
	if len(result.Removed) != 0 {
		t.Fatalf("removed = %#v, want none", result.Removed)
	}
	if len(result.Skipped) != 1 || len(result.Skipped[0].Warnings) == 0 {
		t.Fatalf("result = %#v, want skipped item with warning", result)
	}
	if _, err := os.Lstat(linkPath); err != nil {
		t.Fatalf("symlink was removed: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("outside target was removed: %v", err)
	}
}

func TestBoxliteRuntimeDerivedUnknownDBAndSchemaAreNotRemovable(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, boxliteHome string)
	}{
		{
			name:  "missing-db",
			setup: func(t *testing.T, boxliteHome string) {},
		},
		{
			name: "missing-table",
			setup: func(t *testing.T, boxliteHome string) {
				dbPath := filepath.Join(boxliteHome, boxliteDBFileName)
				db, err := sql.Open("sqlite", dbPath)
				if err != nil {
					t.Fatalf("open sqlite db: %v", err)
				}
				t.Cleanup(func() { _ = db.Close() })
				if _, err := db.Exec(`CREATE TABLE other_state (id TEXT PRIMARY KEY NOT NULL);`); err != nil {
					t.Fatalf("create unrelated table: %v", err)
				}
			},
		},
		{
			name: "missing-status-column",
			setup: func(t *testing.T, boxliteHome string) {
				dbPath := filepath.Join(boxliteHome, boxliteDBFileName)
				db, err := sql.Open("sqlite", dbPath)
				if err != nil {
					t.Fatalf("open sqlite db: %v", err)
				}
				t.Cleanup(func() { _ = db.Close() })
				if _, err := db.Exec(`CREATE TABLE box_state (id TEXT PRIMARY KEY NOT NULL);`); err != nil {
					t.Fatalf("create box_state without status: %v", err)
				}
			},
		},
		{
			name: "corrupt-db",
			setup: func(t *testing.T, boxliteHome string) {
				if err := os.WriteFile(filepath.Join(boxliteHome, boxliteDBFileName), []byte("not sqlite"), 0o644); err != nil {
					t.Fatalf("write corrupt db: %v", err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			boxliteHome := t.TempDir()
			tc.setup(t, boxliteHome)
			target := filepath.Dir(writeBoxliteCacheFile(t, boxliteHome, "images", "local", "legacy-a", "layer.txt"))

			result, err := pruneBoxliteRuntimeDerivedCaches(context.Background(), boxliteHome, cache.PruneRequest{
				Filter: cache.Filter{
					Driver: cache.DriverBoxLite,
					Domain: cache.DomainRuntimeDerivedCache,
				},
				Force: true,
			})
			if err != nil {
				t.Fatalf("pruneBoxliteRuntimeDerivedCaches: %v", err)
			}
			if len(result.Removed) != 0 {
				t.Fatalf("removed = %#v, want none", result.Removed)
			}
			if len(result.Skipped) != 1 {
				t.Fatalf("skipped count = %d, want 1 (%#v)", len(result.Skipped), result.Skipped)
			}
			if item := result.Skipped[0]; item.Status != cache.StatusUnknown || item.Removable {
				t.Fatalf("skipped item status/removable = %s/%v, want unknown/false (%#v)", item.Status, item.Removable, item)
			}
			if len(result.Warnings) == 0 {
				t.Fatalf("warnings empty, want unknown state warning")
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatalf("target missing after unknown prune: %v", err)
			}
		})
	}
}

func createBoxliteStateDB(t *testing.T, dbPath string) *sql.DB {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("mkdir db parent: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE box_state (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, pid INTEGER, json TEXT NOT NULL);`); err != nil {
		t.Fatalf("create box_state: %v", err)
	}
	return db
}

func insertBoxliteState(t *testing.T, db *sql.DB, id, status string) {
	t.Helper()
	pid := "NULL"
	if strings.TrimSpace(status) == "running" {
		pid = "123"
	}
	if _, err := db.Exec(`INSERT INTO box_state(id, status, pid, json) VALUES(?, ?, `+pid+`, '{}');`, id, status); err != nil {
		t.Fatalf("insert boxlite state %s/%s: %v", id, status, err)
	}
}

func writeBoxliteCacheFile(t *testing.T, boxliteHome string, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{boxliteHome}, parts...)...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir parent for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func boxliteMethodCalls(t *testing.T, methodName string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "boxlite_cgo.go", nil, 0)
	if err != nil {
		t.Fatalf("parse boxlite_cgo.go: %v", err)
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || fn.Name.Name != methodName {
			continue
		}
		var calls []string
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch fun := call.Fun.(type) {
			case *ast.Ident:
				calls = append(calls, fun.Name)
			case *ast.SelectorExpr:
				calls = append(calls, fun.Sel.Name)
			}
			return true
		})
		return calls
	}
	t.Fatalf("method %s not found in boxlite_cgo.go", methodName)
	return nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
