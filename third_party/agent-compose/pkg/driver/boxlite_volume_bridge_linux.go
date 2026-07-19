package driver

import "golang.org/x/sys/unix"

func boxliteVolumeBridgeIsMountPoint(path string) bool {
	mounts, err := boxliteVolumeBridgeMountPoints(path)
	return err == nil && len(mounts) > 0
}

func mountBoxliteVolumeBridgeSource(sourcePath string, targetPath string, readOnly bool) error {
	if boxliteVolumeBridgeIsMountPoint(targetPath) {
		if err := unmountBoxliteVolumeBridgeMount(targetPath); err != nil {
			return err
		}
	}
	if err := unix.Mount(sourcePath, targetPath, "", unix.MS_BIND, ""); err != nil {
		return err
	}
	if readOnly {
		if err := unix.Mount(sourcePath, targetPath, "", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY, ""); err != nil {
			return err
		}
	}
	return nil
}

func unmountBoxliteVolumeBridgeMount(targetPath string) error {
	err := unix.Unmount(targetPath, unix.MNT_DETACH)
	if err == unix.EINVAL {
		return nil
	}
	return err
}
