//go:build unix

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"
	"golang.org/x/term"

	agentcomposev2 "agent-compose/proto/agentcompose/v2"
)

type fdWriter interface {
	Fd() uintptr
}

func terminalFileDescriptor(value any) (int, bool) {
	file, ok := value.(fdWriter)
	if !ok {
		return 0, false
	}
	return int(file.Fd()), true
}

func isTerminalFD(fd int) bool {
	return term.IsTerminal(fd)
}

func makeTerminalRaw(fd int) (func() error, error) {
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, err
	}
	return func() error {
		return term.Restore(fd, state)
	}, nil
}

func terminalSizeForFD(fd int) *agentcomposev2.AttachTerminalSize {
	size, err := unix.IoctlGetWinsize(fd, unix.TIOCGWINSZ)
	if err != nil || size == nil || size.Row == 0 || size.Col == 0 {
		return nil
	}
	return &agentcomposev2.AttachTerminalSize{
		Rows: uint32(size.Row),
		Cols: uint32(size.Col),
	}
}

func startExecAttachResizePump(ctx context.Context, fd int, send func(*agentcomposev2.ExecAttachRequest) error) func() {
	ctx, cancel := context.WithCancel(ctx)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case <-signals:
				size := terminalSizeForFD(fd)
				if size == nil {
					continue
				}
				_ = send(&agentcomposev2.ExecAttachRequest{
					Frame: &agentcomposev2.ExecAttachRequest_Resize{Resize: &agentcomposev2.AttachResize{TerminalSize: size}},
				})
			}
		}
	}()
	return func() {
		cancel()
		signal.Stop(signals)
		<-done
	}
}

func startRunAttachResizePump(ctx context.Context, fd int, send func(*agentcomposev2.RunAttachRequest) error) func() {
	ctx, cancel := context.WithCancel(ctx)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case <-signals:
				size := terminalSizeForFD(fd)
				if size == nil {
					continue
				}
				_ = send(&agentcomposev2.RunAttachRequest{
					Frame: &agentcomposev2.RunAttachRequest_Resize{Resize: &agentcomposev2.AttachResize{TerminalSize: size}},
				})
			}
		}
	}()
	return func() {
		cancel()
		signal.Stop(signals)
		<-done
	}
}
