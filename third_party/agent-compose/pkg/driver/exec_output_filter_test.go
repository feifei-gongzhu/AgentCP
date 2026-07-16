package driver

import (
	"reflect"
	"testing"
)

func TestExecOutputFilterDropsKnownSeccompWarning(t *testing.T) {
	testExecOutputFilterWorkflows(t)
}

func testExecOutputFilterWorkflows(t *testing.T) {
	t.Helper()
	seccompWarning := "\x1b[2m2026-05-05T15:49:43.862984Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mlibcontainer::process::init::process\x1b[0m\x1b[2m:\x1b[0m seccomp not available, unable to set seccomp privileges!\n"
	filter := newExecOutputFilter()
	chunks := collectFilteredChunks(filter,
		ExecChunk{Text: seccompWarning, Stream: StdioStderr},
		ExecChunk{Text: "ok\n"},
	)

	want := []ExecChunk{{Text: "ok\n"}}
	if !reflect.DeepEqual(chunks, want) {
		t.Fatalf("unexpected chunks: got %#v want %#v", chunks, want)
	}

	filter = newExecOutputFilter()
	chunks = collectFilteredChunks(filter, ExecChunk{Text: seccompWarning})
	want = []ExecChunk{{Text: seccompWarning}}
	if !reflect.DeepEqual(chunks, want) {
		t.Fatalf("stdout warning text should not be filtered: got %#v want %#v", chunks, want)
	}

	filter = newExecOutputFilter()
	chunks = collectFilteredChunks(filter,
		ExecChunk{Text: "\x1b[2m2026-05-05T15:49:43.862984Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mlibcontainer::process::init::process", Stream: StdioStderr},
		ExecChunk{Text: "\x1b[0m\x1b[2m:\x1b[0m seccomp not available, unable to set seccomp privileges!\n", Stream: StdioStderr},
		ExecChunk{Text: "done\n"},
	)

	want = []ExecChunk{{Text: "done\n"}}
	if !reflect.DeepEqual(chunks, want) {
		t.Fatalf("unexpected chunks: got %#v want %#v", chunks, want)
	}

	filter = newExecOutputFilter()
	chunks = collectFilteredChunks(filter,
		ExecChunk{Text: "real error", Stream: StdioStderr},
		ExecChunk{Text: "stdout\n"},
	)

	want = []ExecChunk{
		{Text: "real error", Stream: StdioStderr},
		{Text: "stdout\n"},
	}
	if !reflect.DeepEqual(chunks, want) {
		t.Fatalf("unexpected chunks: got %#v want %#v", chunks, want)
	}

	filter = newExecOutputFilter()
	chunks = collectFilteredChunks(filter,
		ExecChunk{Text: "2026-05-05T15:49:43Z WARN libcontainer::process::init::process: seccomp not available, unable to set seccomp privileges!\n", Stream: StdioStderr},
		ExecChunk{Text: "boom\n", Stream: StdioStderr},
	)

	want = []ExecChunk{{Text: "boom\n", Stream: StdioStderr}}
	if !reflect.DeepEqual(chunks, want) {
		t.Fatalf("unexpected chunks: got %#v want %#v", chunks, want)
	}
}

func TestExecOutputFilterHandlesSplitWarning(t *testing.T) {
	testExecOutputFilterWorkflows(t)
}

func TestExecOutputFilterPreservesRealStderr(t *testing.T) {
	testExecOutputFilterWorkflows(t)
}

func TestExecOutputFilterKeepsStderrAfterWarning(t *testing.T) {
	testExecOutputFilterWorkflows(t)
}

func collectFilteredChunks(filter *execOutputFilter, input ...ExecChunk) []ExecChunk {
	var output []ExecChunk
	emit := func(chunk ExecChunk) {
		output = append(output, chunk)
	}
	for _, chunk := range input {
		filter.Write(chunk, emit)
	}
	filter.Finish(emit)
	return output
}
