package proxy

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"

	domain "agent-compose/pkg/model"
	"agent-compose/pkg/workspaces"
)

func TestWorkspaceRoutesCoverageWorkflow(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "existing.txt"), []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := echo.New()
	RegisterWorkspaceRoutes(app, WorkspaceOptions{
		UploadLimitBytes: 1 << 20,
		Load: func(context.Context, string) (domain.WorkspaceConfig, workspaces.FileWorkspaceContent, error) {
			opened, err := os.OpenRoot(root)
			if err != nil {
				return domain.WorkspaceConfig{}, workspaces.FileWorkspaceContent{}, err
			}
			return domain.WorkspaceConfig{ID: "ws-1"}, workspaces.FileWorkspaceContent{Root: opened}, nil
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/agent-compose/workspaces/ws-1/files", nil)
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "existing.txt") {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "uploaded.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("uploaded")); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("path", "nested/uploaded.txt"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/agent-compose/workspaces/ws-1/upload", &body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(root, "nested/uploaded.txt")); err != nil || string(got) != "uploaded" {
		t.Fatalf("uploaded content=%q err=%v", string(got), err)
	}

	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	payload := []byte("from archive")
	if err := tw.WriteHeader(&tar.Header{Name: "archived.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(payload))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	body.Reset()
	writer = multipart.NewWriter(&body)
	part, err = writer.CreateFormFile("file", "archive.tar")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive.Bytes()); err != nil {
		t.Fatal(err)
	}
	_ = writer.WriteField("upload_type", "archive")
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/agent-compose/workspaces/ws-1/upload", &body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("archive upload status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/agent-compose/workspaces/ws-1/download?path=existing.txt", nil)
	rec = httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "existing" {
		t.Fatalf("download status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestWorkspaceRouteErrorMappingCoverage(t *testing.T) {
	if ToWorkspaceHTTPError(nil) != nil || ToWorkspaceUploadHTTPError(nil) != nil || IsHTTPRequestBodyTooLarge(nil) {
		t.Fatalf("nil error mapping failed")
	}
	for _, item := range []struct {
		err  error
		code int
	}{
		{domain.ErrNotFound, http.StatusNotFound},
		{domain.ErrInvalidArgument, http.StatusBadRequest},
		{domain.ErrRequired, http.StatusBadRequest},
		{errors.New("boom"), http.StatusInternalServerError},
	} {
		httpErr, ok := ToWorkspaceHTTPError(item.err).(*echo.HTTPError)
		if !ok || httpErr.Code != item.code {
			t.Fatalf("ToWorkspaceHTTPError(%v) = %#v", item.err, httpErr)
		}
	}
	if !IsHTTPRequestBodyTooLarge(&http.MaxBytesError{Limit: 1}) {
		t.Fatalf("expected MaxBytesError to be detected")
	}
	if httpErr, ok := ToWorkspaceUploadHTTPError(&http.MaxBytesError{Limit: 1}).(*echo.HTTPError); !ok || httpErr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload error = %#v", httpErr)
	}
}
