package adapters

import (
	"context"
	"fmt"
	"net/http"
	"time"

	appconfig "agent-compose/pkg/config"
	"agent-compose/pkg/llms"
	"agent-compose/pkg/storage/configstore"
)

type LLMClient struct {
	config *appconfig.Config
	store  *configstore.ConfigStore
	client *http.Client
}

func NewLLMClient(config *appconfig.Config, store *configstore.ConfigStore) *LLMClient {
	var timeout time.Duration
	if config != nil {
		timeout = config.LLMTimeout
	}
	return &LLMClient{
		config: config,
		store:  store,
		client: &http.Client{Timeout: timeout},
	}
}

func (c *LLMClient) Generate(ctx context.Context, prompt, model, outputSchemaJSON string) (llms.GenerateResult, error) {
	if c == nil {
		return llms.GenerateResult{}, fmt.Errorf("llm client is unavailable")
	}
	target, err := llms.ResolveLLMTarget(ctx, c.config, c.store, model)
	if err != nil {
		return llms.GenerateResult{}, err
	}
	return llms.Generate(ctx, c.client, llms.GenerateRequest{
		Endpoint:         target.Endpoint,
		Protocol:         target.WireAPI,
		Prompt:           prompt,
		Model:            firstNonEmpty(model, target.Model.Name, target.Model.ID),
		OutputSchemaJSON: outputSchemaJSON,
		Headers:          target.Headers,
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
