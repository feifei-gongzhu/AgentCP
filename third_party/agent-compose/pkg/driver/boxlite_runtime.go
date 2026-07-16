package driver

import (
	appconfig "agent-compose/pkg/config"

	"github.com/samber/do/v2"
)

func NewSandboxRuntime(di do.Injector) (SandboxRuntime, error) {
	return newSandboxRuntime(do.MustInvoke[*appconfig.Config](di))
}

func NewBoxliteRuntime(config *appconfig.Config) (SandboxRuntime, error) {
	return newSandboxRuntime(config)
}

func NewDockerRuntime(config *appconfig.Config) (SandboxRuntime, error) {
	return newDockerRuntime(config)
}

func NewMicrosandboxRuntime(config *appconfig.Config) (SandboxRuntime, error) {
	return newMicrosandboxRuntime(config)
}
