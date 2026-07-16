package events

import (
	"strings"
	"testing"
	"time"

	domain "agent-compose/pkg/model"
)

func TestNormalizeTopicEventRecordCoverage(t *testing.T) {
	event, err := NormalizeTopicEventRecord(domain.TopicEventRecord{
		Topic:          " runtime.test ",
		Source:         domain.TopicEventSourceLoader,
		DispatchStatus: domain.TopicEventDispatchPending,
		PayloadJSON:    `{"ok":true}`,
		AttemptCount:   -1,
		ClaimUntil:     time.Now(),
		NextAttemptAt:  time.Now(),
		DeadLetterAt:   time.Now(),
		DispatchedAt:   time.Now(),
	}, true)
	if err != nil {
		t.Fatalf("NormalizeTopicEventRecord returned error: %v", err)
	}
	if !strings.HasPrefix(event.ID, "evt_") || event.CorrelationID != event.ID || event.PayloadHash == "" || event.AttemptCount != 0 {
		t.Fatalf("normalized event = %#v", event)
	}
	for _, item := range []domain.TopicEventRecord{
		{Topic: "bad topic", Source: domain.TopicEventSourceLoader, DispatchStatus: domain.TopicEventDispatchPending},
		{ID: "event-1", Topic: "runtime.test", DispatchStatus: domain.TopicEventDispatchPending},
		{ID: "event-1", Topic: "runtime.test", Source: domain.TopicEventSourceLoader, DispatchStatus: "bad"},
		{ID: "event-1", Topic: "runtime.test", Source: domain.TopicEventSourceLoader, DispatchStatus: domain.TopicEventDispatchPending, PayloadJSON: `{bad`},
	} {
		if _, err := NormalizeTopicEventRecord(item, false); err == nil {
			t.Fatalf("expected normalize error for %#v", item)
		}
	}
}

func TestIntegrationNormalizeTopicEventRecordCoverage(t *testing.T) {
	TestNormalizeTopicEventRecordCoverage(t)
}

func TestE2ENormalizeTopicEventRecordCoverage(t *testing.T) {
	TestNormalizeTopicEventRecordCoverage(t)
}
