package configstore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"agent-compose/pkg/identity"
	"agent-compose/pkg/resources"
)

func (s *ConfigStore) FindResourceIDs(ctx context.Context, options resources.ResolveOptions) ([]resources.Target, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("config store is required")
	}
	clause, args, ok := resourceIDClause("id", options.ID)
	if !ok {
		return nil, nil
	}
	allowed := make(map[resources.Kind]bool, len(options.Kinds))
	for _, kind := range options.Kinds {
		allowed[kind] = true
	}
	var result []resources.Target
	if allowed[resources.KindProject] {
		items, err := queryResourceIDs(ctx, s.db, `SELECT id, name FROM project WHERE removed_at = 0 AND `+clause, args, func(values []string) resources.Target {
			return resources.Target{Kind: resources.KindProject, ID: values[0], ShortID: identity.ShortID(values[0]), ProjectID: values[0], ProjectName: values[1]}
		})
		if err != nil {
			return nil, fmt.Errorf("find project ids: %w", err)
		}
		result = append(result, items...)
	}
	if allowed[resources.KindAgent] {
		agentClause, agentArgs, _ := resourceIDClause("pa.id", options.ID)
		items, err := queryResourceIDs(ctx, s.db, `SELECT pa.id, pa.agent_name, pa.project_id, p.name FROM project_agent pa JOIN project p ON p.id = pa.project_id WHERE p.removed_at = 0 AND `+agentClause, agentArgs, func(values []string) resources.Target {
			return resources.Target{Kind: resources.KindAgent, ID: values[0], ShortID: identity.ShortID(values[0]), AgentName: values[1], ProjectID: values[2], ProjectName: values[3]}
		})
		if err != nil {
			return nil, fmt.Errorf("find agent ids: %w", err)
		}
		result = append(result, items...)
	}
	if allowed[resources.KindRun] {
		runClause, runArgs, _ := resourceIDClause("run_id", options.ID)
		items, err := queryResourceIDs(ctx, s.db, `SELECT run_id, agent_name, project_id, project_name FROM project_run WHERE `+runClause, runArgs, func(values []string) resources.Target {
			return resources.Target{Kind: resources.KindRun, ID: values[0], ShortID: identity.ShortID(values[0]), AgentName: values[1], ProjectID: values[2], ProjectName: values[3]}
		})
		if err != nil {
			return nil, fmt.Errorf("find run ids: %w", err)
		}
		result = append(result, items...)
	}
	return result, nil
}

func resourceIDClause(column, ref string) (string, []any, bool) {
	switch column {
	case "id", "pa.id", "run_id":
	default:
		return "", nil, false
	}
	ref = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(ref)), identity.Prefix)
	if !identity.IsIDPrefix(ref) {
		return "", nil, false
	}
	if identity.IsID(ref) {
		return `(` + column + ` = ? OR ` + column + ` = ?)`, []any{ref, identity.Prefix + ref}, true
	}
	upper := nextResourceIDPrefix(ref)
	return `((` + column + ` >= ? AND ` + column + ` < ?) OR (` + column + ` >= ? AND ` + column + ` < ?))`, []any{ref, upper, identity.Prefix + ref, identity.Prefix + upper}, true
}

func nextResourceIDPrefix(prefix string) string {
	value := []byte(prefix)
	for index := len(value) - 1; index >= 0; index-- {
		if value[index] < 'f' {
			if value[index] == '9' {
				value[index] = 'a'
			} else {
				value[index]++
			}
			return string(value[:index+1])
		}
	}
	return "g"
}

func queryResourceIDs(ctx context.Context, db *sql.DB, statement string, args []any, build func([]string) resources.Target) ([]resources.Target, error) {
	rows, err := db.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var result []resources.Target
	for rows.Next() {
		values := make([]string, len(columns))
		dest := make([]any, len(values))
		for index := range values {
			dest[index] = &values[index]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		result = append(result, build(values))
	}
	return result, rows.Err()
}
