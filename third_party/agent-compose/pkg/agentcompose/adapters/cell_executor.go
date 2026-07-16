package adapters

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	appconfig "agent-compose/pkg/config"
	"agent-compose/pkg/execution"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/sessions"
	"agent-compose/pkg/storage/sessionstore"
)

type CellExecutor struct {
	config   *appconfig.Config
	store    *sessionstore.Store
	runtimes RuntimeProvider
	streams  *sessions.StreamBroker
}

func NewCellExecutor(config *appconfig.Config, store *sessionstore.Store, runtimes RuntimeProvider, streams *sessions.StreamBroker) *CellExecutor {
	return &CellExecutor{config: config, store: store, runtimes: runtimes, streams: streams}
}

func (e *CellExecutor) ExecuteCell(ctx context.Context, session *domain.Sandbox, cellType, source string) (domain.NotebookCell, error) {
	return e.executeCell(ctx, session, cellType, source, execution.CellExecutionStream{})
}

func (e *CellExecutor) ExecuteCellStream(ctx context.Context, session *domain.Sandbox, cellType, source string, stream execution.CellExecutionStream) (domain.NotebookCell, error) {
	return e.executeCell(ctx, session, cellType, source, stream)
}

func (e *CellExecutor) executeCell(ctx context.Context, session *domain.Sandbox, cellType, source string, stream execution.CellExecutionStream) (domain.NotebookCell, error) {
	appconfig.ApplyDefaultGuestPaths(e.config)
	source = strings.TrimSpace(source)
	if source == "" {
		return domain.NotebookCell{}, fmt.Errorf("source is required")
	}

	cellType, err := execution.NormalizeCellType(cellType)
	if err != nil {
		return domain.NotebookCell{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, e.config.SandboxStartTimeout)
	defer cancel()
	execCtx, execCancel := context.WithCancel(ctx)
	defer execCancel()

	vmState, err := e.store.GetVMState(session.Summary.ID)
	if err != nil {
		return domain.NotebookCell{}, err
	}
	runtime, err := e.runtimes.ForSession(session)
	if err != nil {
		return domain.NotebookCell{}, err
	}

	cellID := uuid.NewString()
	hostCellDir := filepath.Join(filepath.Dir(session.Summary.WorkspacePath), "state", "cells", cellID)
	if err := os.MkdirAll(hostCellDir, 0o755); err != nil {
		return domain.NotebookCell{}, fmt.Errorf("create cell state dir: %w", err)
	}

	guestCellDir := filepath.Join(e.config.GuestStateRoot, "cells", cellID)
	scriptName, command, args := execution.CellExecSpec(cellType, guestCellDir)
	hostScriptPath := filepath.Join(hostCellDir, scriptName)
	if err := os.WriteFile(hostScriptPath, []byte(source), 0o644); err != nil {
		return domain.NotebookCell{}, fmt.Errorf("write cell script: %w", err)
	}

	startedAt := time.Now().UTC()
	startedCell := domain.NotebookCell{
		ID:        cellID,
		Type:      cellType,
		Source:    source,
		CreatedAt: startedAt,
		Running:   true,
	}
	if stream.OnStart != nil {
		if err := stream.OnStart(startedCell); err != nil {
			return domain.NotebookCell{}, err
		}
	}
	if e.streams != nil {
		e.streams.PublishCellStarted(session.Summary.ID, startedCell)
	}

	var streamErrMu sync.Mutex
	var streamErr error
	streamWriter := func(chunk domain.ExecChunk) {
		if e.streams != nil {
			e.streams.PublishCellOutput(session.Summary.ID, cellID, chunk.Text, chunk.Stream)
		}
		if stream.OnChunk != nil {
			if err := stream.OnChunk(cellID, chunk); err != nil {
				streamErrMu.Lock()
				if streamErr == nil {
					streamErr = err
					execCancel()
				}
				streamErrMu.Unlock()
			}
		}
	}
	result, err := runtime.ExecStream(execCtx, session, vmState, domain.ExecSpec{
		Command: command,
		Args:    args,
		Cwd:     e.config.GuestWorkspacePath,
	}, streamWriter)
	streamErrMu.Lock()
	deferredStreamErr := streamErr
	streamErrMu.Unlock()
	if deferredStreamErr != nil {
		return domain.NotebookCell{}, deferredStreamErr
	}
	if err != nil {
		return domain.NotebookCell{}, err
	}

	if err := execution.WriteCellArtifacts(hostCellDir, source, result); err != nil {
		return domain.NotebookCell{}, err
	}

	cell := domain.NotebookCell{
		ID:        cellID,
		Type:      cellType,
		Source:    source,
		Stdout:    result.Stdout,
		Stderr:    result.Stderr,
		Output:    result.Output,
		ExitCode:  result.ExitCode,
		Success:   result.Success,
		CreatedAt: startedAt,
	}
	if err := e.store.AddCell(ctx, session, cell); err != nil {
		return domain.NotebookCell{}, err
	}
	if e.streams != nil {
		e.streams.PublishCellCompleted(session.Summary.ID, cell)
	}

	eventLevel := "info"
	eventType := "kernel.cell.succeeded"
	eventMessage := fmt.Sprintf("executed %s cell in agent-compose guest", cellType)
	if !result.Success {
		eventLevel = "error"
		eventType = "kernel.cell.failed"
		eventMessage = firstNonEmpty(result.Stderr, fmt.Sprintf("%s cell failed with exit code %d", cellType, result.ExitCode))
	}
	event := domain.SandboxEvent{
		ID:        uuid.NewString(),
		Type:      eventType,
		Level:     eventLevel,
		Message:   eventMessage,
		CreatedAt: time.Now().UTC(),
	}
	_ = e.store.AddEvent(ctx, session.Summary.ID, event)
	if e.streams != nil {
		e.streams.PublishEventAdded(session.Summary.ID, event)
	}
	return cell, nil
}
