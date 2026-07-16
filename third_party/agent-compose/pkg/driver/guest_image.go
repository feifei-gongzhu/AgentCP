package driver

import "strings"

func resolveSandboxGuestImage(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func ResolveSandboxGuestImage(values ...string) string {
	return resolveSandboxGuestImage(values...)
}
