//go:build !unix

package main

import (
	"context"
	"fmt"

	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

func terminalFileDescriptor(any) (int, bool) {
	return 0, false
}

func isTerminalFD(int) bool {
	return false
}

func makeTerminalRaw(int) (func() error, error) {
	return nil, fmt.Errorf("raw terminal mode is not supported on this platform")
}

func terminalSizeForFD(int) *agentcomposev2.AttachTerminalSize {
	return nil
}

func startExecAttachResizePump(context.Context, int, func(*agentcomposev2.ExecAttachRequest) error) func() {
	return func() {}
}

func startRunAttachResizePump(context.Context, int, func(*agentcomposev2.RunAttachRequest) error) func() {
	return func() {}
}
