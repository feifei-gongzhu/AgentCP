# AgentCP V3 runtime dependency

AgentCP V3 uses `agent-compose` as its required agent runtime and sandbox
control plane. AgentCP remains the authority for methodology, blackboard state,
human gates, intent scheduling, evidence adjudication, and stale-write fencing.

The vendored upstream source lives in `third_party/agent-compose`. Its original
license and notices are preserved. Local build outputs and caches remain ignored
by Git.

