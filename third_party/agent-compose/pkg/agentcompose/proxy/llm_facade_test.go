package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsRuntimeLLMFacadeRequestMatchesOnlyRegisteredPOSTRoutes(t *testing.T) {
	valid := []string{
		"/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses",
		"/api/runtime/sandboxes/sandbox-1/llm/openai/v1/chat/completions",
		"/api/runtime/sandboxes/sandbox-1/llm/anthropic/v1/messages",
		"/api/runtime/sessions/session-1/llm/openai/v1/responses",
		"/api/runtime/sessions/session-1/llm/openai/v1/chat/completions",
		"/api/runtime/sessions/session-1/llm/anthropic/v1/messages",
	}
	for _, path := range valid {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		if !IsRuntimeLLMFacadeRequest(req) {
			t.Fatalf("IsRuntimeLLMFacadeRequest(%q) = false, want true", path)
		}
	}

	invalid := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses"},
		{http.MethodPost, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses/extra"},
		{http.MethodPost, "/api/runtime/sandboxes/sandbox-1/not-llm/openai/v1/responses"},
		{http.MethodPost, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/unknown"},
		{http.MethodPost, "/api/runtime/sandboxes/sandbox-1/llm/anthropic/v1/messages/extra"},
		{http.MethodPost, "/api/other/sandbox-1/llm/openai/v1/responses"},
	}
	for _, tc := range invalid {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if IsRuntimeLLMFacadeRequest(req) {
			t.Fatalf("IsRuntimeLLMFacadeRequest(%s %q) = true, want false", tc.method, tc.path)
		}
	}
}
