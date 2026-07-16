package echofn

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/samber/do/v2"
	"github.com/samber/mo"
	"github.com/samber/oops"
	"google.golang.org/grpc/codes"

	"agent-compose/pkg/fxgo/restful"
)

func TestEchoFunctionAdaptersCoverage(t *testing.T) {
	app := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"ok"}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	ctx := app.NewContext(req, rec)
	if err := SendResultAsJson[map[string]string, restful.StrStatusResp[map[string]string]](ctx, mo.Ok(map[string]string{"ok": "true"})); err != nil {
		t.Fatalf("SendResultAsJson ok returned error: %v", err)
	}
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "true") {
		t.Fatalf("ok response status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ctx = app.NewContext(req, rec)
	publicErr := oops.Code(codes.InvalidArgument).Public("bad request").Wrap(errors.New("private"))
	if err := SendResultAsJson[map[string]string, restful.StrStatusResp[map[string]string]](ctx, mo.Err[map[string]string](publicErr)); err != nil {
		t.Fatalf("SendResultAsJson oops returned error: %v", err)
	}
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "bad request") {
		t.Fatalf("oops response status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := SendResultAsJson[map[string]string, restful.StrStatusResp[map[string]string]](ctx, mo.Err[map[string]string](errors.New("plain"))); err == nil {
		t.Fatalf("expected plain error to pass through")
	}

	if err := ResultFunc2StrStatusResp(func(echo.Context) mo.Result[string] { return mo.Ok("ok") })(ctx); err != nil {
		t.Fatalf("ResultFunc2StrStatusResp returned error: %v", err)
	}
	if err := ResultFunc2CodeStatusResp(func(echo.Context) mo.Result[string] { return mo.Ok("ok") })(ctx); err != nil {
		t.Fatalf("ResultFunc2CodeStatusResp returned error: %v", err)
	}
	di := do.New()
	if err := DiResultFunc2StrStatusResp(di, func(do.Injector, echo.Context) mo.Result[string] { return mo.Ok("ok") })(ctx); err != nil {
		t.Fatalf("DiResultFunc2StrStatusResp returned error: %v", err)
	}
	if err := DiResultFunc2CodeStatusResp(di, func(do.Injector, echo.Context) mo.Result[string] { return mo.Ok("ok") })(ctx); err != nil {
		t.Fatalf("DiResultFunc2CodeStatusResp returned error: %v", err)
	}
	if err := DiFunc2EchoHandler(di, func(do.Injector, echo.Context) error { return nil })(ctx); err != nil {
		t.Fatalf("DiFunc2EchoHandler returned error: %v", err)
	}
	var payload struct {
		Name string `json:"name"`
	}
	if bound := Bind[struct {
		Name string `json:"name"`
	}](ctx); bound.IsError() {
		t.Fatalf("Bind returned error")
	} else {
		payload = bound.MustGet()
	}
	if payload.Name != "ok" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestIntegrationEchoFunctionAdaptersCoverage(t *testing.T) {
	TestEchoFunctionAdaptersCoverage(t)
}

func TestE2EEchoFunctionAdaptersCoverage(t *testing.T) {
	TestEchoFunctionAdaptersCoverage(t)
}
