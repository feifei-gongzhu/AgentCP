package driver

import "testing"

func TestUnknownSandboxStatsMarksAllMetricsUnknown(t *testing.T) {
	stats := unknownSandboxStats("sandbox-1", RuntimeDriverDocker, "not running")
	if stats.SandboxID != "sandbox-1" || stats.Driver != RuntimeDriverDocker || stats.SampledAt.IsZero() {
		t.Fatalf("stats identity = %#v", stats)
	}
	for name, metric := range map[string]MetricValue{
		"cpu":          stats.CPUPercent,
		"memoryUsage":  stats.MemoryUsageBytes,
		"memoryLimit":  stats.MemoryLimitBytes,
		"memoryPct":    stats.MemoryPercent,
		"networkRx":    stats.NetworkRxBytes,
		"networkTx":    stats.NetworkTxBytes,
		"blockRead":    stats.BlockReadBytes,
		"blockWrite":   stats.BlockWriteBytes,
		"uptimeSecond": stats.UptimeSeconds,
	} {
		if metric.Status != MetricStatusUnknown || metric.Message != "not running" || metric.Value != nil {
			t.Fatalf("%s metric = %#v", name, metric)
		}
	}
}

func assertMetricValue(t *testing.T, metric MetricValue, status, unit string, value float64) {
	t.Helper()
	if metric.Status != status || metric.Unit != unit || metric.Value == nil || *metric.Value != value {
		t.Fatalf("metric = %#v, want status=%s unit=%s value=%v", metric, status, unit, value)
	}
}
