package driver

import "time"

const (
	MetricUnitPercent = "percent"
	MetricUnitBytes   = "bytes"
	MetricUnitSeconds = "seconds"
)

func metricOK(value float64, unit string) MetricValue {
	return MetricValue{Value: float64Ptr(value), Unit: unit, Status: MetricStatusOK}
}

func metricUnknown(unit, message string) MetricValue {
	return MetricValue{Unit: unit, Status: MetricStatusUnknown, Message: message}
}

func float64Ptr(value float64) *float64 {
	return &value
}

func unknownSandboxStats(sandboxID, driver, message string) SandboxStats {
	return SandboxStats{
		SandboxID:        sandboxID,
		Driver:           driver,
		SampledAt:        time.Now().UTC(),
		CPUPercent:       metricUnknown(MetricUnitPercent, message),
		MemoryUsageBytes: metricUnknown(MetricUnitBytes, message),
		MemoryLimitBytes: metricUnknown(MetricUnitBytes, message),
		MemoryPercent:    metricUnknown(MetricUnitPercent, message),
		NetworkRxBytes:   metricUnknown(MetricUnitBytes, message),
		NetworkTxBytes:   metricUnknown(MetricUnitBytes, message),
		BlockReadBytes:   metricUnknown(MetricUnitBytes, message),
		BlockWriteBytes:  metricUnknown(MetricUnitBytes, message),
		UptimeSeconds:    metricUnknown(MetricUnitSeconds, message),
	}
}
