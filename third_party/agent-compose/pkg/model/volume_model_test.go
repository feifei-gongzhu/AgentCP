package model

import (
	"strings"
	"testing"
)

func TestNormalizeVolumeMountSpecsAllowsSameSourceMultipleTargetsAndNestedReadOnly(t *testing.T) {
	items, err := NormalizeVolumeMountSpecs([]VolumeMountSpec{
		{Source: "cache", Target: "/mnt/cache-a"},
		{Source: "cache", Target: "/mnt/cache-b"},
		{Type: VolumeMountTypeVolume, Source: "nested-cache", Target: "/mnt/nested/parent/child", ReadOnly: true},
		{Type: VolumeMountTypeBind, Source: "./logs", Target: "/mnt/logs"},
	})
	if err != nil {
		t.Fatalf("NormalizeVolumeMountSpecs returned error: %v", err)
	}
	if len(items) != 4 {
		t.Fatalf("normalized item count = %d, want 4: %#v", len(items), items)
	}
	if items[0].Type != VolumeMountTypeVolume || items[1].Type != VolumeMountTypeVolume {
		t.Fatalf("default volume mount types = %#v", items[:2])
	}
	if items[2].Target != "/mnt/nested/parent/child" || !items[2].ReadOnly {
		t.Fatalf("nested read-only mount = %#v", items[2])
	}
	if items[3].Type != VolumeMountTypeBind || items[3].Source != "./logs" {
		t.Fatalf("bind mount = %#v", items[3])
	}
}

func TestNormalizeVolumeMountSpecsRejectsInvalidTargetsAndSources(t *testing.T) {
	tests := []struct {
		name string
		spec []VolumeMountSpec
		want string
	}{
		{
			name: "duplicate cleaned target",
			spec: []VolumeMountSpec{
				{Source: "cache-a", Target: "/mnt/cache"},
				{Source: "cache-b", Target: "/mnt/cache/."},
			},
			want: `duplicate volume mount target "/mnt/cache"`,
		},
		{
			name: "relative target",
			spec: []VolumeMountSpec{{Source: "cache", Target: "mnt/cache"}},
			want: `volume mount target "mnt/cache" must be absolute`,
		},
		{
			name: "empty named volume source",
			spec: []VolumeMountSpec{{Source: "", Target: "/mnt/cache"}},
			want: "volume mount source: volume name is required",
		},
		{
			name: "empty bind source",
			spec: []VolumeMountSpec{{Type: VolumeMountTypeBind, Source: "", Target: "/mnt/logs"}},
			want: "bind mount source is required",
		},
		{
			name: "unsupported type",
			spec: []VolumeMountSpec{{Type: "tmpfs", Source: "cache", Target: "/mnt/cache"}},
			want: `volume mount type "tmpfs" is not supported`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NormalizeVolumeMountSpecs(tt.spec)
			if err == nil {
				t.Fatal("NormalizeVolumeMountSpecs returned nil error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestNormalizeSessionVolumeMountsKeepsValidReadOnlyNestedMounts(t *testing.T) {
	items := NormalizeSandboxVolumeMounts([]SandboxVolumeMount{
		{ID: " mount-a ", Type: " VOLUME ", Source: " cache ", Target: "/mnt/nested/../cache", ReadOnly: true, HostPath: " /host/cache "},
		{Type: VolumeMountTypeVolume, Source: "missing-target", Target: "", HostPath: "/host/missing"},
		{Type: VolumeMountTypeVolume, Source: "missing-host", Target: "/mnt/missing"},
	})
	if len(items) != 1 {
		t.Fatalf("normalized session mounts = %#v, want one valid mount", items)
	}
	item := items[0]
	if item.ID != "mount-a" || item.Type != VolumeMountTypeVolume || item.Source != "cache" ||
		item.Target != "/mnt/cache" || !item.ReadOnly || item.HostPath != "/host/cache" {
		t.Fatalf("normalized session mount = %#v", item)
	}
}
