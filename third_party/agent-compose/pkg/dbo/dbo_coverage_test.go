package dbo

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/samber/do/v2"

	appconfig "agent-compose/pkg/config"
)

func TestDBResourceSetupAndShutdownCoverage(t *testing.T) {
	if err := (*DBResource)(nil).Shutdown(context.Background()); err != nil {
		t.Fatalf("nil Shutdown returned error: %v", err)
	}
	if err := (&DBResource{}).Shutdown(context.Background()); err != nil {
		t.Fatalf("empty Shutdown returned error: %v", err)
	}

	di := do.New()
	Setup(di)
	do.OverrideValue(di, slog.Default())
	do.OverrideValue(di, &appconfig.Config{DbAddr: filepath.Join(t.TempDir(), "data.db")})
	resource, err := NewDBResource(di)
	if err != nil {
		t.Fatalf("NewDBResource returned error: %v", err)
	}
	do.OverrideValue(di, resource)
	db, err := NewDb(di)
	if err != nil || db == nil || db != resource.DB {
		t.Fatalf("NewDb db=%#v err=%v", db, err)
	}
	if err := resource.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}
}
