# Sorne（dsh 插件 · 全新工程）

持续探索型渗透测试 Agent 系统：在指定授权范围内长期运行，反复执行
「规划—执行—保存—验证—再规划」，同时向深处探索、向广处扩展，并在条件
变化后恢复旧方向。基于 dsh（DeepSeek Harness）二次开发的插件产品。

- 01 号唯一最高设计基线：[《基于分层记忆与持续探索的 Agent 系统设计方案》](</Users/thorneye/Documents/Codex/2026-11-03/xia/outputs/基于分层记忆与持续探索的Agent系统设计方案.md>)（只读原件）
- 当前施工与验收：[实施计划](docs/IMPLEMENTATION-PLAN.md)
- 历史施工蓝图：[docs/BLUEPRINT.md](docs/BLUEPRINT.md)（与 01 号文件冲突时以 01 号为准）
- 旧 Python 工程（/Users/thorneye/Documents/Sorne/Sorne）整代废弃，零迁移，仅保留产品名。

## 开发命令

```bash
npm run check   # 全部源文件 node --check（tools/check.mjs）
npm test        # check && node --test "test/*.test.mjs"（施工期统一门禁）
npm run ui      # 无真实 dsh 的 UI 测试宿主（默认 http://127.0.0.1:8898/）

> 注：`node --test` 的目录实参在 Node 22.23.2 会把目录当模块执行（MODULE_NOT_FOUND），
> 故门禁用带引号的 glob（Node runner 自行展开）；详见 docs/BLUEPRINT.md §1.2。
```

安装到 dsh 的步骤见 BLUEPRINT §10。
