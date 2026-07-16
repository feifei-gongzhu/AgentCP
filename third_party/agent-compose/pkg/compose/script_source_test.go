package compose

import (
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultScriptSourceResolverReadsFilesAndFileURLs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "scheduler script.js")
	if err := os.WriteFile(path, []byte("scheduler.interval('x', 1000, main);"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "scheduler-link.js")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	resolver := NewDefaultScriptSourceResolver()
	for _, location := range []string{path, (&url.URL{Scheme: "file", Path: link}).String()} {
		data, err := resolver.Resolve(context.Background(), location)
		if err != nil || !strings.Contains(string(data), "scheduler.interval") {
			t.Fatalf("Resolve(%q) data=%q err=%v", location, data, err)
		}
	}
	if _, err := resolver.Resolve(context.Background(), dir); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("directory Resolve error = %v", err)
	}
}

func TestDefaultScriptSourceResolverHTTPFailures(t *testing.T) {
	t.Run("status and query redaction", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		}))
		defer server.Close()
		_, err := NewDefaultScriptSourceResolver().Resolve(context.Background(), server.URL+"/scheduler.js?token=super-secret")
		if err == nil || !strings.Contains(err.Error(), "status 502") || strings.Contains(err.Error(), "super-secret") {
			t.Fatalf("Resolve error = %v", err)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		}))
		defer server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		_, err := NewDefaultScriptSourceResolver().Resolve(ctx, server.URL)
		if err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
			t.Fatalf("Resolve timeout error = %v", err)
		}
	})

	t.Run("redirect limit", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var n int
			_, _ = fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/"), "%d", &n)
			http.Redirect(w, r, fmt.Sprintf("/%d", n+1), http.StatusFound)
		}))
		defer server.Close()
		_, err := NewDefaultScriptSourceResolver().Resolve(context.Background(), server.URL+"/0")
		if err == nil || !strings.Contains(err.Error(), "too many redirects") {
			t.Fatalf("Resolve redirects error = %v", err)
		}
	})

	t.Run("unsupported redirect", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "file:///tmp/scheduler.js", http.StatusFound)
		}))
		defer server.Close()
		_, err := NewDefaultScriptSourceResolver().Resolve(context.Background(), server.URL)
		if err == nil || !strings.Contains(err.Error(), "not supported") {
			t.Fatalf("Resolve redirect error = %v", err)
		}
	})
}

func TestNormalizeResolvesUppercaseHTTPScriptURLScheme(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("scheduler.timeout('once', 1000, main);"))
	}))
	defer server.Close()

	location := "HTTP" + strings.TrimPrefix(server.URL, "http")
	spec := mustParseCompose(t, fmt.Sprintf(`
name: uppercase-http-script
agents:
  reviewer:
    scheduler:
      script:
        url: %s
`, location))
	normalized, err := Normalize(spec, NormalizeOptions{ResolveScriptURLs: true})
	if err != nil {
		t.Fatalf("Normalize returned error: %v", err)
	}
	if got := normalized.Agents[0].Scheduler.Script; got != "scheduler.timeout('once', 1000, main);" {
		t.Fatalf("scheduler script = %q", got)
	}
}

func TestDefaultScriptSourceResolverLimitsDecodedHTTPContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		_, _ = writer.Write([]byte(strings.Repeat("x", maxScriptSourceBytes+1)))
		_ = writer.Close()
	}))
	defer server.Close()
	_, err := NewDefaultScriptSourceResolver().Resolve(context.Background(), server.URL)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("Resolve oversized content error = %v", err)
	}
}

func TestDefaultScriptSourceResolverRejectsHTTPSDowngrade(t *testing.T) {
	resolver := NewDefaultScriptSourceResolver().(*defaultScriptSourceResolver)
	httpsRequest := httptest.NewRequest(http.MethodGet, "https://example.test/source", nil)
	httpRequest := httptest.NewRequest(http.MethodGet, "http://example.test/target", nil)
	err := resolver.client.CheckRedirect(httpRequest, []*http.Request{httpsRequest})
	if err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("CheckRedirect error = %v", err)
	}
}
