package model

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestLegacyAgentSessionJSONCompatibility(t *testing.T) {
	var cell NotebookCell
	if err := json.Unmarshal([]byte(`{
		"id":"cell-1",
		"agent_session_id":"thread-1",
		"agent_resume":{
			"session_id":"thread-1",
			"session_state_path":"/state.json",
			"session_manifest_path":"/manifest.json",
			"session_jsonl_paths":["/log.jsonl"]
		}
	}`), &cell); err != nil {
		t.Fatal(err)
	}
	if cell.AgentThreadID != "thread-1" || cell.AgentResume == nil ||
		cell.AgentResume.ThreadID != "thread-1" || cell.AgentResume.ThreadStatePath != "/state.json" ||
		cell.AgentResume.ThreadManifestPath != "/manifest.json" || !reflect.DeepEqual(cell.AgentResume.ProviderLogPaths, []string{"/log.jsonl"}) {
		t.Fatalf("legacy cell decoded as %#v", cell)
	}

	var run AgentRun
	if err := json.Unmarshal([]byte(`{"id":"run-1","agent_session_id":"thread-2"}`), &run); err != nil {
		t.Fatal(err)
	}
	if run.AgentThreadID != "thread-2" {
		t.Fatalf("legacy run decoded as %#v", run)
	}
}
