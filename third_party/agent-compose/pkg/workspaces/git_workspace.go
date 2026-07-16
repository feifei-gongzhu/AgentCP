package workspaces

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	domain "agent-compose/pkg/model"
)

const GitWorkspaceTempDirName = ".agent-compose-git-clone"

type GitWorkspaceConfig struct {
	URL         string `json:"url"`
	Branch      string `json:"branch,omitempty"`
	Commit      string `json:"commit,omitempty"`
	Credential  string `json:"credential,omitempty"`
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	CloneTarget string `json:"path,omitempty"`
}

type gitWorkspace struct {
	workspace domain.WorkspaceConfig
}

func PrepareGitWorkspace(ctx context.Context, session *domain.Sandbox, workspace domain.WorkspaceConfig) error {
	return gitWorkspace{workspace: workspace}.Prepare(ctx, session)
}

func (w gitWorkspace) Prepare(ctx context.Context, session *domain.Sandbox) error {
	var cfg GitWorkspaceConfig
	if err := json.Unmarshal([]byte(w.workspace.ConfigJSON), &cfg); err != nil {
		return fmt.Errorf("decode workspace config %s: %w", w.workspace.ID, err)
	}
	cloneURL := strings.TrimSpace(cfg.URL)
	if cloneURL == "" {
		return fmt.Errorf("workspace config %s missing git url", w.workspace.ID)
	}
	cloneURL = ApplyGitCredentials(cloneURL, cfg)
	cloneTarget, err := NormalizeGitCloneTarget(w.workspace.ID, cfg.CloneTarget)
	if err != nil {
		return err
	}
	workspaceRoot := strings.TrimSpace(session.Summary.WorkspacePath)
	if workspaceRoot == "" {
		return fmt.Errorf("session %s missing workspace path", session.Summary.ID)
	}
	if err := os.MkdirAll(workspaceRoot, 0o755); err != nil {
		return fmt.Errorf("prepare workspace %s failed: create workspace root: %w", w.workspace.Name, err)
	}
	if err := cleanupGitCloneTempDir(workspaceRoot); err != nil {
		return fmt.Errorf("prepare workspace %s failed: %w", w.workspace.Name, err)
	}
	if cloneTarget == "." {
		if err := cloneGitWorkspaceRoot(ctx, workspaceRoot, cloneURL, cfg); err != nil {
			return fmt.Errorf("prepare workspace %s failed: %w", w.workspace.Name, err)
		}
		return nil
	}
	clonePath := filepath.Join(workspaceRoot, cloneTarget)
	if err := os.MkdirAll(filepath.Dir(clonePath), 0o755); err != nil {
		return fmt.Errorf("prepare workspace %s failed: create clone parent: %w", w.workspace.Name, err)
	}
	if err := gitClone(ctx, cloneURL, cfg, clonePath); err != nil {
		return fmt.Errorf("prepare workspace %s failed: %w", w.workspace.Name, err)
	}
	if err := gitCheckoutCommit(ctx, clonePath, cfg); err != nil {
		return fmt.Errorf("prepare workspace %s failed: %w", w.workspace.Name, err)
	}
	return nil
}

func NormalizeGitCloneTarget(workspaceID, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ".", nil
	}
	if filepath.IsAbs(trimmed) {
		return "", fmt.Errorf("workspace config %s has invalid clone path %q", workspaceID, trimmed)
	}
	clean := filepath.Clean(trimmed)
	if clean == "." {
		return ".", nil
	}
	parentPrefix := ".." + string(filepath.Separator)
	if clean == ".." || strings.HasPrefix(clean, parentPrefix) {
		return "", fmt.Errorf("workspace config %s has invalid clone path %q", workspaceID, trimmed)
	}
	return clean, nil
}

func cleanupGitCloneTempDir(workspaceRoot string) error {
	tempDir := filepath.Join(workspaceRoot, GitWorkspaceTempDirName)
	if err := os.RemoveAll(tempDir); err != nil {
		return fmt.Errorf("cleanup temp git clone dir: %w", err)
	}
	return nil
}

func cloneGitWorkspaceRoot(ctx context.Context, workspaceRoot, cloneURL string, cfg GitWorkspaceConfig) error {
	tempDir := filepath.Join(workspaceRoot, GitWorkspaceTempDirName)
	if err := gitClone(ctx, cloneURL, cfg, tempDir); err != nil {
		return err
	}
	if err := gitCheckoutCommit(ctx, tempDir, cfg); err != nil {
		_ = os.RemoveAll(tempDir)
		return err
	}
	if err := promoteClonedWorkspaceRoot(tempDir, workspaceRoot); err != nil {
		_ = os.RemoveAll(tempDir)
		return err
	}
	return nil
}

func promoteClonedWorkspaceRoot(tempDir, workspaceRoot string) error {
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return fmt.Errorf("read temp git clone dir: %w", err)
	}
	for _, entry := range entries {
		src := filepath.Join(tempDir, entry.Name())
		dst := filepath.Join(workspaceRoot, entry.Name())
		if err := MoveWorkspaceEntry(src, dst); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(tempDir); err != nil {
		return fmt.Errorf("remove temp git clone dir: %w", err)
	}
	return nil
}

func MoveWorkspaceEntry(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	srcInfo, err := os.Lstat(src)
	if err != nil {
		return fmt.Errorf("stat source workspace entry %s: %w", src, err)
	}
	dstInfo, err := os.Lstat(dst)
	if err != nil {
		return fmt.Errorf("move workspace entry %s to %s: %w", src, dst, err)
	}
	if !srcInfo.IsDir() || !dstInfo.IsDir() {
		return fmt.Errorf("move workspace entry %s to %s: destination already exists", src, dst)
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return fmt.Errorf("read source workspace directory %s: %w", src, err)
	}
	for _, entry := range entries {
		childSrc := filepath.Join(src, entry.Name())
		childDst := filepath.Join(dst, entry.Name())
		if err := MoveWorkspaceEntry(childSrc, childDst); err != nil {
			return err
		}
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("remove merged workspace directory %s: %w", src, err)
	}
	return nil
}

func gitClone(ctx context.Context, cloneURL string, cfg GitWorkspaceConfig, clonePath string) error {
	return runGitCommand(ctx, "", "git clone", GitCloneArgs(cloneURL, cfg, clonePath)...)
}

func GitCloneArgs(cloneURL string, cfg GitWorkspaceConfig, clonePath string) []string {
	args := []string{"clone", "--depth", "1"}
	if branch := strings.TrimSpace(cfg.Branch); branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, cloneURL, clonePath)
	return args
}

func gitCheckoutCommit(ctx context.Context, clonePath string, cfg GitWorkspaceConfig) error {
	commit := strings.TrimSpace(cfg.Commit)
	if commit == "" {
		return nil
	}
	// Fast path: fetch only the requested object so the clone stays shallow.
	// Works when commit is a full SHA or an exact ref name and the server allows
	// fetching it directly (e.g. uploadpack.allowReachableSHA1InWant).
	if err := runGitCommand(ctx, clonePath, "git fetch", GitCommitFetchArgs(commit)...); err == nil {
		return runGitCommand(ctx, clonePath, "git checkout", "checkout", "FETCH_HEAD")
	}
	// Fallback: the object could not be fetched directly. This happens for an
	// abbreviated SHA (git treats it as a ref name), a commit that is not a ref
	// tip, or a server that rejects by-SHA fetches. Deepen all branches and tags
	// so any reachable commit, abbreviated SHA, or tag resolves locally.
	if err := runGitCommand(ctx, clonePath, "git fetch", GitDeepenFetchArgs(true)...); err != nil {
		// --unshallow only applies to a shallow repo; retry without it.
		if err := runGitCommand(ctx, clonePath, "git fetch", GitDeepenFetchArgs(false)...); err != nil {
			return err
		}
	}
	return runGitCommand(ctx, clonePath, "git checkout", "checkout", commit)
}

func GitCommitFetchArgs(commit string) []string {
	return []string{"fetch", "--depth", "1", "origin", commit}
}

func GitDeepenFetchArgs(unshallow bool) []string {
	args := []string{"fetch"}
	if unshallow {
		args = append(args, "--unshallow")
	}
	return append(args, "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*")
}

func runGitCommand(ctx context.Context, dir, action string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	if strings.TrimSpace(dir) != "" {
		cmd.Dir = dir
	}
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		message = err.Error()
	}
	return fmt.Errorf("%s failed: %s", action, message)
}

func ApplyGitCredentials(cloneURL string, cfg GitWorkspaceConfig) string {
	trimmedURL := strings.TrimSpace(cloneURL)
	if trimmedURL == "" {
		return ""
	}
	credential := strings.TrimSpace(cfg.Credential)
	if credential == "" {
		user := strings.TrimSpace(cfg.Username)
		pass := strings.TrimSpace(cfg.Password)
		if user != "" || pass != "" {
			credential = url.QueryEscape(user) + ":" + url.QueryEscape(pass)
		}
	}
	if credential == "" {
		return trimmedURL
	}
	if strings.Contains(trimmedURL, "@") {
		return trimmedURL
	}
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(trimmedURL, prefix) {
			return prefix + credential + "@" + strings.TrimPrefix(trimmedURL, prefix)
		}
	}
	return trimmedURL
}
