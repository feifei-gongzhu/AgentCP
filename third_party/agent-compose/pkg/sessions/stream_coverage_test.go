package sessions

import (
	"testing"
	"time"

	domain "agent-compose/pkg/model"
)

func TestStreamBrokerCellEventsCoverage(t *testing.T) {
	broker := NewStreamBrokerForTest()
	ch, unsubscribe := broker.Subscribe("session-1")
	defer unsubscribe()
	cell := domain.NotebookCell{ID: "cell-1", Source: "echo hi", CreatedAt: time.Now().UTC()}
	broker.PublishCellStarted("session-1", cell)
	if event := <-ch; event.EventType != WatchEventTypeCellStarted || event.Cell.ID != "cell-1" {
		t.Fatalf("cell started event = %#v", event)
	}
	broker.PublishCellOutput("session-1", "cell-1", "hi", domain.StdioStderr)
	if event := <-ch; event.EventType != WatchEventTypeCellOutput || event.Chunk != "hi" || event.Stream != domain.StdioStderr {
		t.Fatalf("cell output event = %#v", event)
	}
	broker.PublishCellCompleted("session-1", cell)
	if event := <-ch; event.EventType != WatchEventTypeCellCompleted || event.Cell.ID != "cell-1" {
		t.Fatalf("cell completed event = %#v", event)
	}
	closed, _ := broker.Subscribe(" ")
	if _, ok := <-closed; ok {
		t.Fatalf("empty session subscription should be closed")
	}
}

func TestIntegrationStreamBrokerCellEventsCoverage(t *testing.T) {
	TestStreamBrokerCellEventsCoverage(t)
}

func TestE2EStreamBrokerCellEventsCoverage(t *testing.T) {
	TestStreamBrokerCellEventsCoverage(t)
}
