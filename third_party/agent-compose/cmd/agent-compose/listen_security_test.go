package main

import "testing"

func TestIsLoopbackListenAddress(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{address: "127.0.0.1:7410", want: true},
		{address: "[::1]:7410", want: true},
		{address: "localhost:7410", want: true},
		{address: "0.0.0.0:7410", want: false},
		{address: ":7410", want: false},
		{address: "192.0.2.1:7410", want: false},
		{address: "invalid", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.address, func(t *testing.T) {
			if got := isLoopbackListenAddress(tt.address); got != tt.want {
				t.Fatalf("isLoopbackListenAddress(%q) = %t, want %t", tt.address, got, tt.want)
			}
		})
	}
}
