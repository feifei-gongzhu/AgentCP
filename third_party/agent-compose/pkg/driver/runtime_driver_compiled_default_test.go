//go:build !boxlitecgo && !microsandboxcgo

package driver

import "testing"

func TestDefaultRuntimeDriverCompiledConstraintFixture(t *testing.T) {
	if boxliteCompiled {
		t.Fatal("default build unexpectedly reports BoxLite as compiled")
	}
	if microsandboxCompiled {
		t.Fatal("default build unexpectedly reports Microsandbox as compiled")
	}
}
