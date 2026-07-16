//go:build linux && cgo && boxlitecgo

package driver

import (
	"context"

	"agent-compose/pkg/cache"
	appconfig "agent-compose/pkg/config"
)

type boxliteRuntimeCacheSource struct {
	boxliteHome string
}

func appendBoxliteRuntimeCacheSource(sources []cache.Source, config *appconfig.Config) []cache.Source {
	if config == nil {
		return sources
	}
	return append(sources, boxliteRuntimeCacheSource{boxliteHome: config.BoxliteHome})
}

func (s boxliteRuntimeCacheSource) List(ctx context.Context) (cache.ListResult, error) {
	return listBoxliteRuntimeDerivedCaches(ctx, s.boxliteHome)
}

func (s boxliteRuntimeCacheSource) Remove(ctx context.Context, item cache.Item) error {
	return boxliteRuntimeDerivedRemover{boxliteHome: s.boxliteHome}.Remove(ctx, item)
}
