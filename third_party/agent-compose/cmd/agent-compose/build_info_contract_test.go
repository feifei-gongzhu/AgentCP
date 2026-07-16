package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/samber/do/v2"

	appconfig "agent-compose/pkg/config"
	driverpkg "agent-compose/pkg/driver"
)

func TestBuildInfoHTTPAndStatusCompatibility(t *testing.T) {
	testBuildInfoHTTPAndStatusCompatibility(t)
}

func TestIntegrationBuildInfoHTTPAndStatusCompatibility(t *testing.T) {
	testBuildInfoHTTPAndStatusCompatibility(t)
}

func TestE2EBuildInfoHTTPAndStatusCompatibility(t *testing.T) {
	testBuildInfoHTTPAndStatusCompatibility(t)
}

func testBuildInfoHTTPAndStatusCompatibility(t *testing.T) {
	t.Helper()
	t.Run("api version preserves envelope and adds build info", testAPIVersionBuildInfoContract)
	t.Run("status json passes additive fields through exactly", testStatusJSONBuildInfoPassthrough)
	t.Run("status text keeps legacy columns exactly", testStatusTextBuildInfoCompatibility)
}

func testAPIVersionBuildInfoContract(t *testing.T) {
	t.Helper()
	wantDrivers := driverpkg.CompiledRuntimeDrivers()

	di := do.New()
	do.ProvideValue(di, &appconfig.Config{Version: "legacy-version"})
	app, err := NewEcho(di)
	if err != nil {
		t.Fatalf("NewEcho returned error: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/version status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode /api/version envelope: %v", err)
	}
	if got := sortedJSONKeys(envelope); !reflect.DeepEqual(got, []string{"data", "err", "msg"}) {
		t.Fatalf("/api/version envelope keys = %v, want legacy err/msg/data", got)
	}
	if string(envelope["err"]) != "null" {
		t.Fatalf("/api/version err = %s, want null", envelope["err"])
	}
	var message string
	if err := json.Unmarshal(envelope["msg"], &message); err != nil || message != "OK" {
		t.Fatalf("/api/version msg = %q, %v; want OK", message, err)
	}

	var data map[string]json.RawMessage
	if err := json.Unmarshal(envelope["data"], &data); err != nil {
		t.Fatalf("decode /api/version data: %v", err)
	}
	wantDataKeys := []string{"arch", "compiled_drivers", "os", "timestamp", "timezone", "timezone_offset", "version"}
	if got := sortedJSONKeys(data); !reflect.DeepEqual(got, wantDataKeys) {
		t.Fatalf("/api/version data keys = %v, want legacy fields plus build info %v", got, wantDataKeys)
	}

	var decoded struct {
		Version         string   `json:"version"`
		Timestamp       float64  `json:"timestamp"`
		Timezone        string   `json:"timezone"`
		TimezoneOffset  *int     `json:"timezone_offset"`
		OS              string   `json:"os"`
		Arch            string   `json:"arch"`
		CompiledDrivers []string `json:"compiled_drivers"`
	}
	if err := json.Unmarshal(envelope["data"], &decoded); err != nil {
		t.Fatalf("decode /api/version build info: %v", err)
	}
	if decoded.Version != "legacy-version" || decoded.Timestamp <= 0 || decoded.Timezone == "" || decoded.TimezoneOffset == nil {
		t.Fatalf("legacy /api/version data changed: %#v", decoded)
	}
	if decoded.OS != runtime.GOOS || decoded.Arch != runtime.GOARCH || !reflect.DeepEqual(decoded.CompiledDrivers, wantDrivers) {
		t.Fatalf("/api/version build info = os=%q arch=%q drivers=%v, want %s/%s and %v", decoded.OS, decoded.Arch, decoded.CompiledDrivers, runtime.GOOS, runtime.GOARCH, wantDrivers)
	}
}

func testStatusJSONBuildInfoPassthrough(t *testing.T) {
	t.Helper()
	const body = `{"err":null,"msg":"OK","data":{"version":"daemon-version","timestamp":1783501631.2438176,"timezone":"CST","timezone_offset":28800,"os":"linux","arch":"arm64","compiled_drivers":["docker","boxlite","microsandbox"]}}`
	server := buildInfoStatusServer(t, body)
	defer server.Close()

	stdout, stderr, runCount, err := executeCommand("--json", "status", "--host", server.URL)
	if err != nil {
		t.Fatalf("status --json returned error: %v", err)
	}
	if stdout != body+"\n" {
		t.Fatalf("status --json stdout = %q, want exact daemon body %q", stdout, body+"\n")
	}
	if stderr != "" || runCount != 0 {
		t.Fatalf("status --json stderr/runCount = %q/%d, want empty/0", stderr, runCount)
	}
}

func testStatusTextBuildInfoCompatibility(t *testing.T) {
	t.Helper()
	const body = `{"err":null,"msg":"OK","data":{"version":"legacy","timestamp":1783501631.2438176,"timezone":"CST","timezone_offset":28800,"os":"linux","arch":"amd64","compiled_drivers":["docker","boxlite","microsandbox"]}}`
	var parsed daemonStatusResponse
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("decode daemon status response: %v", err)
	}
	if parsed.Data.OS != "linux" || parsed.Data.Arch != "amd64" || !reflect.DeepEqual(parsed.Data.CompiledDrivers, []string{"docker", "boxlite", "microsandbox"}) {
		t.Fatalf("parsed daemon build info = os=%q arch=%q drivers=%v", parsed.Data.OS, parsed.Data.Arch, parsed.Data.CompiledDrivers)
	}
	server := buildInfoStatusServer(t, body)
	defer server.Close()

	stdout, stderr, runCount, err := executeCommand("status", "--host", server.URL)
	if err != nil {
		t.Fatalf("status returned error: %v", err)
	}
	const want = "STATUS  UPTIME                         VERSION\n" +
		"OK      2026-07-08 17:07:11 CST +0800  legacy\n"
	if stdout != want {
		t.Fatalf("status text = %q, want exact legacy table %q", stdout, want)
	}
	if strings.Contains(stdout, "OS") || strings.Contains(stdout, "ARCH") || strings.Contains(stdout, "DRIVER") {
		t.Fatalf("status text added build-info columns: %q", stdout)
	}
	if stderr != "" || runCount != 0 {
		t.Fatalf("status stderr/runCount = %q/%d, want empty/0", stderr, runCount)
	}
}

func buildInfoStatusServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/version" {
			t.Fatalf("status request path = %q, want /api/version", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

func sortedJSONKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
