package capability

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientStatusNotConfigured(t *testing.T) {
	client := NewClient(Config{})
	status := client.Status(context.Background())
	if status.Configured {
		t.Fatal("expected status to be unconfigured")
	}
	if status.Status != "not_configured" {
		t.Fatalf("unexpected status %q", status.Status)
	}
}

func TestClientInjectsToken(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "services": 2})
	}))
	defer server.Close()

	client := NewClient(Config{Addr: server.URL, Token: "secret-token"})
	status := client.Status(context.Background())
	if !status.OK {
		t.Fatalf("expected ok status, got %+v", status)
	}
	if authorization != "Bearer secret-token" {
		t.Fatalf("unexpected authorization header %q", authorization)
	}
}

func TestListCapsets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/v1/capsets" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"capsets": []map[string]any{{
				"id":          "dev",
				"name":        "Dev",
				"description": "tools",
				"enabled":     true,
			}},
		})
	}))
	defer server.Close()

	client := NewClient(Config{Addr: server.URL})
	capsets, err := client.ListCapsets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(capsets) != 1 || capsets[0].ID != "dev" || !capsets[0].Enabled {
		t.Fatalf("unexpected capsets %+v", capsets)
	}
}

func TestClientCatalogUsesAllQueryAndEscapesCapset(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/admin/v1/catalog/dev%2Ftools" {
			t.Fatalf("unexpected path %s", r.URL.EscapedPath())
		}
		if r.URL.Query().Get("all") != "true" {
			t.Fatalf("expected all=true, got %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(octobusCatalogResponse{CapsetID: "dev/tools"})
	}))
	defer server.Close()

	client := NewClient(Config{Addr: server.URL})
	catalog, err := client.Catalog(context.Background(), "dev/tools")
	if err != nil {
		t.Fatal(err)
	}
	if catalog.CapsetID != "dev/tools" {
		t.Fatalf("unexpected catalog %+v", catalog)
	}
}

func TestNormalizeCatalogMergesEndpoints(t *testing.T) {
	catalog, err := NormalizeCatalog(octobusCatalogResponse{
		CapsetID: "dev",
		Name:     "Dev",
		GRPC: []octobusGRPCItem{{
			ServiceID:               "svc",
			InstanceID:              "inst",
			RuntimeMode:             "stdio",
			MethodFullName:          "pkg.Service/Call",
			MethodPath:              "/pkg.Service/Call",
			Metadata:                map[string]string{"k": "v"},
			RequestMessageFullName:  "pkg.Request",
			ResponseMessageFullName: "pkg.Response",
			BackendInstanceStatus:   "running",
		}},
		MCP: []octobusMCPItem{{
			ServiceID:      "svc",
			InstanceID:     "inst",
			MethodFullName: "pkg.Service/Call",
			Endpoint:       "/capsets/dev/mcp",
			ToolName:       "pkg_service_call",
		}},
		ConnectRPC: []octobusConnectRPCItem{{
			ServiceID:      "svc",
			InstanceID:     "inst",
			MethodFullName: "pkg.Service/Call",
			Procedure:      "/pkg.Service/Call",
			Endpoint:       "/capsets/dev/connect/inst/pkg.Service/Call",
			HTTPMethod:     http.MethodPost,
			ContentTypes:   []string{"application/json"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Methods) != 1 {
		t.Fatalf("expected one method, got %+v", catalog.Methods)
	}
	method := catalog.Methods[0]
	if method.ServiceID != "svc" || method.InstanceID != "inst" || method.MethodFullName != "pkg.Service/Call" {
		t.Fatalf("unexpected method %+v", method)
	}
	if len(method.Endpoints) != 3 {
		t.Fatalf("expected three endpoints, got %+v", method.Endpoints)
	}
}

func TestNormalizeCatalogAllowsDuplicateGRPCMethodBindings(t *testing.T) {
	catalog, err := NormalizeCatalog(octobusCatalogResponse{
		CapsetID: "dev",
		GRPC: []octobusGRPCItem{
			{ServiceID: "svc-a", InstanceID: "inst-a", MethodFullName: "pkg.Service/Call"},
			{ServiceID: "svc-b", InstanceID: "inst-b", MethodFullName: "pkg.Service/Call"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Methods) != 2 {
		t.Fatalf("expected duplicate method bindings to be preserved, got %+v", catalog.Methods)
	}
}
