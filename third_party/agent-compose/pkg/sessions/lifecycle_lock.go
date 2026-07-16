package sessions

import (
	"strings"
	"sync"
)

// LifecycleLocks serializes state-changing operations for a sandbox within a
// daemon process. The lifecycle journal remains the durable crash-recovery
// boundary; these locks close the live remove/resume/start race.
type LifecycleLocks struct {
	mu    sync.Mutex
	locks map[string]*lifecycleLock
}

type lifecycleLock struct {
	mu    sync.Mutex
	users int
}

func NewLifecycleLocks() *LifecycleLocks {
	return &LifecycleLocks{locks: make(map[string]*lifecycleLock)}
}

func (l *LifecycleLocks) Lock(sandboxID string) func() {
	if l == nil {
		return func() {}
	}
	sandboxID = strings.TrimSpace(sandboxID)
	l.mu.Lock()
	if l.locks == nil {
		l.locks = make(map[string]*lifecycleLock)
	}
	lock := l.locks[sandboxID]
	if lock == nil {
		lock = &lifecycleLock{}
		l.locks[sandboxID] = lock
	}
	lock.users++
	l.mu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()

		l.mu.Lock()
		lock.users--
		if lock.users == 0 && l.locks[sandboxID] == lock {
			delete(l.locks, sandboxID)
		}
		l.mu.Unlock()
	}
}
