package driver

var compiledRuntimeDrivers = buildCompiledRuntimeDrivers()

func buildCompiledRuntimeDrivers() []string {
	drivers := []string{RuntimeDriverDocker}
	if boxliteCompiled {
		drivers = append(drivers, RuntimeDriverBoxlite)
	}
	if microsandboxCompiled {
		drivers = append(drivers, RuntimeDriverMicrosandbox)
	}
	return drivers
}

// CompiledRuntimeDrivers returns the runtime drivers included in this binary.
// The result is ordered and may be modified by the caller.
func CompiledRuntimeDrivers() []string {
	return append([]string(nil), compiledRuntimeDrivers...)
}

// IsRuntimeDriverCompiled reports whether the normalized runtime driver is
// included in this binary.
func IsRuntimeDriverCompiled(value string) bool {
	driver := ResolveRuntimeDriver(value)
	for _, compiledDriver := range compiledRuntimeDrivers {
		if driver == compiledDriver {
			return true
		}
	}
	return false
}

// ValidateCompiledRuntimeDriver validates both the runtime driver name and
// whether support for that driver is included in this binary.
func ValidateCompiledRuntimeDriver(value string) error {
	if err := ValidateRuntimeDriver(value); err != nil {
		return err
	}

	driver := ResolveRuntimeDriver(value)
	if !IsRuntimeDriverCompiled(driver) {
		return newRuntimeDriverNotCompiledError(driver, CompiledRuntimeDrivers())
	}
	return nil
}
