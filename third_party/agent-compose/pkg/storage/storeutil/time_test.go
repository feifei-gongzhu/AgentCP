package storeutil

import (
	"testing"
	"time"
)

func TestParseStoredUnixTimeAuto(t *testing.T) {
	cases := []struct {
		name  string
		value int64
		want  time.Time
	}{
		{name: "zero yields zero time", value: 0, want: time.Time{}},
		{name: "negative yields zero time", value: -1, want: time.Time{}},
		{
			name:  "below threshold treated as seconds",
			value: 1_700_000_000,
			want:  time.Unix(1_700_000_000, 0).UTC(),
		},
		{
			name:  "at threshold treated as milliseconds",
			value: StoredUnixMillisecondThreshold,
			want:  time.UnixMilli(StoredUnixMillisecondThreshold).UTC(),
		},
		{
			name:  "above threshold treated as milliseconds",
			value: 1_700_000_000_000,
			want:  time.UnixMilli(1_700_000_000_000).UTC(),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseStoredUnixTimeAuto(tc.value)
			if !got.Equal(tc.want) {
				t.Fatalf("ParseStoredUnixTimeAuto(%d) = %v, want %v", tc.value, got, tc.want)
			}
			if !got.IsZero() && got.Location() != time.UTC {
				t.Errorf("expected UTC location, got %v", got.Location())
			}
		})
	}
}
