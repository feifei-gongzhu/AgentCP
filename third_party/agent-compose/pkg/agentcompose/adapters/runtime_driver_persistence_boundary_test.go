package adapters

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	driverpkg "agent-compose/pkg/driver"
	domain "agent-compose/pkg/model"
)

func TestSandboxRPCBridgeRejectsUncompiledDriverBeforePersistence(t *testing.T) {
	ctx := context.Background()
	bridge, runtime := newTestSandboxRPCBridge(t)

	assertSandboxCount := func(want int) {
		t.Helper()
		result, err := bridge.store.ListSandboxes(ctx, domain.SandboxListOptions{Limit: 100})
		if err != nil {
			t.Fatalf("ListSandboxes returned error: %v", err)
		}
		if result.TotalCount != want || len(result.Sandboxes) != want {
			t.Fatalf("sandbox store count = %d/%d, want %d", result.TotalCount, len(result.Sandboxes), want)
		}
	}

	assertSandboxCount(0)
	for _, driver := range []string{driverpkg.RuntimeDriverBoxlite, driverpkg.RuntimeDriverMicrosandbox} {
		t.Run(driver, func(t *testing.T) {
			if driverpkg.IsRuntimeDriverCompiled(driver) {
				t.Skipf("runtime driver %s is compiled in this build", driver)
			}
			_, err := bridge.createSandbox(ctx, sandboxRPCCreateRequest{
				Title:  "must not persist",
				Driver: driver,
			}, domain.SandboxTypeManual)
			assertUncompiledDriverConnectError(t, err, driver)
			assertSandboxCount(0)
			if len(runtime.startCalls) != 0 {
				t.Fatalf("StartSandboxVM calls = %#v, want none", runtime.startCalls)
			}
		})
	}

	t.Run("invalid name remains invalid argument", func(t *testing.T) {
		_, err := bridge.createSandbox(ctx, sandboxRPCCreateRequest{Driver: "future-runtime"}, domain.SandboxTypeManual)
		if connect.CodeOf(err) != connect.CodeInvalidArgument || errors.Is(err, domain.ErrUnsupported) || errors.Is(err, driverpkg.ErrRuntimeDriverNotCompiled) {
			t.Fatalf("invalid driver error = %v, code=%v; want InvalidArgument only", err, connect.CodeOf(err))
		}
		assertSandboxCount(0)
	})
}

func assertUncompiledDriverConnectError(t *testing.T, err error, driver string) {
	t.Helper()
	if connect.CodeOf(err) != connect.CodeUnimplemented || !errors.Is(err, domain.ErrUnsupported) || !errors.Is(err, driverpkg.ErrRuntimeDriverNotCompiled) {
		t.Fatalf("driver %q error = %v, code=%v; want unimplemented unsupported/not-compiled", driver, err, connect.CodeOf(err))
	}
	var notCompiled *driverpkg.RuntimeDriverNotCompiledError
	if !errors.As(err, &notCompiled) || notCompiled.Driver != driver {
		t.Fatalf("driver %q typed error = %#v", driver, notCompiled)
	}
}
