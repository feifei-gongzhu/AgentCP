package app

import (
	"net/http"

	"agent-compose/pkg/agentcompose/proxy"
)

func IsRuntimeLLMFacadeRequest(r *http.Request) bool {
	return proxy.IsRuntimeLLMFacadeRequest(r)
}
