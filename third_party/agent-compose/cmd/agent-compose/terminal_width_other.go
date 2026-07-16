//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly && !solaris && !aix

package main

import "os"

func terminalFileWidth(_ *os.File) int {
	return 0
}
