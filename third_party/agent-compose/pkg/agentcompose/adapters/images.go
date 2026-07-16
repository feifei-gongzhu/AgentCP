package adapters

import (
	"fmt"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	appconfig "agent-compose/pkg/config"
	"agent-compose/pkg/imagecache"
	"agent-compose/pkg/images"
	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type ImageBackends struct {
	Docker images.Backend
	OCI    images.Backend
	Auto   images.Backend
}

func NewImageBackends(config *appconfig.Config) (*ImageBackends, error) {
	imageCacheRoot := strings.TrimSpace(config.ImageCacheRoot)
	if imageCacheRoot == "" {
		imageCacheRoot = filepath.Join(config.DataRoot, "images")
		config.ImageCacheRoot = imageCacheRoot
	}
	dockerImages := images.NewDockerBackend()
	ociCache, err := imagecache.New(imagecache.Config{
		Root:               imageCacheRoot,
		DefaultRegistry:    config.ImageRegistry,
		InsecureRegistries: config.ImageInsecureRegistries,
	})
	if err != nil {
		return nil, err
	}
	config.ImageCacheRoot = ociCache.Root()
	ociImages := images.NewOCIBackend(ociCache)
	return &ImageBackends{
		Docker: dockerImages,
		OCI:    ociImages,
		Auto:   images.NewAutoBackend(config.ImageStoreMode, dockerImages, ociImages),
	}, nil
}

func (b *ImageBackends) BackendForStore(store agentcomposev2.ImageStoreKind) (images.Backend, error) {
	switch store {
	case agentcomposev2.ImageStoreKind_IMAGE_STORE_KIND_UNSPECIFIED:
		if b != nil && b.Auto != nil {
			return b.Auto, nil
		}
		if b == nil || b.Docker == nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("image backend is required"))
		}
		return b.Docker, nil
	case agentcomposev2.ImageStoreKind_IMAGE_STORE_KIND_DOCKER_DAEMON:
		if b == nil || b.Docker == nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("image backend is required"))
		}
		return b.Docker, nil
	case agentcomposev2.ImageStoreKind_IMAGE_STORE_KIND_OCI_CACHE:
		if b == nil || b.OCI == nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("OCI image backend is required"))
		}
		return b.OCI, nil
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported image store %s", store.String()))
	}
}

func (b *ImageBackends) ImageBackendForStore(store agentcomposev2.ImageStoreKind) (images.Backend, error) {
	return b.BackendForStore(store)
}
