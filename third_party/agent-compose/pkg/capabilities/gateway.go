package capabilities

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"agent-compose/pkg/capproxy"
	domain "agent-compose/pkg/model"
)

const (
	ProxyTargetEnvName  = "CAP_GRPC_TARGET"
	SandboxTokenEnvName = "CAP_TOKEN"
	CapsetTagName       = "capset"
)

func NormalizeCapsetIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func EncodeCapsetIDs(ids []string) (string, error) {
	normalized := NormalizeCapsetIDs(ids)
	if normalized == nil {
		normalized = []string{}
	}
	data, err := json.Marshal(normalized)
	if err != nil {
		return "", fmt.Errorf("encode capset ids: %w", err)
	}
	return string(data), nil
}

func DecodeCapsetIDs(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil
	}
	return NormalizeCapsetIDs(ids)
}

func BuildGatewaySandboxVars(publicTarget string, capsetIDs []string) ([]domain.SandboxEnvVar, []domain.SandboxTag) {
	ids := NormalizeCapsetIDs(capsetIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	publicTarget = strings.TrimSpace(publicTarget)
	if publicTarget == "" {
		slog.Warn("capability injection skipped: CAP_GRPC_TARGET not configured", "capsets", ids)
		return nil, nil
	}
	env := []domain.SandboxEnvVar{
		{Name: ProxyTargetEnvName, Value: publicTarget},
		{Name: SandboxTokenEnvName, Value: uuid.NewString(), Secret: true},
	}
	tags := make([]domain.SandboxTag, 0, len(ids))
	for _, id := range ids {
		tags = append(tags, domain.SandboxTag{Name: CapsetTagName, Value: id})
	}
	return env, tags
}

func GuidePreamble(target string) string {
	target = strings.TrimSpace(target)
	if target == "" {
		return ""
	}
	return fmt.Sprintf(`# Capability Gateway Access

Capabilities are reachable over gRPC through the local capability proxy. To call
any method in the catalog below:

- Endpoint: %s (plaintext HTTP/2 gRPC; also in env CAP_GRPC_TARGET)
- On every call, send metadata `+"`%s: $CAP_TOKEN`"+` (token value is in env CAP_TOKEN)
- Also send the per-method `+"`x-octobus-capset` / `x-octobus-instance`"+`
  metadata shown in the table below
- Schemas can be discovered via gRPC server reflection using the same
  `+"`x-octobus-capset`"+` metadata

`, target, capproxy.SandboxTokenMetadata)
}

func SandboxRuntimeDir(sandbox *domain.Sandbox) string {
	if sandbox == nil {
		return ""
	}
	workspace := strings.TrimSpace(sandbox.Summary.WorkspacePath)
	if workspace == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(workspace), "runtime")
}

func SandboxGuidePath(sandbox *domain.Sandbox) string {
	dir := SandboxRuntimeDir(sandbox)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "mpi", "catalog.md")
}

func SandboxToken(sandbox *domain.Sandbox) string {
	return sandboxEnvValue(sandbox, SandboxTokenEnvName)
}

func SandboxCapsets(sandbox *domain.Sandbox) []string {
	if sandbox == nil {
		return nil
	}
	var ids []string
	for _, tag := range sandbox.Summary.Tags {
		if tag.Name == CapsetTagName {
			if v := strings.TrimSpace(tag.Value); v != "" {
				ids = append(ids, v)
			}
		}
	}
	return NormalizeCapsetIDs(ids)
}

func sandboxEnvValue(sandbox *domain.Sandbox, name string) string {
	if sandbox == nil {
		return ""
	}
	for _, item := range sandbox.EnvItems {
		if item.Name == name {
			return strings.TrimSpace(item.Value)
		}
	}
	return ""
}
