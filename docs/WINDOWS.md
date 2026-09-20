# AgentCP Windows 版

## 系统要求

- Windows 10 22H2 或 Windows 11，x64。
- Python 3.11/3.12 x64；安装时勾选 `Add Python to PATH`。
- Docker Desktop，使用 WSL2 backend。默认的 `local-docker` Worker 依赖它。
- 建议至少 16 GB 内存和 20 GB 可用磁盘。首次构建 Worker 镜像耗时取决于网络。

建议将压缩包解压到较短的本地路径，例如 `C:\AgentCP`。不要直接在压缩包内运行，也尽量不要放在 OneDrive 同步目录中。

## 安装与启动

1. 解压 `AgentCP-Windows-v3.3.zip`。
2. 启动 Docker Desktop，等待状态变成 Running。
3. 双击 `Install-AgentCP.cmd`。它会创建独立的 `.venv-windows`、安装 Playwright/Windows 凭据组件，并安装 mrecon 使用的 Chromium。
4. 双击 `Start-AgentCP.cmd`。系统启动后会自动打开 `http://127.0.0.1:8765/frontend/`。
5. 停止系统时双击 `Stop-AgentCP.cmd`。

命令行用户也可执行：

```powershell
.\agentcp.cmd serve --host 127.0.0.1 --port 8765
.\agentcp.cmd automation-status 项目名
```

诊断环境：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\Test-AgentCP.ps1
```

## 数据与密钥迁移

发行 ZIP 不包含现有 `projects/`、证据文件或 API Key，防止把客户数据意外带入普通安装包。

需要迁移已有项目时：

1. 在原电脑停止 AgentCP。
2. 通过系统项目备份功能生成备份，或者把原安装目录下的 `projects` 文件夹复制到 Windows 版根目录。
3. 在 Windows 上重新填写各 Worker 的 API Key。macOS Keychain 内容不会导出；新密钥由 Windows Credential Manager 加密保存。

不要复制 `.agentcp-runtime`、`.agentcp-work`、`.control-plane.lock` 或 `.lifecycle-locks` 中的临时运行状态。

## Windows 运行差异

- AgentCP 控制面原生运行在 Windows；Worker 默认仍在 Docker Linux 容器中执行，因此 `/workspace`、`/target` 是容器内部路径。
- mrecon 优先使用已安装的 Chrome；没有 Chrome 时自动使用 Playwright Chromium。
- Docker 镜像由 Python 直接调用 `docker build`，不依赖 Git Bash、WSL Bash 或 `.sh` 脚本。
- Windows 进程清理由受控 PID 和 `taskkill /T` 完成，不会按进程名批量结束其他 Python 程序。
- 项目名禁止使用 `CON`、`NUL`、`AUX`、`COM1`、`LPT1` 等 Windows 保留设备名。

## 常见问题

Web 控制台能打开但 Worker 失败时，先运行 `windows\Test-AgentCP.ps1`。最常见原因是 Docker Desktop 未启动或 WSL2 内存不足。

端口 8765 被占用时：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\Start-AgentCP.ps1 -Port 8877
```

虽然 Python 层已强制 UTF-8，但部分 Docker Desktop/第三方 CLI 对超长路径仍不稳定。遇到挂载异常时请把系统移到 `C:\AgentCP`。
