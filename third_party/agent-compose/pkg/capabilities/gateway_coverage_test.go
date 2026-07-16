package capabilities

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"agent-compose/pkg/capability"
	"agent-compose/pkg/capproxy"
	domain "agent-compose/pkg/model"
)

func TestCapabilityGatewayCoverage(t *testing.T) {
	testCapabilityGatewayCoverage(t)
}

func TestIntegrationCapabilityGatewayCoverage(t *testing.T) {
	testCapabilityGatewayCoverage(t)
}

func TestE2ECapabilityGatewayCoverage(t *testing.T) {
	testCapabilityGatewayCoverage(t)
}

func testCapabilityGatewayCoverage(t *testing.T) {
	t.Helper()

	ids := NormalizeCapsetIDs([]string{" dev ", "", "ops", "dev"})
	if strings.Join(ids, ",") != "dev,ops" {
		t.Fatalf("NormalizeCapsetIDs = %#v", ids)
	}
	encoded, err := EncodeCapsetIDs([]string{"dev", "dev", "ops"})
	if err != nil || encoded != `["dev","ops"]` {
		t.Fatalf("EncodeCapsetIDs = %q/%v", encoded, err)
	}
	if decoded := DecodeCapsetIDs(`[" dev ","ops","dev"]`); strings.Join(decoded, ",") != "dev,ops" {
		t.Fatalf("DecodeCapsetIDs = %#v", decoded)
	}
	if DecodeCapsetIDs("{bad") != nil || DecodeCapsetIDs("null") != nil {
		t.Fatalf("DecodeCapsetIDs accepted invalid or null input")
	}

	env, tags := BuildGatewaySandboxVars(" 127.0.0.1:9000 ", []string{"dev", "", "ops", "dev"})
	if len(env) != 2 || env[0].Name != ProxyTargetEnvName || env[0].Value != "127.0.0.1:9000" || env[1].Name != SandboxTokenEnvName || !env[1].Secret {
		t.Fatalf("gateway env = %#v", env)
	}
	if len(tags) != 2 || tags[0].Value != "dev" || tags[1].Value != "ops" {
		t.Fatalf("gateway tags = %#v", tags)
	}
	if emptyEnv, emptyTags := BuildGatewaySandboxVars("", []string{"dev"}); emptyEnv != nil || emptyTags != nil {
		t.Fatalf("BuildGatewaySandboxVars without target = %#v/%#v", emptyEnv, emptyTags)
	}
	if GuidePreamble("") != "" || !strings.Contains(GuidePreamble("127.0.0.1:9000"), capproxy.SandboxTokenMetadata) {
		t.Fatalf("GuidePreamble did not include expected metadata")
	}

	sandbox := &domain.Sandbox{
		Summary: domain.SandboxSummary{
			ID:            "sandbox-1",
			WorkspacePath: filepath.Join(t.TempDir(), "workspace"),
			Tags:          append(tags, domain.SandboxTag{Name: CapsetTagName, Value: " dev "}),
		},
		EnvItems: env,
	}
	if runtimeDir := SandboxRuntimeDir(sandbox); runtimeDir != filepath.Join(filepath.Dir(sandbox.Summary.WorkspacePath), "runtime") {
		t.Fatalf("SandboxRuntimeDir = %q", runtimeDir)
	}
	if guidePath := SandboxGuidePath(sandbox); !strings.HasSuffix(guidePath, filepath.Join("runtime", "mpi", "catalog.md")) {
		t.Fatalf("SandboxGuidePath = %q", guidePath)
	}
	if SandboxToken(sandbox) == "" || SandboxToken(nil) != "" {
		t.Fatalf("SandboxToken returned unexpected values")
	}
	if capsets := SandboxCapsets(sandbox); strings.Join(capsets, ",") != "dev,ops" {
		t.Fatalf("SandboxCapsets = %#v", capsets)
	}
	if SandboxRuntimeDir(nil) != "" || SandboxGuidePath(&domain.Sandbox{}) != "" {
		t.Fatalf("empty sandbox paths returned non-empty values")
	}
}

func TestDynamicProviderNotConfiguredCoverage(t *testing.T) {
	ctx := context.Background()
	if ProxyTarget(nil) != "" {
		t.Fatalf("ProxyTarget(nil) returned non-empty")
	}
	provider := NewDynamicProvider(fakeGatewaySource{}, " proxy.internal:9000 ")
	if ProxyTarget(provider) != "proxy.internal:9000" || provider.ProxyTarget() != "proxy.internal:9000" {
		t.Fatalf("proxy target = %q/%q", ProxyTarget(provider), provider.ProxyTarget())
	}
	status := provider.Status(ctx)
	if status != (capability.Status{Configured: false, OK: false, Status: "not_configured"}) {
		t.Fatalf("Status = %#v", status)
	}
	if capsets, err := provider.ListCapsets(ctx); err != nil || len(capsets) != 0 {
		t.Fatalf("ListCapsets = %#v/%v", capsets, err)
	}
	if _, err := provider.Catalog(ctx, "dev"); !errors.Is(err, capability.ErrNotConfigured) {
		t.Fatalf("Catalog error = %v", err)
	}
	if _, err := provider.CapabilityGuide(ctx, "dev"); !errors.Is(err, capability.ErrNotConfigured) {
		t.Fatalf("CapabilityGuide error = %v", err)
	}
	if (*DynamicProvider)(nil).ProxyTarget() != "" {
		t.Fatalf("nil provider ProxyTarget returned non-empty")
	}

	failing := NewDynamicProvider(fakeGatewaySource{err: errors.New("db unavailable")}, "target")
	if status := failing.Status(ctx); status.Status != "not_configured" {
		t.Fatalf("failing Status = %#v", status)
	}
}

type fakeGatewaySource struct {
	settings domain.CapabilityGatewaySettings
	err      error
}

func (s fakeGatewaySource) GetCapabilityGateway(context.Context) (domain.CapabilityGatewaySettings, error) {
	return s.settings, s.err
}
