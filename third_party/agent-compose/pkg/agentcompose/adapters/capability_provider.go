package adapters

import (
	"agent-compose/pkg/capabilities"
)

func NewCapabilityProvider(source capabilities.GatewaySource, proxyTarget string) capabilities.Provider {
	return capabilities.NewDynamicProvider(source, proxyTarget)
}
