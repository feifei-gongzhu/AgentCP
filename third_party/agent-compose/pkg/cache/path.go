package cache

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

var ErrUnsafePath = errors.New("unsafe runtime cache path")

type SafePath struct {
	Root            string
	Target          string
	CanonicalRoot   string
	CanonicalTarget string
	CanonicalParent string
}

func ValidateCachePath(root, target string) (SafePath, error) {
	root = strings.TrimSpace(root)
	target = strings.TrimSpace(target)
	if root == "" || target == "" {
		return SafePath{}, fmt.Errorf("%w: root and target are required", ErrUnsafePath)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return SafePath{}, fmt.Errorf("%w: absolute root: %v", ErrUnsafePath, err)
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return SafePath{}, fmt.Errorf("%w: absolute target: %v", ErrUnsafePath, err)
	}
	if !pathWithinRoot(absRoot, absTarget) {
		return SafePath{}, fmt.Errorf("%w: target %s is outside root %s", ErrUnsafePath, absTarget, absRoot)
	}
	canonicalRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return SafePath{}, fmt.Errorf("%w: canonical root: %v", ErrUnsafePath, err)
	}
	canonicalTarget, err := filepath.EvalSymlinks(absTarget)
	if err != nil {
		return SafePath{}, fmt.Errorf("%w: canonical target: %v", ErrUnsafePath, err)
	}
	canonicalRoot = filepath.Clean(canonicalRoot)
	canonicalTarget = filepath.Clean(canonicalTarget)
	if canonicalTarget == canonicalRoot {
		return SafePath{}, fmt.Errorf("%w: refusing to target root %s", ErrUnsafePath, canonicalRoot)
	}
	if !pathWithinRoot(canonicalRoot, canonicalTarget) {
		return SafePath{}, fmt.Errorf("%w: canonical target %s is outside root %s", ErrUnsafePath, canonicalTarget, canonicalRoot)
	}
	parent := filepath.Dir(canonicalTarget)
	if !pathWithinRoot(canonicalRoot, parent) {
		return SafePath{}, fmt.Errorf("%w: canonical parent %s is outside root %s", ErrUnsafePath, parent, canonicalRoot)
	}
	return SafePath{
		Root:            absRoot,
		Target:          absTarget,
		CanonicalRoot:   canonicalRoot,
		CanonicalTarget: canonicalTarget,
		CanonicalParent: parent,
	}, nil
}

func EstimateSize(path string) (uint64, []string) {
	var size uint64
	var warnings []string
	path = strings.TrimSpace(path)
	if path == "" {
		return 0, AppendWarnings(warnings, "size walk skipped: path is empty")
	}
	err := filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			warnings = AppendWarnings(warnings, fmt.Sprintf("size walk %s: %v", current, walkErr))
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			warnings = AppendWarnings(warnings, fmt.Sprintf("size stat %s: %v", current, err))
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !info.IsDir() {
			size += uint64(info.Size())
		}
		return nil
	})
	if err != nil {
		warnings = AppendWarnings(warnings, fmt.Sprintf("size walk %s: %v", path, err))
	}
	return size, warnings
}

func AppendWarnings(existing []string, warnings ...string) []string {
	out := append([]string(nil), existing...)
	for _, warning := range warnings {
		warning = strings.TrimSpace(warning)
		if warning == "" {
			continue
		}
		out = append(out, warning)
	}
	return out
}

func pathWithinRoot(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != "" && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
