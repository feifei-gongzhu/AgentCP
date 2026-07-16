package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"agent-compose/pkg/execution"
	"agent-compose/pkg/loaders"
	domain "agent-compose/pkg/model"
)

type LoaderHostEvents struct {
	Controller *loaders.Controller
}

func (e LoaderHostEvents) Add(ctx context.Context, loaderID, runID, triggerID, eventType, level, message string, payload any, linkedSandboxID, linkedCellID, linkedAgentThreadID string) error {
	if e.Controller == nil {
		return fmt.Errorf("loader controller is unavailable")
	}
	return e.Controller.AddLoaderEvent(ctx, loaderID, runID, triggerID, eventType, level, message, payload, linkedSandboxID, linkedCellID, linkedAgentThreadID)
}

func (e LoaderHostEvents) AddRecord(ctx context.Context, loaderID, runID, triggerID, eventType, level, message string, payload any, linkedSandboxID, linkedCellID, linkedAgentThreadID string) (domain.LoaderEvent, error) {
	if e.Controller == nil {
		return domain.LoaderEvent{}, fmt.Errorf("loader controller is unavailable")
	}
	return e.Controller.AddLoaderEventRecord(ctx, loaderID, runID, triggerID, eventType, level, message, payload, linkedSandboxID, linkedCellID, linkedAgentThreadID)
}

type LoaderHostAgentExecutor struct {
	Executor *AgentExecutor
}

func (e LoaderHostAgentExecutor) ExecuteAgent(ctx context.Context, session *domain.Sandbox, request loaders.HostAgentExecutionRequest) (domain.NotebookCell, error) {
	if e.Executor == nil {
		return domain.NotebookCell{}, fmt.Errorf("agent executor is unavailable")
	}
	cell, _, _, err := e.Executor.ExecuteAgentRequest(ctx, session, execution.ExecuteAgentRequest{
		Agent:             request.Provider,
		AgentDefinitionID: request.AgentDefinitionID,
		Model:             request.Model,
		RunID:             request.RunID,
		Message:           request.Prompt,
		Timeout:           request.Timeout,
		OutputSchemaJSON:  request.OutputSchemaJSON,
	})
	return cell, err
}

type LoaderHostCommandExecutor struct {
	Executor *LoaderCommandExecutor
}

func (e LoaderHostCommandExecutor) ExecuteLoaderCommand(ctx context.Context, session *domain.Sandbox, request domain.LoaderCommandRequest) (domain.LoaderCommandResult, error) {
	if e.Executor == nil {
		return domain.LoaderCommandResult{}, fmt.Errorf("loader command executor is unavailable")
	}
	return e.Executor.ExecuteLoaderCommand(ctx, session, request)
}

type LoaderHostLLMRunner struct {
	Client *LLMClient
}

func (r LoaderHostLLMRunner) Generate(ctx context.Context, prompt, model, outputSchema string) (domain.LoaderLLMResult, error) {
	if r.Client == nil {
		return domain.LoaderLLMResult{}, fmt.Errorf("llm client is unavailable")
	}
	result, err := r.Client.Generate(ctx, prompt, model, outputSchema)
	if err != nil {
		return domain.LoaderLLMResult{}, err
	}
	return domain.LoaderLLMResult{
		Text:         result.Text,
		Model:        result.Model,
		ResponseID:   result.ResponseID,
		FinishReason: result.FinishReason,
	}, nil
}

func LoaderSandboxRPCLinkedSandboxID(method, requestJSON, responseJSON string) string {
	if value := loaderSandboxIDFromJSON(responseJSON); value != "" {
		return value
	}
	if strings.TrimSpace(method) == "ListSessions" {
		return ""
	}
	return loaderSandboxIDFromJSON(requestJSON)
}

func loaderSandboxIDFromJSON(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ""
	}
	if value, ok := payload["sessionId"].(string); ok {
		return strings.TrimSpace(value)
	}
	sessionValue, ok := payload["session"].(map[string]any)
	if !ok {
		return ""
	}
	summaryValue, ok := sessionValue["summary"].(map[string]any)
	if !ok {
		return ""
	}
	if value, ok := summaryValue["sessionId"].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}
