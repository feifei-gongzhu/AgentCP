//go:build linux && cgo && microsandboxcgo

package driver

import (
	"testing"
	"time"

	microsandbox "github.com/superradcompany/microsandbox/sdk/go"
)

func TestMicrosandboxStatsFromMetricsMapsStableMetrics(t *testing.T) {
	stats := microsandboxStatsFromMetrics(
		&Sandbox{Summary: SandboxSummary{ID: "session-1", Driver: RuntimeDriverMicrosandbox}},
		VMState{},
		&microsandbox.Metrics{
			CPUPercent:       12.5,
			MemoryBytes:      512,
			MemoryLimitBytes: 2048,
			DiskReadBytes:    100,
			DiskWriteBytes:   200,
			NetRxBytes:       300,
			NetTxBytes:       400,
			Uptime:           2 * time.Minute,
		},
	)
	if stats.SandboxID != "session-1" || stats.Driver != RuntimeDriverMicrosandbox {
		t.Fatalf("stats identity = %#v", stats)
	}
	assertMetricValue(t, stats.CPUPercent, MetricStatusOK, MetricUnitPercent, 12.5)
	assertMetricValue(t, stats.MemoryUsageBytes, MetricStatusOK, MetricUnitBytes, 512)
	assertMetricValue(t, stats.MemoryLimitBytes, MetricStatusOK, MetricUnitBytes, 2048)
	assertMetricValue(t, stats.MemoryPercent, MetricStatusOK, MetricUnitPercent, 25)
	assertMetricValue(t, stats.BlockReadBytes, MetricStatusOK, MetricUnitBytes, 100)
	assertMetricValue(t, stats.BlockWriteBytes, MetricStatusOK, MetricUnitBytes, 200)
	assertMetricValue(t, stats.NetworkRxBytes, MetricStatusOK, MetricUnitBytes, 300)
	assertMetricValue(t, stats.NetworkTxBytes, MetricStatusOK, MetricUnitBytes, 400)
	assertMetricValue(t, stats.UptimeSeconds, MetricStatusOK, MetricUnitSeconds, 120)
}

func TestMicrosandboxStatsFromNilMetricsReturnsUnknownFields(t *testing.T) {
	stats := microsandboxStatsFromMetrics(&Sandbox{Summary: SandboxSummary{ID: "session-1"}}, VMState{}, nil)
	if stats.CPUPercent.Status != MetricStatusUnknown || stats.MemoryUsageBytes.Value != nil {
		t.Fatalf("nil metrics stats = %#v", stats)
	}
}
