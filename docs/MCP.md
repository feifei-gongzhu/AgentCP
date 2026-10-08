# Sorne MCP 入口（P5：外部 MCP 与扩展入口）

Sorne 以 MCP（Model Context Protocol）对外提供**同一套工具网关**（`tool_gateway`），
不创建第二套扫描后端。两类用法：

1. **Sorne 作为 MCP 服务器**：外部 MCP 客户端（Claude Code/Claude Desktop/
   任意 MCP 客户端）按同一契约驱动任务；同项目结果出现在 GUI。
2. **Sorne 作为 MCP 客户端**：把外部 MCP 服务器登记进项目注册表，按角色
   可见地供执行角色受控调用（`external_mcp_call`）。

> 实现说明：仓库运行时固定 Python 3.9（官方 `mcp` Python SDK 要求 ≥3.10），
> 因此协议层按官方规范（2025-06-18 版 transports/tools/lifecycle 章）在本仓库
> 自行实现（`src/sorne/mcp_protocol.py`、`mcp_server.py`、`mcp_client.py`），
> 已通过真实子进程/HTTP 往返测试（`tests/test_p5_mcp.py`）。

---

## 一、Sorne 作为 MCP 服务器

### 1. stdio transport

```bash
# <sorne-root> = Sorne 仓库根目录；project 显式绑定，role 为七角色之一
python3 <sorne-root>/sorne mcp stdio --project production-security --role recon
```

- **stdout 只输出 MCP 协议消息**（换行分隔 JSON-RPC），**日志全部走 stderr**——
  可被任何 MCP 客户端直接接管。
- 会话在启动时**显式绑定**（项目, 角色）：不存在默认项目、不读取 GUI 当前
  选中项目；两者都不合法时启动失败（stderr 报错、退出码 2、stdout 无输出）。
- 可见工具 = 角色白名单 ∩ 已实现能力（严格模式）；orchestrator/planner/
  reviewer 天然无扫描/网络工具；**不对外暴露无限制 shell**（迁移期旧角色
  含 Bash 兼容通路，一律拒绝建立 MCP 会话）。

#### Claude Code 客户端配置示例（可直接粘贴）

`~/.claude.json`（或对应客户端的 mcpServers 配置节）：

```json
{
  "mcpServers": {
    "sorne-recon": {
      "command": "python3",
      "args": [
        "/path/to/Sorne/sorne", "mcp", "stdio",
        "--project", "production-security", "--role", "recon"
      ]
    },
    "sorne-planner": {
      "command": "python3",
      "args": [
        "/path/to/Sorne/sorne", "mcp", "stdio",
        "--project", "production-security", "--role", "planner"
      ]
    }
  }
}
```

Claude Desktop（`claude_desktop_config.json`）同构：

```json
{
  "mcpServers": {
    "sorne-operator": {
      "command": "python3",
      "args": [
        "/path/to/Sorne/sorne", "mcp", "stdio",
        "--project", "production-security", "--role", "operator"
      ]
    }
  }
}
```

Windows 下把 `command` 换成 `py -3`，路径用仓库根 `sorne.cmd` 同级的
`sorne` 启动脚本调用方式（见 docs/WINDOWS.md）。

### 2. Streamable HTTP transport

```bash
# 默认只监听 127.0.0.1；端点 /mcp/{vendor}?role={role}
python3 <sorne-root>/sorne mcp serve --host 127.0.0.1 --port 8790 \
  --token "$SORNE_MCP_TOKEN" \
  --allowed-origin "http://localhost:5173"
```

- `--token`（或环境变量 `SORNE_MCP_TOKEN`）：Bearer Token 鉴权，缺省不鉴权
  （仅本机回环监听时）。
- `--allowed-origin`：浏览器 Origin 白名单（防 DNS rebinding；本地非浏览器
  客户端不发 Origin，不受影响）。
- 会话生命周期：`initialize` 响应携带 `Mcp-Session-Id`；后续请求必须携带；
  `DELETE` 终止会话；TTL 默认 120 分钟（`--session-ttl-minutes`）。
- 会话与端点项目绑定：把 A 项目的会话 ID 用到 `/mcp/B` 上会被拒绝（400）。
- 响应模式：POST 请求返回单个 `application/json` 响应（规范允许的两种
  服务端形态之一，所有 MCP 客户端必须支持）；本服务端无服务端主动流，
  GET 一律 405。SSE 流式按客户端兼容需求属后续扩展，不冒充已支持。
- 非回环地址监听且未配置 Token 时拒绝启动（工具网关暴露的是真实扫描与
  提交能力）。

#### curl 调用示例

```bash
BASE=http://127.0.0.1:8790/mcp/production-security?role=operator
AUTH="Authorization: Bearer $SORNE_MCP_TOKEN"

# 1) initialize（响应头拿 Mcp-Session-Id）
curl -sS -D headers.txt -X POST "$BASE" -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"curl","version":"0"}}}'
SID=$(awk -F': ' 'tolower($1)=="mcp-session-id"{gsub(/\r/,"");print $2}' headers.txt)

# 2) initialized 通知（202 Accepted）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE" -H "$AUTH" \
  -H "Mcp-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) 列工具（描述含用途/前置/副作用/参数/返回/失败类别六要素）
curl -sS -X POST "$BASE" -H "$AUTH" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 4) 调工具（与 GUI/内部角色走同一网关与提交链）
curl -sS -X POST "$BASE" -H "$AUTH" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"query_results","arguments":{"keyword":"登录"}}}'
```

### 3. 隔离与拒绝语义（§9）

- **项目隔离**：会话绑定项目后，所有工具只在绑定项目的 `ProjectStore` 上
  执行；参数里的 `project_id`/`vendor`/`role` 等服务端权威字段一律被丢弃
  并写入审计（`tool_calls.jsonl` 的 `dropped_server_fields`）。跨项目写入
  被结构性拒绝（测试：`test_stdio_cross_project_write_rejected_and_lands_in_bound_project_only`）。
- **不随 GUI 切换**：GUI 的当前项目是 webapp 的 per-request 查询参数，
  MCP 服务端从不读取；MCP 会话在存活期间恒指向启动时绑定的项目。
- **可见性强制**：不在角色可见集内的工具在协议层即返回 `-32602 Unknown
  tool`；在集内但越权（如目标不在授权范围）按工具执行错误返回
  （`isError: true` + 失败原文）。

---

## 二、Sorne 作为 MCP 客户端：外部 MCP 服务器注册表

每个项目一份注册表（`projects/<vendor>/mcp_servers/index.json`），条目包含
方案 §9 要求的全部字段：

| 字段 | 说明 |
|---|---|
| `transport` | `stdio` 或 `http` |
| `connection_config_ref` | 连接配置引用：连接参数存 `mcp_servers/connections/<id>.json`；秘密只允许环境变量**名**（`env_refs`/`header_env_refs`），绝不明文落盘 |
| `enabled` | 停用后任何角色调用都被拒 |
| `visible_roles` | 可见角色白名单，**服务端强制**：调用解析按 `(server_id, tool_name)` 精确匹配，重命名/别名/参数注入 role 都无法绕过 |
| `health` | `unknown/healthy/unhealthy` + 检查时间 + 延迟 + 详情（真实握手结果） |
| `tool_cache` | 最近一次 `tools/list` 缓存（工具名/描述/入参 Schema） |
| `registry_version` / `tool_cache.server_version` | 注册结构版本 / 外部服务器版本 |

### CLI（统一工具导入入口）

```bash
# 注册 stdio 外部服务器（示例：某 nmap MCP 包装器）
python3 sorne mcp register production-security \
  --id nmap-helper --name "Nmap 辅助" --transport stdio \
  --command "nmap-mcp-server" --arg "--portable" \
  --visible-role recon --visible-role operator

# 注册 http 外部服务器
python3 sorne mcp register production-security \
  --id burp-mcp --name "Burp MCP" --transport http \
  --url "http://127.0.0.1:9876/mcp" \
  --visible-role operator

# 真实握手健康检查 + 刷新工具缓存（不猜、不标假）
python3 sorne mcp health production-security --id nmap-helper

# 查看（含健康/工具缓存/版本）
python3 sorne mcp list production-security

# 移除
python3 sorne mcp remove production-security --id nmap-helper
```

### Web 控制台（同一入口的资源面板风格）

- `GET  /api/mcp/servers?vendor=…` 列表
- `POST /api/mcp/servers` 注册（body 含 id/name/transport/command|url/visible_roles/enabled）
- `POST /api/mcp/servers/health` `{vendor, id}` 刷新健康+缓存
- `POST /api/mcp/servers/enabled` / `visible-roles` / `remove`

### 角色如何调用外部工具

recon/crack/poc/operator 四个执行角色获得 `external_mcp_call` 能力
（orchestrator/planner/reviewer 的角色白名单**不含**该能力，运行时拒绝）：

```json
{"server_id": "nmap-helper", "tool_name": "nmap_scan",
 "arguments": {"target": "https://fixture.invalid/"}}
```

强制链：网关角色白名单 → 注册条目 `enabled` → `visible_roles` ∋ 会话角色
（角色来自运行时身份，参数注入无效）→ 工具存在性（缓存或实时握手）→
真实 MCP 调用透传。外部结果按普通工具输出对待，进入项目仍需统一提交链。

---

## 三、行为测试索引（§13.1-16）

`tests/test_p5_mcp.py`：

- stdio：stdout 只有协议、日志在 stderr；未初始化请求 `-32002`；版本协商
  （未知版本回落 `2025-06-18`、`2024-11-05` 原样返回）；缺角色/未知项目/
  旧角色启动失败且 stdout 干净。
- 会话绑定：多项目并存时会话恒返回绑定项目；写入只落绑定项目
  （`project_id`/`vendor` 夹带被丢弃并审计）；网关审计链证明同一后端。
- HTTP：401/403/404/405/202 语义；`MCP-Protocol-Version` 校验；会话跨端点
  复用拒绝；DELETE 生命周期；两项目会话互不串。
- 外部注册表：注册字段齐备、连接配置无明文秘密；真实握手健康+工具缓存
  +版本；`visible_roles`/`enabled`/重命名/别名/角色注入全部被服务端拒绝；
  http transport 同样真实握手。
- 工具描述六要素（用途/前置/副作用/参数/返回/失败类别）逐工具校验。
