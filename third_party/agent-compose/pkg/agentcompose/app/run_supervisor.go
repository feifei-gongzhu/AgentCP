package app

import (
	"context"
	"strings"
	"sync"

	"github.com/samber/do/v2"

	domain "agent-compose/pkg/model"
	"agent-compose/pkg/runs"
	"agent-compose/pkg/storage/configstore"
)

type RunSupervisor struct {
	root       context.Context
	controller *runs.Controller
	store      *configstore.ConfigStore

	mu     sync.Mutex
	active map[string]*activeRun
}

type activeRun struct {
	cancel   context.CancelFunc
	stopOnce sync.Once
	stopping bool
	stopped  bool
	stopErr  error
}

func NewRunSupervisor(di do.Injector) (*RunSupervisor, error) {
	return &RunSupervisor{
		root:       do.MustInvoke[context.Context](di),
		controller: do.MustInvoke[*runs.Controller](di),
		store:      do.MustInvoke[*configstore.ConfigStore](di),
		active:     map[string]*activeRun{},
	}, nil
}

func (s *RunSupervisor) StartRun(ctx context.Context, req runs.RunAgentRequest) (domain.ProjectRunRecord, error) {
	started, err := s.controller.StartProjectRun(ctx, req)
	if err != nil {
		return domain.ProjectRunRecord{}, err
	}
	if runs.StatusIsTerminal(started.Run.Status) {
		return started.Run, nil
	}
	execCtx, cancel := context.WithCancel(s.root)
	s.register(started.Run.RunID, cancel)
	go func() {
		defer s.unregister(started.Run.RunID)
		_, _, _ = started.Execute(execCtx, nil)
	}()
	return started.Run, nil
}

func (s *RunSupervisor) StopActiveRun(ctx context.Context, runID, reason string) (bool, error) {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return false, nil
	}
	s.mu.Lock()
	active, ok := s.active[runID]
	if ok {
		active.stopping = true
	}
	s.mu.Unlock()
	if !ok {
		return false, nil
	}
	active.stopOnce.Do(func() {
		active.cancel()
		reason = strings.TrimSpace(reason)
		if reason == "" {
			reason = "stop requested"
		}
		coordinator := runs.NewCoordinator(s.store, domain.StableProjectRunID)
		_, active.stopErr = coordinator.MarkCanceled(ctx, runs.TransitionRequest{RunID: runID, Error: reason})
		if active.stopErr != nil {
			if current, err := s.store.GetProjectRun(ctx, runID); err == nil && runs.StatusIsTerminal(current.Status) {
				active.stopErr = nil
			}
		}
		active.stopped = active.stopErr == nil

		s.mu.Lock()
		if current := s.active[runID]; current == active {
			delete(s.active, runID)
		}
		s.mu.Unlock()
	})
	return active.stopped, active.stopErr
}

func (s *RunSupervisor) register(runID string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active[runID] = &activeRun{cancel: cancel}
}

func (s *RunSupervisor) unregister(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if active := s.active[runID]; active != nil && active.stopping {
		return
	}
	delete(s.active, runID)
}
