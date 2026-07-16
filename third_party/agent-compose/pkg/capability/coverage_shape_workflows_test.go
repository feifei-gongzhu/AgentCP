package capability

import "testing"

func TestIntegrationCapabilityClientWorkflows(t *testing.T) {
	t.Run("status not configured", TestClientStatusNotConfigured)
	t.Run("inject token", TestClientInjectsToken)
	t.Run("list capsets", TestListCapsets)
	t.Run("catalog query", TestClientCatalogUsesAllQueryAndEscapesCapset)
	t.Run("normalize catalog", TestNormalizeCatalogMergesEndpoints)
	t.Run("duplicate grpc bindings", TestNormalizeCatalogAllowsDuplicateGRPCMethodBindings)
}

func TestE2ECapabilityClientWorkflows(t *testing.T) {
	TestIntegrationCapabilityClientWorkflows(t)
}
