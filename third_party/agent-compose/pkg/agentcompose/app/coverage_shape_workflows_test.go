package app

import "testing"

func TestIntegrationAppSetupWorkflow(t *testing.T) {
	TestSetupRegistersServiceGraph(t)
}

func TestE2EAppSetupWorkflow(t *testing.T) {
	TestIntegrationAppSetupWorkflow(t)
}
