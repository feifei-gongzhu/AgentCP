//go:build linux && cgo && microsandboxcgo

package driver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "agent-compose/pkg/config"
	"agent-compose/pkg/identity"

	microsandbox "github.com/superradcompany/microsandbox/sdk/go"
)

func TestMicrosandboxExecCollectorMapsStdioStreams(t *testing.T) {
	var streamed []ExecChunk
	collector := &microsandboxExecCollector{stream: func(chunk ExecChunk) {
		streamed = append(streamed, chunk)
	}}
	collector.writeChunk(ExecChunk{Text: "out"})
	collector.writeChunk(ExecChunk{Text: "err", Stream: StdioStderr})

	if collector.stdout.String() != "out" {
		t.Fatalf("stdout = %q", collector.stdout.String())
	}
	if collector.stderr.String() != "err" {
		t.Fatalf("stderr = %q", collector.stderr.String())
	}
	if collector.output.String() != "outerr" {
		t.Fatalf("output = %q", collector.output.String())
	}
	want := []ExecChunk{{Text: "out"}, {Text: "err", Stream: StdioStderr}}
	if len(streamed) != len(want) {
		t.Fatalf("streamed chunks = %#v", streamed)
	}
	for i := range want {
		if streamed[i] != want[i] {
			t.Fatalf("streamed[%d] = %#v, want %#v", i, streamed[i], want[i])
		}
	}
}

func TestMicrosandboxExecStreamReturnsAfterExitWithoutDone(t *testing.T) {
	events := []*microsandbox.ExecEvent{
		{Kind: microsandbox.ExecEventStarted},
		{Kind: microsandbox.ExecEventStdout, Data: []byte("finished\n")},
		{Kind: microsandbox.ExecEventExited, ExitCode: 7},
	}
	var closeCalls int
	recv := func(ctx context.Context) (*microsandbox.ExecEvent, error) {
		if len(events) > 0 {
			event := events[0]
			events = events[1:]
			return event, nil
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	closeHandle := func() error {
		closeCalls++
		return nil
	}
	collector := &microsandboxExecCollector{filter: newExecOutputFilter()}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	grace := 25 * time.Millisecond
	startedAt := time.Now()

	result, err := consumeMicrosandboxExecStream(ctx, recv, closeHandle, collector, grace)
	if err != nil {
		t.Fatalf("consumeMicrosandboxExecStream returned error: %v", err)
	}
	if result.ExitCode != 7 || result.Success {
		t.Fatalf("result = %#v, want exit code 7 and failure", result)
	}
	if result.Output != "finished\n" {
		t.Fatalf("output = %q, want %q", result.Output, "finished\n")
	}
	if closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", closeCalls)
	}
	if elapsed := time.Since(startedAt); elapsed < grace {
		t.Fatalf("returned before drain grace period: %s", elapsed)
	}
}

func TestMicrosandboxResolveLibkrunfwPrefersVersionedRealFile(t *testing.T) {
	libDir := t.TempDir()
	versioned := filepath.Join(libDir, "libkrunfw.so.5.5.0")
	if err := os.WriteFile(versioned, []byte("krun"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("libkrunfw.so.5.5.0", filepath.Join(libDir, "libkrunfw.so.5")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("libkrunfw.so.5", filepath.Join(libDir, "libkrunfw.so")); err != nil {
		t.Fatal(err)
	}

	runtime := &microsandboxRuntime{config: &appconfig.Config{
		MicrosandboxLibPath: filepath.Join(libDir, "libmicrosandbox_go_ffi.so"),
	}}
	got, err := runtime.resolveLibkrunfwPath()
	if err != nil {
		t.Fatalf("resolveLibkrunfwPath: %v", err)
	}
	if got != versioned {
		t.Fatalf("resolveLibkrunfwPath() = %q, want %q", got, versioned)
	}
}

func TestMicrosandboxResolveLibkrunfwUsesNumericVersionOrder(t *testing.T) {
	libDir := t.TempDir()
	for _, name := range []string{
		"libkrunfw.so.5.2.1",
		"libkrunfw.so.5.10.0",
		"libkrunfw.so.5.99.0.bak",
	} {
		if err := os.WriteFile(filepath.Join(libDir, name), []byte("krun"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runtime := &microsandboxRuntime{config: &appconfig.Config{
		MicrosandboxLibPath: filepath.Join(libDir, "libmicrosandbox_go_ffi.so"),
	}}
	want := filepath.Join(libDir, "libkrunfw.so.5.10.0")
	got, err := runtime.resolveLibkrunfwPath()
	if err != nil {
		t.Fatalf("resolveLibkrunfwPath: %v", err)
	}
	if got != want {
		t.Fatalf("resolveLibkrunfwPath() = %q, want %q", got, want)
	}
}

func TestMicrosandboxResolveLibkrunfwHandlesGlobMetaInDirectory(t *testing.T) {
	root := t.TempDir()
	libDir := filepath.Join(root, "lib[meta]")
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		t.Fatal(err)
	}
	versioned := filepath.Join(libDir, "libkrunfw.so.5.6.0")
	if err := os.WriteFile(versioned, []byte("krun"), 0o644); err != nil {
		t.Fatal(err)
	}

	runtime := &microsandboxRuntime{config: &appconfig.Config{
		MicrosandboxLibPath: filepath.Join(libDir, "libmicrosandbox_go_ffi.so"),
	}}
	got, err := runtime.resolveLibkrunfwPath()
	if err != nil {
		t.Fatalf("resolveLibkrunfwPath: %v", err)
	}
	if got != versioned {
		t.Fatalf("resolveLibkrunfwPath() = %q, want %q", got, versioned)
	}
}

func TestMicrosandboxPrepareEnvironmentPreservesDockerDisks(t *testing.T) {
	config := testMicrosandboxConfig(t)
	runtime := &microsandboxRuntime{config: config}
	disk := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", "old-session.raw")
	ignored := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", "note.txt")
	subdir := filepath.Join(config.MicrosandboxHome, "docker-disks", "nested")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatalf("mkdir docker-disks subdir: %v", err)
	}

	if err := runtime.prepareEnvironment(); err != nil {
		t.Fatalf("prepareEnvironment: %v", err)
	}
	for _, path := range []string{disk, ignored, subdir} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("path %s missing after prepareEnvironment: %v", path, err)
		}
	}
}

func TestMicrosandboxRemoveDockerDiskOnlyCurrentSession(t *testing.T) {
	config := testMicrosandboxConfig(t)
	runtime := &microsandboxRuntime{config: config}
	currentID := identity.Prefix + identity.NewRandomID(identity.ResourceSandbox)
	otherID := identity.NewRandomID(identity.ResourceSandbox)
	current := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", microsandboxDockerDiskName(currentID)+".raw")
	legacyCurrent := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", currentID+".raw")
	other := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", microsandboxDockerDiskName(otherID)+".raw")

	runtime.removeDockerDisk(currentID)

	if _, err := os.Stat(current); !os.IsNotExist(err) {
		t.Fatalf("current disk exists after removeDockerDisk, err=%v", err)
	}
	if _, err := os.Stat(legacyCurrent); !os.IsNotExist(err) {
		t.Fatalf("legacy current disk exists after removeDockerDisk, err=%v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("other disk missing after removeDockerDisk: %v", err)
	}
}

func TestMicrosandboxEnsureDockerDiskMigratesLegacyPath(t *testing.T) {
	config := testMicrosandboxConfig(t)
	runtime := &microsandboxRuntime{config: config}
	sandboxID := identity.Prefix + identity.NewRandomID(identity.ResourceSandbox)
	legacy := writeMicrosandboxFile(t, config.MicrosandboxHome, "docker-disks", sandboxID+".raw")

	got, err := runtime.ensureDockerDisk(sandboxID)
	if err != nil {
		t.Fatalf("ensureDockerDisk: %v", err)
	}
	want := runtime.dockerDiskPath(sandboxID)
	if got != want {
		t.Fatalf("ensureDockerDisk path = %q, want %q", got, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("migrated docker disk missing: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy docker disk still exists after migration, err=%v", err)
	}
}

func TestMicrosandboxDockerDiskPathUsesIdentityHash(t *testing.T) {
	config := testMicrosandboxConfig(t)
	runtime := &microsandboxRuntime{config: config}
	sandboxID := identity.NewRandomID(identity.ResourceSandbox)
	hash, err := identity.Hash(sandboxID)
	if err != nil {
		t.Fatalf("hash sandbox id: %v", err)
	}

	got := runtime.dockerDiskPath(sandboxID)
	want := filepath.Join(config.MicrosandboxHome, "docker-disks", hash+".raw")
	if got != want {
		t.Fatalf("dockerDiskPath = %q, want %q", got, want)
	}
	if strings.ContainsAny(filepath.Base(got), ",:;") {
		t.Fatalf("docker disk basename = %q, want no runtime-forbidden characters", filepath.Base(got))
	}
}

func TestMicrosandboxBindMountSetsConfiguredQuota(t *testing.T) {
	runtime := &microsandboxRuntime{config: &appconfig.Config{MicrosandboxBindQuotaGB: 60}}

	mount := runtime.microsandboxBindMount("/host/session", false)

	if mount.QuotaMiB != 60*1024 {
		t.Fatalf("QuotaMiB = %d, want %d", mount.QuotaMiB, 60*1024)
	}
	if mount.Readonly {
		t.Fatalf("Readonly = true, want false")
	}
}

func TestMicrosandboxBindMountPreservesReadonly(t *testing.T) {
	runtime := &microsandboxRuntime{config: &appconfig.Config{MicrosandboxBindQuotaGB: 11}}

	mount := runtime.microsandboxBindMount("/host/session", true)

	if mount.QuotaMiB != 11*1024 {
		t.Fatalf("QuotaMiB = %d, want %d", mount.QuotaMiB, 11*1024)
	}
	if !mount.Readonly {
		t.Fatalf("Readonly = false, want true")
	}
}

func TestMicrosandboxBindMountFallsBackToBoxDiskSize(t *testing.T) {
	runtime := &microsandboxRuntime{config: &appconfig.Config{BoxDiskSizeGB: 42}}

	mount := runtime.microsandboxBindMount("/host/session", false)

	if mount.QuotaMiB != 42*1024 {
		t.Fatalf("QuotaMiB = %d, want %d", mount.QuotaMiB, 42*1024)
	}
}

func testMicrosandboxConfig(t *testing.T) *appconfig.Config {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	t.Setenv("HOME", filepath.Join(root, "user-home"))
	bin := writeMicrosandboxFile(t, root, "bin", "msb")
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatalf("chmod msb: %v", err)
	}
	lib := writeMicrosandboxFile(t, root, "lib", "libmicrosandbox_go_ffi.so")
	_ = writeMicrosandboxFile(t, root, "lib", "libkrunfw.so.5.2.1")
	return &appconfig.Config{
		MicrosandboxHome:    home,
		MicrosandboxMSBPath: bin,
		MicrosandboxLibPath: lib,
		BoxDiskSizeGB:       1,
	}
}

func writeMicrosandboxFile(t *testing.T, root string, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{root}, parts...)...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir parent for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}
