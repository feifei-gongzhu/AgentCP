package driver

import (
	appconfig "agent-compose/pkg/config"
	"reflect"
	"testing"
)

func TestRuntimeCacheSourcesMatchCompiledDrivers(t *testing.T) {
	wantTypes := make([]string, 0, 2)
	if IsRuntimeDriverCompiled(RuntimeDriverBoxlite) {
		wantTypes = append(wantTypes, "boxliteRuntimeCacheSource")
	}
	if IsRuntimeDriverCompiled(RuntimeDriverMicrosandbox) {
		wantTypes = append(wantTypes, "microsandboxRuntimeCacheSource")
	}

	sources := NewRuntimeCacheSources(&appconfig.Config{
		BoxliteHome:      "/tmp/boxlite",
		MicrosandboxHome: "/tmp/microsandbox",
	})
	gotTypes := make([]string, 0, len(sources))
	for _, source := range sources {
		gotTypes = append(gotTypes, reflect.TypeOf(source).Name())
	}

	if !reflect.DeepEqual(gotTypes, wantTypes) {
		t.Fatalf("NewRuntimeCacheSources() types = %v, want compiled-driver sources %v", gotTypes, wantTypes)
	}
}
