package driver

import (
	"errors"
	"reflect"
	"testing"
)

func TestCompiledRuntimeDriversStableOrder(t *testing.T) {
	want := []string{RuntimeDriverDocker}
	if boxliteCompiled {
		want = append(want, RuntimeDriverBoxlite)
	}
	if microsandboxCompiled {
		want = append(want, RuntimeDriverMicrosandbox)
	}

	if got := CompiledRuntimeDrivers(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CompiledRuntimeDrivers() = %v, want %v", got, want)
	}
}

func TestCompiledRuntimeDriversReturnsCopy(t *testing.T) {
	drivers := CompiledRuntimeDrivers()
	if len(drivers) == 0 {
		t.Fatal("CompiledRuntimeDrivers() returned no drivers; Docker must always be compiled")
	}
	drivers[0] = "modified"

	want := []string{RuntimeDriverDocker}
	if boxliteCompiled {
		want = append(want, RuntimeDriverBoxlite)
	}
	if microsandboxCompiled {
		want = append(want, RuntimeDriverMicrosandbox)
	}
	if got := CompiledRuntimeDrivers(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CompiledRuntimeDrivers() after caller mutation = %v, want %v", got, want)
	}
}

func TestIsRuntimeDriverCompiledNormalizesNames(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "default", value: "", want: true},
		{name: "docker", value: " DOCKER ", want: true},
		{name: "docker alias", value: "docker-engine", want: true},
		{name: "boxlite", value: " BOXLITE ", want: boxliteCompiled},
		{name: "microsandbox alias", value: " MSB ", want: microsandboxCompiled},
		{name: "unsupported", value: "unknown", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRuntimeDriverCompiled(tc.value); got != tc.want {
				t.Fatalf("IsRuntimeDriverCompiled(%q) = %t, want %t", tc.value, got, tc.want)
			}
		})
	}
}

func TestValidateCompiledRuntimeDriver(t *testing.T) {
	for _, value := range []string{"", RuntimeDriverDocker, "docker-engine"} {
		if err := ValidateCompiledRuntimeDriver(value); err != nil {
			t.Errorf("ValidateCompiledRuntimeDriver(%q) returned error: %v", value, err)
		}
	}

	invalid := "unknown-runtime"
	wantInvalid := ValidateRuntimeDriver(invalid)
	gotInvalid := ValidateCompiledRuntimeDriver(invalid)
	if gotInvalid == nil || gotInvalid.Error() != wantInvalid.Error() {
		t.Fatalf("ValidateCompiledRuntimeDriver(%q) = %v, want original name validation error %v", invalid, gotInvalid, wantInvalid)
	}
	if errors.Is(gotInvalid, ErrRuntimeDriverNotCompiled) {
		t.Fatalf("ValidateCompiledRuntimeDriver(%q) classified an invalid name as not compiled", invalid)
	}

	tests := []struct {
		name     string
		value    string
		compiled bool
	}{
		{name: "boxlite", value: RuntimeDriverBoxlite, compiled: boxliteCompiled},
		{name: "microsandbox alias", value: "MSB", compiled: microsandboxCompiled},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateCompiledRuntimeDriver(tc.value)
			if tc.compiled && err != nil {
				t.Fatalf("ValidateCompiledRuntimeDriver(%q) returned error: %v", tc.value, err)
			}
			if !tc.compiled && !errors.Is(err, ErrRuntimeDriverNotCompiled) {
				t.Fatalf("ValidateCompiledRuntimeDriver(%q) error = %v, want ErrRuntimeDriverNotCompiled", tc.value, err)
			}
		})
	}
}
