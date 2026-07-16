//go:build linux && cgo && (boxlitecgo || microsandboxcgo)

package driver

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/docker/docker/client"
)

// applyDockerDaemonPullPolicy refreshes (or gates) the local docker-daemon copy
// of imageRef according to pullPolicy, BEFORE a caller materializes a rootfs/OCI
// layout from that local copy. The microsandbox and boxlite drivers resolve
// images through the local docker daemon first; without this the daemon short
// circuit returns a stale local image and pullPolicy=always never re-pulls.
//
//   - "always": pull imageRef into the local daemon (bounded by pullTimeout). On
//     pull failure fall back to the existing local copy if present (warn), else
//     error carrying the pull cause.
//   - "never": do not pull; error only if the image is absent locally.
//   - "missing"/empty: no-op — the caller's existing local-first + IfMissing
//     behavior is preserved byte-for-byte.
//
// It never mutates the caller's control flow beyond the pull; materialization
// still runs afterward on the (possibly refreshed) local image.
func applyDockerDaemonPullPolicy(ctx context.Context, imageRef, pullPolicy string, pullTimeout time.Duration) error {
	imageRef = strings.TrimSpace(imageRef)
	if imageRef == "" {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(pullPolicy)) {
	case "always", "never":
		// handled below
	default:
		return nil // missing / empty: preserve prior behavior exactly
	}

	dockerClient, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		// This runs only after the caller has confirmed the docker daemon is
		// available (the resolve* paths gate this behind dockerAvailable==true)
		// and BEFORE it materializes from the local daemon copy. Silently
		// returning nil here would let the caller proceed to dockerMaterialize
		// with policy unenforced — pull_policy=always would skip the re-pull and
		// pull_policy=never would skip the local existence check. Surface the
		// error so the caller aborts instead of using an unvalidated image.
		return fmt.Errorf("connect docker daemon for pull-policy check %s: %w", imageRef, err)
	}
	defer func() { _ = dockerClient.Close() }()

	switch strings.ToLower(strings.TrimSpace(pullPolicy)) {
	case "never":
		resolvedRef, ok, resolveErr := resolveLocalDockerImageRef(ctx, dockerClient, imageRef)
		_, err := requireLocalDockerImage(imageRef, resolvedRef, ok, resolveErr)
		return err

	case "always":
		pullCtx := ctx
		if pullTimeout > 0 {
			var cancel context.CancelFunc
			pullCtx, cancel = context.WithTimeout(ctx, pullTimeout)
			defer cancel()
		}
		if pullErr := dockerImagePull(pullCtx, dockerClient, imageRef); pullErr != nil {
			if _, ok, resolveErr := resolveLocalDockerImageRef(ctx, dockerClient, imageRef); resolveErr == nil && ok {
				slog.Warn("guest image pull failed, using cached local image", "image", imageRef, "pull_error", pullErr)
				return nil
			}
			return fmt.Errorf("guest image %s: pull failed (%w) and not found locally", imageRef, pullErr)
		}
		return nil
	}
	return nil
}
