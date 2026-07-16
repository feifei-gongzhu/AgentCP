package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultTimeout = 5 * time.Second

type Client struct {
	addr       string
	token      string
	httpClient *http.Client
}

func NewClient(config Config) *Client {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &Client{
		addr:       strings.TrimRight(strings.TrimSpace(config.Addr), "/"),
		token:      strings.TrimSpace(config.Token),
		httpClient: &http.Client{Timeout: timeout},
	}
}

func (c *Client) Configured() bool {
	return c != nil && c.addr != ""
}

func (c *Client) Status(ctx context.Context) Status {
	if !c.Configured() {
		return Status{Configured: false, OK: false, Status: "not_configured"}
	}
	var body octobusStatusResponse
	if err := c.getJSON(ctx, "/admin/v1/status", &body); err != nil {
		return Status{Configured: true, OK: false, Status: "error", Error: err.Error()}
	}
	status := body.Status
	if status == "" {
		status = "ok"
	}
	return Status{Configured: true, OK: true, Status: status, ServiceCount: uint32(body.Services)}
}

func (c *Client) ListCapsets(ctx context.Context) ([]Capset, error) {
	if !c.Configured() {
		return []Capset{}, nil
	}
	var body octobusCapsetsResponse
	if err := c.getJSON(ctx, "/admin/v1/capsets", &body); err != nil {
		return nil, err
	}
	out := make([]Capset, 0, len(body.Capsets))
	for _, item := range body.Capsets {
		out = append(out, Capset(item))
	}
	return out, nil
}

func (c *Client) Catalog(ctx context.Context, capsetID string) (Catalog, error) {
	if !c.Configured() {
		return Catalog{}, ErrNotConfigured
	}
	capsetID = strings.TrimSpace(capsetID)
	if capsetID == "" {
		return Catalog{}, fmt.Errorf("%w: capset_id is required", ErrInvalidCatalog)
	}
	var raw octobusCatalogResponse
	path := "/admin/v1/catalog/" + url.PathEscape(capsetID) + "?all=true"
	if err := c.getJSON(ctx, path, &raw); err != nil {
		return Catalog{}, err
	}
	return NormalizeCatalog(raw)
}

// CatalogMarkdown renders the gRPC capability guide for a capset as markdown,
// used as the injected guest CAPABILITIES.md.
func (c *Client) CatalogMarkdown(ctx context.Context, capsetID string) ([]byte, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	capsetID = strings.TrimSpace(capsetID)
	if capsetID == "" {
		return nil, fmt.Errorf("%w: capset_id is required", ErrInvalidCatalog)
	}
	path := "/admin/v1/catalog/" + url.PathEscape(capsetID) + "?format=md&grpc=true"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.addr+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/markdown")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("octobus returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (c *Client) getJSON(ctx context.Context, path string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.addr+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("octobus returned HTTP %d", resp.StatusCode)
	}
	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

var (
	ErrNotConfigured  = errors.New("octobus is not configured")
	ErrInvalidCatalog = errors.New("invalid capability catalog")
)
