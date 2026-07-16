//go:build !linux && !darwin

package main

import (
	"fmt"
	"net"
	"runtime"
)

// unixSocketPeerUID is unsupported on this platform; callers treat the error
// as "peer unknown" and fall back to requiring normal authentication.
func unixSocketPeerUID(_ *net.UnixConn) (int, error) {
	return 0, fmt.Errorf("unix socket peer credentials not supported on %s", runtime.GOOS)
}
