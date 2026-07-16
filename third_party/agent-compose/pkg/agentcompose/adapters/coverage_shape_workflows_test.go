package adapters

import "testing"

func TestIntegrationAdapterRuntimeWorkflows(t *testing.T) {
	t.Run("runtime provider configured capability", TestNewRuntimeProviderValidatesConfiguredDefaultCompiled)
	t.Run("runtime provider lazy construction", TestNewRuntimeProviderConstructionIsLazy)
	t.Run("runtime provider validation ordering", TestRuntimeProviderForDriverValidationOrdering)
	t.Run("historical runtime state", TestHistoricalUncompiledRuntimeOperationsPreserveState)
	t.Run("historical exec preflight", TestHistoricalUncompiledExecPreflightHasNoArtifactsOrRecords)
	t.Run("agent executor", TestAgentExecutorExecuteAgentRequestPersistsCellAndEvents)
	t.Run("agent executor stream failure", TestAgentExecutorPersistsFailedCellWhenStreamCallbackFails)
	t.Run("agent runner", TestAgentRunnerExecuteAgentRunWritesSystemPromptAndParsesResult)
	t.Run("agent runner mcp", TestAgentRunnerPrepareManagedMCPConfigForProviders)
	t.Run("cell executor", TestCellExecutorExecuteCellPersistsCellAndEvent)
	t.Run("sandbox driver", TestSandboxDriverStartSandboxVMSavesRuntimeState)
	t.Run("sandbox stop and remove lifecycle", TestSandboxDriverStopPreservesFacadeTokensUntilRemove)
	t.Run("sandbox resume reuses runtime", TestSandboxDriverResumeReusesRuntimeWithoutRefreshingStartupEnv)
	t.Run("sandbox rpc", TestSandboxRPCBridgeCallJSONSupportsSessionRPCs)
	t.Run("sandbox rpc unsupported history", TestSandboxRPCBridgeHistoricalUnsupportedRuntimeIsUnimplementedAndPreservesSummary)
	t.Run("sandbox rpc unsupported persistence boundary", TestSandboxRPCBridgeRejectsUncompiledDriverBeforePersistence)
	t.Run("capability guide lifecycle", TestSandboxRPCBridgeCapabilityGuideLifecycle)
	t.Run("capability guide best effort", TestSandboxRPCBridgeCapabilityGuideIsBestEffort)
	t.Run("runtime liveness", TestSandboxRuntimeLivenessAndNotifierBranches)
	t.Run("capability guide http", TestSandboxRPCBridgeCapabilityGuideFromHTTPProvider)
	t.Run("adapter helpers", TestAdapterHelperCoverage)
	t.Run("capability sandbox resolver", TestCapabilitySandboxResolverCoverage)
	t.Run("loader sticky unsupported history", TestLoaderSandboxRunnerRejectsUnsupportedStickyResumeBeforeSideEffects)
}

func TestE2EAdapterRuntimeWorkflows(t *testing.T) {
	TestIntegrationAdapterRuntimeWorkflows(t)
}
