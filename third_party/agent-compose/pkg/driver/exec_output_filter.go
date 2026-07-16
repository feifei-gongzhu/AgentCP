package driver

import "strings"

const (
	maxInitialExecStderrBuffer = 1024

	ignoredSeccompUnavailableMessage         = "seccomp not available, unable to set seccomp privileges!"
	ignoredNoNewPrivilegesUnavailableMessage = "seccomp not available, unable to enforce no_new_privileges!"
)

type execOutputFilter struct {
	pendingStderr   strings.Builder
	filterStderrTop bool
}

func newExecOutputFilter() *execOutputFilter {
	return &execOutputFilter{filterStderrTop: true}
}

func (f *execOutputFilter) Write(chunk ExecChunk, emit func(ExecChunk)) {
	if emit == nil {
		return
	}
	if NormalizeStdioStream(chunk.Stream) != StdioStderr {
		f.flushPending(true, emit)
		emit(chunk)
		return
	}
	if !f.filterStderrTop {
		emit(chunk)
		return
	}
	_, _ = f.pendingStderr.WriteString(chunk.Text)
	f.flushPending(false, emit)
}

func (f *execOutputFilter) Finish(emit func(ExecChunk)) {
	if emit == nil {
		return
	}
	f.flushPending(true, emit)
}

func (f *execOutputFilter) flushPending(final bool, emit func(ExecChunk)) {
	pending := f.pendingStderr.String()
	if pending == "" {
		return
	}

	for {
		newlineIndex := strings.IndexByte(pending, '\n')
		if newlineIndex < 0 {
			break
		}
		line := pending[:newlineIndex+1]
		pending = pending[newlineIndex+1:]
		if isIgnoredExecStderrLine(line) {
			continue
		}
		emit(ExecChunk{Text: line, Stream: StdioStderr})
		f.filterStderrTop = false
		if pending != "" {
			emit(ExecChunk{Text: pending, Stream: StdioStderr})
			pending = ""
		}
		break
	}

	if pending != "" && (final || len(pending) >= maxInitialExecStderrBuffer) {
		if !isIgnoredExecStderrLine(pending) {
			emit(ExecChunk{Text: pending, Stream: StdioStderr})
		}
		f.filterStderrTop = false
		pending = ""
	}

	f.pendingStderr.Reset()
	_, _ = f.pendingStderr.WriteString(pending)
}

func isIgnoredExecStderrLine(line string) bool {
	if !strings.Contains(line, "libcontainer::process::init::process") {
		return false
	}
	return strings.Contains(line, ignoredSeccompUnavailableMessage) ||
		strings.Contains(line, ignoredNoNewPrivilegesUnavailableMessage)
}
