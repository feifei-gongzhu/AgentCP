//go:build !linux || !cgo || !microsandboxcgo

package driver

import (
	"agent-compose/pkg/cache"
	appconfig "agent-compose/pkg/config"
)

func appendMicrosandboxRuntimeCacheSource(sources []cache.Source, _ *appconfig.Config) []cache.Source {
	return sources
}
