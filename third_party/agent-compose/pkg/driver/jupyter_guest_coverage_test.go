package driver

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "agent-compose/pkg/config"
)

func testJupyterGuestCoverageWorkflow(t *testing.T) {
	t.Helper()

	if kernelspecPayloadReady([]byte(`{"kernelspecs":{"python3":{}}}`)) != true ||
		kernelspecPayloadReady([]byte(`{"kernelspecs":{}}`)) != false {
		t.Fatalf("kernelspecPayloadReady returned unexpected values")
	}

	proxyState := ProxyState{Enabled: true, HostPort: 7410, GuestPort: 8888, ProxyPath: "agent-compose/session/session-1/lab/", Token: "token value"}
	if got := jupyterBaseURL(proxyState); got != "/agent-compose/session/session-1/" {
		t.Fatalf("jupyterBaseURL = %q", got)
	}
	if direct := jupyterDirectURL(proxyState); !strings.Contains(direct, "127.0.0.1:7410") || !strings.Contains(direct, "token=token+value") {
		t.Fatalf("jupyterDirectURL = %q", direct)
	}
	host, port := JupyterConnectTarget(ProxyState{Enabled: true, GuestHost: "guest.internal", GuestPort: 9999, HostPort: 7410})
	if host != "guest.internal" || port != 9999 {
		t.Fatalf("JupyterConnectTarget host=%q port=%d", host, port)
	}
	if address := JupyterConnectAddress(ProxyState{Enabled: true, GuestPort: 8888, HostPort: 7410}); address != "127.0.0.1:7410" {
		t.Fatalf("JupyterConnectAddress = %q", address)
	}
	if direct := jupyterDirectURL(ProxyState{}); direct != "" {
		t.Fatalf("disabled jupyter direct URL = %q", direct)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/base/api/kernelspecs" || r.URL.Query().Get("token") != "ready token" {
			t.Fatalf("unexpected jupyter readiness request path=%q rawQuery=%q", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"kernelspecs":{"python3":{}}}`))
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split test server host: %v", err)
	}
	port, err = net.LookupPort("tcp", portText)
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	if err := waitForJupyterProxy(context.Background(), ProxyState{Enabled: true, GuestHost: host, HostPort: port, GuestPort: port, ProxyPath: "/base/lab", Token: "ready token"}); err != nil {
		t.Fatalf("waitForJupyterProxy returned error: %v", err)
	}

	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("create log dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logDir, "jupyter.log"), []byte(" Jupyter Server 2.0\n is running at: http://127.0.0.1 "), 0o644); err != nil {
		t.Fatalf("write jupyter log: %v", err)
	}
	session := &Sandbox{Summary: SandboxSummary{WorkspacePath: workspace}}
	if logText := readSandboxJupyterLog(session); !jupyterLogIndicatesReady(logText) {
		t.Fatalf("jupyter log did not indicate readiness: %q", logText)
	}
	if readSandboxJupyterLog(nil) != "" || jupyterLogIndicatesReady(" ") {
		t.Fatalf("nil/empty jupyter log helpers returned unexpected values")
	}
	if logPath := jupyterLogPath(&appconfig.Config{GuestLogRoot: "/data/logs"}); logPath != "/data/logs/jupyter.log" {
		t.Fatalf("jupyterLogPath = %q", logPath)
	}
}
