package driver

import (
	"agent-compose/pkg/cache"
	appconfig "agent-compose/pkg/config"
)

func NewRuntimeCacheSources(config *appconfig.Config) []cache.Source {
	var sources []cache.Source
	sources = appendBoxliteRuntimeCacheSource(sources, config)
	sources = appendMicrosandboxRuntimeCacheSource(sources, config)
	return sources
}
