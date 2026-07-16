package llms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateResponsesAndChatCompletionsWorkflows(t *testing.T) {
	t.Run("responses success with schema and forwarded headers", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Test") != "forwarded" || r.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("headers = %#v", r.Header)
			}
			var req apiRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if req.Model != "gpt" || req.Input != "hello" || req.Text == nil || req.Text.Format.Type != "json_schema" {
				t.Fatalf("request = %#v", req)
			}
			_, _ = w.Write([]byte(`{"id":"resp-1","model":"gpt-4.1","output":[{"finish_reason":"stop","content":[{"text":" first "},{"text":"second"}]}]}`))
		}))
		defer server.Close()
		result, err := Generate(context.Background(), server.Client(), GenerateRequest{
			Endpoint:         server.URL,
			Protocol:         APIProtocolResponses,
			Prompt:           " hello ",
			Model:            "gpt",
			OutputSchemaJSON: `{"type":"object"}`,
			Headers:          http.Header{"X-Test": []string{"forwarded"}},
		})
		if err != nil {
			t.Fatalf("Generate returned error: %v", err)
		}
		if result.Text != "first\nsecond" || result.Model != "gpt-4.1" || result.ResponseID != "resp-1" || result.FinishReason != "stop" {
			t.Fatalf("result = %#v", result)
		}
	})

	t.Run("responses errors", func(t *testing.T) {
		if _, err := Generate(context.Background(), nil, GenerateRequest{}); err == nil || !strings.Contains(err.Error(), "prompt") {
			t.Fatalf("expected prompt error, got %v", err)
		}
		if _, err := Generate(context.Background(), nil, GenerateRequest{Prompt: "x", Endpoint: "://bad", Model: "m"}); err == nil {
			t.Fatalf("expected request creation error")
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"message":"backend down"}}`))
		}))
		defer server.Close()
		if _, err := Generate(context.Background(), server.Client(), GenerateRequest{Endpoint: server.URL, Prompt: "x", Model: "m"}); err == nil || !strings.Contains(err.Error(), "backend down") {
			t.Fatalf("expected backend error, got %v", err)
		}
		if _, err := Generate(context.Background(), server.Client(), GenerateRequest{Endpoint: server.URL, Prompt: "x", Model: "m", OutputSchemaJSON: "{"}); err == nil {
			t.Fatalf("expected invalid schema error")
		}
	})

	t.Run("chat completions success and invalid json response", func(t *testing.T) {
		var calls int
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			var req chatCompletionsRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if req.ResponseFormat == nil || len(req.Messages) != 2 {
				t.Fatalf("request = %#v", req)
			}
			if calls == 1 {
				_, _ = w.Write([]byte(`{"id":"chat-1","choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"not json"}}]}`))
		}))
		defer server.Close()
		result, err := Generate(context.Background(), server.Client(), GenerateRequest{
			Endpoint: server.URL, Protocol: APIProtocolChatCompletions, Prompt: "hello", Model: "chat", OutputSchemaJSON: `{"type":"object"}`,
		})
		if err != nil {
			t.Fatalf("Generate chat returned error: %v", err)
		}
		if result.Text != `{"ok":true}` || result.ResponseID != "chat-1" || result.FinishReason != "stop" {
			t.Fatalf("chat result = %#v", result)
		}
		if _, err := Generate(context.Background(), server.Client(), GenerateRequest{
			Endpoint: server.URL, Protocol: APIProtocolChatCompletions, Prompt: "hello", Model: "chat", OutputSchemaJSON: `{"type":"object"}`,
		}); err == nil || !strings.Contains(err.Error(), "valid JSON") {
			t.Fatalf("expected invalid json response error, got %v", err)
		}
	})
}

func TestE2EGenerateResponsesAndChatCompletionsWorkflows(t *testing.T) {
	TestGenerateResponsesAndChatCompletionsWorkflows(t)
}
