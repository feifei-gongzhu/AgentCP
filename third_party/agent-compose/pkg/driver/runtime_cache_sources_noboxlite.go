//go:build !linux || !cgo || !boxlitecgo

package driver

import (
	"agent-compose/pkg/cache"
	appconfig "agent-compose/pkg/config"
)

func appendBoxliteRuntimeCacheSource(sources []cache.Source, _ *appconfig.Config) []cache.Source {
	return sources
}
