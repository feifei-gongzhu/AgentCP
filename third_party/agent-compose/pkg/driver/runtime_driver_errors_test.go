package driver

import (
	"errors"
	"fmt"
	"runtime"
	"testing"
)

func TestRuntimeDriverNotCompiledError(t *testing.T) {
	compiledDrivers := []string{RuntimeDriverDocker, RuntimeDriverMicrosandbox}
	err := newRuntimeDriverNotCompiledError(" MSB ", compiledDrivers)

	if !errors.Is(err, ErrRuntimeDriverNotCompiled) {
		t.Fatalf("errors.Is(%v, ErrRuntimeDriverNotCompiled) = false, want true", err)
	}
	if !errors.Is(fmt.Errorf("validate runtime driver: %w", err), ErrRuntimeDriverNotCompiled) {
		t.Fatalf("wrapped errors.Is(%v, ErrRuntimeDriverNotCompiled) = false, want true", err)
	}

	var notCompiled *RuntimeDriverNotCompiledError
	if !errors.As(err, &notCompiled) {
		t.Fatalf("errors.As(%T, *RuntimeDriverNotCompiledError) = false, want true", err)
	}
	if notCompiled.Driver != RuntimeDriverMicrosandbox {
		t.Errorf("Driver = %q, want %q", notCompiled.Driver, RuntimeDriverMicrosandbox)
	}
	if notCompiled.GOOS != runtime.GOOS {
		t.Errorf("GOOS = %q, want %q", notCompiled.GOOS, runtime.GOOS)
	}
	if notCompiled.GOARCH != runtime.GOARCH {
		t.Errorf("GOARCH = %q, want %q", notCompiled.GOARCH, runtime.GOARCH)
	}
	if got, want := fmt.Sprint(notCompiled.CompiledDrivers), fmt.Sprint(compiledDrivers); got != want {
		t.Errorf("CompiledDrivers = %s, want %s", got, want)
	}

	wantText := fmt.Sprintf(
		"runtime driver %q is not compiled into the %s/%s build (build capability; compiled drivers: %s, %s)",
		RuntimeDriverMicrosandbox,
		runtime.GOOS,
		runtime.GOARCH,
		RuntimeDriverDocker,
		RuntimeDriverMicrosandbox,
	)
	if err.Error() != wantText {
		t.Errorf("Error() = %q, want %q", err.Error(), wantText)
	}
}

func TestRuntimeDriverNotCompiledErrorCopiesCompiledDrivers(t *testing.T) {
	compiledDrivers := []string{RuntimeDriverDocker}
	err := newRuntimeDriverNotCompiledError(RuntimeDriverBoxlite, compiledDrivers)
	compiledDrivers[0] = RuntimeDriverBoxlite

	var notCompiled *RuntimeDriverNotCompiledError
	if !errors.As(err, &notCompiled) {
		t.Fatalf("errors.As(%T, *RuntimeDriverNotCompiledError) = false, want true", err)
	}
	if got, want := fmt.Sprint(notCompiled.CompiledDrivers), fmt.Sprint([]string{RuntimeDriverDocker}); got != want {
		t.Errorf("CompiledDrivers after source mutation = %s, want %s", got, want)
	}
}

func TestRuntimeDriverNotCompiledErrorWithoutCompiledDrivers(t *testing.T) {
	err := newRuntimeDriverNotCompiledError(RuntimeDriverBoxlite, nil)
	want := fmt.Sprintf(
		"runtime driver %q is not compiled into the %s/%s build (build capability; compiled drivers: none)",
		RuntimeDriverBoxlite,
		runtime.GOOS,
		runtime.GOARCH,
	)
	if err.Error() != want {
		t.Errorf("Error() = %q, want %q", err.Error(), want)
	}
}
