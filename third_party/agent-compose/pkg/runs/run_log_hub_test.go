package runs

import (
	"testing"
	"time"
)

func TestRunLogHubPublishesAndDropsForSlowSubscribers(t *testing.T) {
	hub := NewRunLogHub()
	sub := hub.Subscribe("run-1")
	defer sub.Close()

	if !hub.Publish(RunLogEvent{RunID: "run-1", Data: "first\n", Offset: 6}) {
		t.Fatalf("Publish returned false")
	}
	event := <-sub.C()
	if event.Data != "first\n" || event.Offset != 6 || event.CreatedAt.IsZero() {
		t.Fatalf("event = %#v", event)
	}

	started := time.Now()
	for i := 0; i < defaultRunLogSubscriptionBuffer+10; i++ {
		hub.Publish(RunLogEvent{RunID: "run-1", Data: "x", Offset: uint64(i + 1)})
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("slow subscriber blocked publish for %s", elapsed)
	}
}
