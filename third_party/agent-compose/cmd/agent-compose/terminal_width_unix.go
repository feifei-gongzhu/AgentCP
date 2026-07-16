//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly || solaris || aix

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func terminalFileWidth(file *os.File) int {
	size, err := unix.IoctlGetWinsize(int(file.Fd()), unix.TIOCGWINSZ)
	if err != nil || size == nil || size.Col == 0 {
		return 0
	}
	return int(size.Col)
}
