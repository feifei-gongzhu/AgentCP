// Package storeutil holds small, dependency-free helpers shared across the
// storage layer and its consumers, such as decoding timestamps persisted by the
// stores. Keeping these primitives here lets packages parse stored values
// without depending on a concrete store implementation.
package storeutil

import "time"

// StoredUnixMillisecondThreshold is the boundary used to tell stored
// unix-second timestamps apart from unix-millisecond timestamps. Values at or
// above the threshold are treated as milliseconds.
const StoredUnixMillisecondThreshold int64 = 10_000_000_000

// ParseStoredUnixTimeAuto interprets a stored integer timestamp as either unix
// seconds or unix milliseconds based on StoredUnixMillisecondThreshold, and
// returns a UTC time. Non-positive values yield the zero time.
func ParseStoredUnixTimeAuto(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value >= StoredUnixMillisecondThreshold {
		return time.UnixMilli(value).UTC()
	}
	return time.Unix(value, 0).UTC()
}
