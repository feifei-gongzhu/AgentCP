//go:build !linux

package driver

import "fmt"

func mountBoxliteVolumeBridgeSource(_, _ string, _ bool) error {
	return fmt.Errorf("boxlite volume bridge requires Linux bind mounts")
}

func unmountBoxliteVolumeBridgeMount(string) error {
	return nil
}
