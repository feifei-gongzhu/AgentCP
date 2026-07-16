package execution

import "testing"

func TestIntegrationExecutionHelperWorkflows(t *testing.T) {
	TestDriverConversionWorkflows(t)
	TestWriteAgentMCPConfigFile(t)
}

func TestE2EExecutionHelperWorkflows(t *testing.T) {
	TestIntegrationExecutionHelperWorkflows(t)
}
