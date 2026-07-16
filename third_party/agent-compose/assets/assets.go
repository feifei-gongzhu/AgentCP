package assets

import "embed"

//go:embed .codex .claude .claude.json .gitconfig
var DefaultHomeFS embed.FS
