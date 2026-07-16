package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsRuntimeLLMFacadeRequestDelegatesToProxy(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses", nil)
	if !IsRuntimeLLMFacadeRequest(req) {
		t.Fatalf("IsRuntimeLLMFacadeRequest returned false for runtime facade route")
	}
	if IsRuntimeLLMFacadeRequest(httptest.NewRequest(http.MethodGet, "/api/runtime/sandboxes/sandbox-1/llm/openai/v1/responses", nil)) {
		t.Fatalf("IsRuntimeLLMFacadeRequest returned true for GET")
	}
}
