package restful

import (
	"testing"

	"google.golang.org/grpc/codes"
)

func TestExtractCodeHelpersCoverage(t *testing.T) {
	if ExtractCodeString(nil) != nil || ExtractCodeString(codes.OK) != nil {
		t.Fatalf("nil/OK code string should be nil")
	}
	raw := "custom"
	if got := ExtractCodeString(&raw); got == nil || *got != "custom" {
		t.Fatalf("pointer code string = %#v", got)
	}
	if got := ExtractCodeString(codes.NotFound); got == nil || *got != "NotFound" {
		t.Fatalf("grpc code string = %#v", got)
	}
	if got := ExtractCodeString(struct{}{}); got == nil || *got != "Unknown" {
		t.Fatalf("unknown code string = %#v", got)
	}
	for _, code := range []any{uint32(7), uint8(7), int8(7), uint16(7), int16(7), uint64(7), int64(7), int32(7), codes.PermissionDenied} {
		if ExtractCodeUint32(code) == 0 {
			t.Fatalf("ExtractCodeUint32(%T) returned zero", code)
		}
	}
	if ExtractCodeUint32(nil) != 0 || ExtractCodeUint32(struct{}{}) != uint32(codes.Unknown) {
		t.Fatalf("ExtractCodeUint32 nil/default failed")
	}
}

func TestIntegrationExtractCodeHelpersCoverage(t *testing.T) {
	TestExtractCodeHelpersCoverage(t)
}

func TestE2EExtractCodeHelpersCoverage(t *testing.T) {
	TestExtractCodeHelpersCoverage(t)
}
