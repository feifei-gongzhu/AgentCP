package sessions

import (
	"runtime"
	"testing"
	"time"
)

func TestLifecycleLocksReclaimsUnusedEntries(t *testing.T) {
	locks := NewLifecycleLocks()
	for _, sandboxID := range []string{"sandbox-a", "sandbox-b", "sandbox-c"} {
		unlock := locks.Lock(sandboxID)
		unlock()
	}

	locks.mu.Lock()
	defer locks.mu.Unlock()
	if len(locks.locks) != 0 {
		t.Fatalf("unused lifecycle locks = %d, want 0", len(locks.locks))
	}
}

func TestLifecycleLocksKeepsWaitersOnTheSameLock(t *testing.T) {
	locks := NewLifecycleLocks()
	firstUnlock := locks.Lock("sandbox")
	wakeup := make(chan struct{})
	secondAcquired := make(chan struct{})
	secondRelease := make(chan struct{})
	go func() {
		close(wakeup)
		unlock := locks.Lock("sandbox")
		close(secondAcquired)
		<-secondRelease
		unlock()
	}()
	<-wakeup
	waitForLifecycleLockUsers(t, locks, "sandbox", 2)

	firstUnlock()
	<-secondAcquired
	thirdAcquired := make(chan struct{})
	go func() {
		unlock := locks.Lock("sandbox")
		close(thirdAcquired)
		unlock()
	}()
	waitForLifecycleLockUsers(t, locks, "sandbox", 2)
	select {
	case <-thirdAcquired:
		t.Fatal("third caller acquired a replacement lock while second caller held the original")
	default:
	}
	close(secondRelease)
	<-thirdAcquired
}

func waitForLifecycleLockUsers(t *testing.T, locks *LifecycleLocks, sandboxID string, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		locks.mu.Lock()
		lock := locks.locks[sandboxID]
		got := 0
		if lock != nil {
			got = lock.users
		}
		locks.mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("lifecycle lock users = %d, want %d", got, want)
		}
		runtime.Gosched()
	}
}
