package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/labstack/echo/v4"

	appconfig "agent-compose/pkg/config"
	domain "agent-compose/pkg/model"
	"agent-compose/pkg/workspaces"
)

type WorkspaceLoader func(ctx context.Context, workspaceID string) (domain.WorkspaceConfig, workspaces.FileWorkspaceContent, error)

type WorkspaceOptions struct {
	UploadLimitBytes int64
	Load             WorkspaceLoader
}

type WorkspaceFilesResponse struct {
	WorkspaceID string                 `json:"workspace_id"`
	Files       []workspaces.FileEntry `json:"files"`
}

func RegisterWorkspaceRoutes(app *echo.Echo, opts WorkspaceOptions) {
	base := "/api/agent-compose/workspaces"
	app.GET(base+"/:workspaceID/files", func(c echo.Context) error {
		workspace, content, err := opts.Load(c.Request().Context(), c.Param("workspaceID"))
		if err != nil {
			return ToWorkspaceHTTPError(err)
		}
		defer func() { _ = content.Root.Close() }()
		files, err := workspaces.ListFiles(content.Root)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		return c.JSON(http.StatusOK, WorkspaceFilesResponse{WorkspaceID: workspace.ID, Files: files})
	})
	app.POST(base+"/:workspaceID/upload", func(c echo.Context) error {
		limit := opts.UploadLimitBytes
		if limit <= 0 {
			limit = appconfig.DefaultWorkspaceUploadLimitBytes
		}
		if c.Request().ContentLength > limit {
			return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "workspace upload exceeds configured limit")
		}
		c.Request().Body = http.MaxBytesReader(c.Response(), c.Request().Body, limit)
		_, content, err := opts.Load(c.Request().Context(), c.Param("workspaceID"))
		if err != nil {
			return ToWorkspaceHTTPError(err)
		}
		defer func() { _ = content.Root.Close() }()
		fileHeader, err := c.FormFile("file")
		if err != nil {
			if IsHTTPRequestBodyTooLarge(err) {
				return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "workspace upload exceeds configured limit")
			}
			return echo.NewHTTPError(http.StatusBadRequest, "missing form file \"file\"")
		}
		uploadType := strings.ToLower(strings.TrimSpace(c.FormValue("upload_type")))
		targetPath := strings.TrimSpace(c.FormValue("path"))
		switch uploadType {
		case "", "file":
			if err := workspaces.StoreUploadedFile(fileHeader, content.Root, targetPath); err != nil {
				return ToWorkspaceUploadHTTPError(err)
			}
		case "archive":
			if err := workspaces.ExtractUploadedArchive(fileHeader, content.Root); err != nil {
				return ToWorkspaceUploadHTTPError(err)
			}
		default:
			return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("unsupported upload_type %q", uploadType))
		}
		files, err := workspaces.ListFiles(content.Root)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		return c.JSON(http.StatusOK, WorkspaceFilesResponse{WorkspaceID: c.Param("workspaceID"), Files: files})
	})
	app.GET(base+"/:workspaceID/download", func(c echo.Context) error {
		_, content, err := opts.Load(c.Request().Context(), c.Param("workspaceID"))
		if err != nil {
			return ToWorkspaceHTTPError(err)
		}
		defer func() { _ = content.Root.Close() }()
		relPath, err := workspaces.CleanRelativePath(c.QueryParam("path"), false)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		relPath = filepath.ToSlash(relPath)
		info, err := content.Root.Lstat(relPath)
		if err != nil {
			if os.IsNotExist(err) {
				return echo.NewHTTPError(http.StatusNotFound, err.Error())
			}
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return echo.NewHTTPError(http.StatusBadRequest, "download path must not be a symlink")
		}
		if info.IsDir() {
			return echo.NewHTTPError(http.StatusBadRequest, "download path must be a file")
		}
		file, err := content.Root.Open(relPath)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		defer func() { _ = file.Close() }()
		c.Response().Header().Set(echo.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", filepath.Base(relPath)))
		c.Response().Header().Set(echo.HeaderContentType, "application/octet-stream")
		return c.Stream(http.StatusOK, "application/octet-stream", file)
	})
}

func ToWorkspaceUploadHTTPError(err error) error {
	if err == nil {
		return nil
	}
	if IsHTTPRequestBodyTooLarge(err) {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "workspace upload exceeds configured limit")
	}
	return echo.NewHTTPError(http.StatusBadRequest, err.Error())
}

func IsHTTPRequestBodyTooLarge(err error) bool {
	if err == nil {
		return false
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return true
	}
	var httpErr *echo.HTTPError
	if errors.As(err, &httpErr) &&
		httpErr.Code == http.StatusBadRequest &&
		httpErr.Message == "http: request body too large" {
		return true
	}
	return err.Error() == "http: request body too large"
}

func ToWorkspaceHTTPError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return echo.NewHTTPError(http.StatusNotFound, message)
	case errors.Is(err, domain.ErrInvalidArgument), errors.Is(err, domain.ErrRequired):
		return echo.NewHTTPError(http.StatusBadRequest, message)
	default:
		return echo.NewHTTPError(http.StatusInternalServerError, message)
	}
}
