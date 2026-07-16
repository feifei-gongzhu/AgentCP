package driver

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
)

// ErrRuntimeDriverNotCompiled identifies a runtime driver that the product
// recognizes but the current binary was not built to support.
var ErrRuntimeDriverNotCompiled = errors.New("runtime driver not compiled")

// RuntimeDriverNotCompiledError describes a runtime driver missing from the
// current binary's build capabilities.
type RuntimeDriverNotCompiledError struct {
	Driver          string
	GOOS            string
	GOARCH          string
	CompiledDrivers []string
}

func (e *RuntimeDriverNotCompiledError) Error() string {
	compiledDrivers := strings.Join(e.CompiledDrivers, ", ")
	if compiledDrivers == "" {
		compiledDrivers = "none"
	}
	return fmt.Sprintf(
		"runtime driver %q is not compiled into the %s/%s build (build capability; compiled drivers: %s)",
		e.Driver,
		e.GOOS,
		e.GOARCH,
		compiledDrivers,
	)
}

func (e *RuntimeDriverNotCompiledError) Unwrap() error {
	return ErrRuntimeDriverNotCompiled
}

func newRuntimeDriverNotCompiledError(driver string, compiledDrivers []string) error {
	return &RuntimeDriverNotCompiledError{
		Driver:          resolveRuntimeDriver(driver),
		GOOS:            runtime.GOOS,
		GOARCH:          runtime.GOARCH,
		CompiledDrivers: append([]string(nil), compiledDrivers...),
	}
}
