# Sorne 六领域测试报告（功能 / 集成 / 界面 / 回归 / 模糊 / 压力）

- 报告日期：2026-10-08
- 数据来源：六领域测试执行结果与缺陷复核记录（由任务方提供的汇总 JSON）；测试资产文件清单经本机 `find /Users/thorneye/Documents/Agentcp/Sorne/testwf -type f` 实际核实（34 个文件，见第五章）。
- 本报告仅记录事实与证据；所有缺陷均经独立复核（运行复现 + 代码级确认，status=verified）。
- 全程铁律遵守：未外网访问、未使用真实模型、未触碰真实 `projects/` 数据与系统钥匙串（各领域 conftest 均做隔离）。

---

## 一、总体结论

1. **零回归**：基线原有套件 413 passed / 0 failed / 0 errors；全部测试工作结束后复跑原有套件仍为 413 passed / 0 failed / 0 errors。新增测试与各复现实验未破坏任何原有用例。
2. **新增测试全绿**：六领域合计新写 132 个测试项，实际执行 133 个用例（回归领域 9 个测试项经参数化展开为 10 个用例）：**114 passed、19 xfailed、0 failed、0 errors**。所有 xfail 均为已确认缺陷的固化用例（strict 保留，非跳过），按铁律随套件保留；`--runxfail` 独立证实其真实失败即对应缺陷。
3. **缺陷总账**：原始上报 11 条，按根因去重合并为 **9 条**（asset_inventory 两条合并为一条、evidence 冻结链路两条合并为一条，见第三章 D5、D6）。严重度分布：**高危 2、中危 6、低危 1**；全部 11 条原始上报的复核状态均为 verified。
4. **两起高危缺陷**：
   - `src/sorne/local_docker.py:456` 未定义变量 `process`（应为 `completed`）——Grok 兼容模式下每次 bash 工具调用成功执行后 100% 抛 NameError（D3）；
   - `src/sorne/database.py:630` ControlDatabase 并发冷初始化竞态——并发首次打开同一新库可写出重复 schema_meta 版本行，之后该控制库**永久损坏**（数据损坏级，D8）。
5. **服务稳定性边界**（限已测范围）：webapp catch-all（webapp.py:1350-1351）把处理异常统一映射为 400/404，模糊领域约 1200 个畸形载荷（含 2 万层嵌套炸弹）无一 5xx；压力领域 32 并发混合请求中"有响应的请求"无 5xx、无死锁。但传输层存在独立缺陷：listen backlog=5 导致并发突发下 78-89% 连接被重置且无任何 HTTP 响应（D9）；该问题发生在 HTTP 层之下，与 5xx 分开计量。
6. **数据边界声明**：上述结论仅覆盖已执行的测试范围；各领域明确列出的未覆盖项见第四章，不在本轮结论之内。

---

## 二、六领域执行结果表

| 领域 | 新写测试 | 通过 | xfailed | 失败/错误 | 结果（据各领域执行记录） |
|---|---|---|---|---|---|
| 功能 | 23 | 22 | 1 | 0 | `pytest testwf/functional/ -q` → 22 passed, 1 xfailed |
| 集成 | 8 | 8 | 0 | 0 | `pytest testwf/integration -q` → 8 passed in 3.71s |
| 界面 | 24 | 22 | 2 | 0 | `pytest testwf/ui/ -q` → 22 passed, 2 xfailed |
| 回归 | 9（参数化展开 10 用例） | 8 | 2 | 0 | `pytest testwf/regression -q` → 8 passed, 2 xfailed |
| 模糊 | 53 | 42 | 11 | 0 | `pytest testwf/fuzz -q` → 42 passed, 11 xfailed |
| 压力 | 15 | 12 | 3* | 0 | `pytest testwf/stress -q` → 12 passed（整套约 9-11s） |
| **合计** | **132 项 / 133 用例** | **114** | **19** | **0** | 新增测试合跑：114 passed, 0 failed, 0 errors |
| 基线/收尾原有套件 | — | 413 | — | 0 | 基线与最终均为 413 passed, 0 failed, 0 errors |

\* 压力领域 xfail 数为推算值：任务数据给出"新写 15、通过 12"且观察记录中明确列出三个 xfail 复现测试（`test_db_init_race.py`、`test_webapp_concurrency.py`、`test_backlog_burst.py`），15−12=3 与之吻合；且合计 114 passed = 22+8+22+8+42+12 精确成立，19 xfail 与 133 用例总数自洽。此字段非直接读取，特此注明。

xfail 与缺陷的对应：功能 1↔D1；界面 2↔D2（同一缺陷两个用例）；回归 2↔D3（参数化 returncode=0/3）；模糊 11↔D4/D5/D6/D7 六条原始缺陷的固化用例；压力 3↔D8（两个用例）与 D9（一个用例）。

---

## 三、缺陷清单（按根因去重合并后 9 条；原始 11 报）

> 每条含：位置 / 现象 / 证据 / 复核状态 / 严重度 / 建议。D5、D6 为同根因合并条目，注明各来源领域与原始上报。

### D1. /api/findings/review 非法裁决产生毒事件，阻塞同 finding 后续所有合法裁决
- **位置**：`src/sorne/webapp.py:1400`（关联链：quality.py:56-65、quality.py:100-102、database.py:2464-2465、database.py:2283-2289、projector.py:55）
- **现象**：同一 finding 上先提交一次非法人工裁决（如 action=confirmed）后，紧随其后的合法裁决返回上一次的旧错误并阻塞约 2 秒；指数退避下第三次合法请求阻塞 4.03 秒；毒事件重试窗口内该 finding 的所有后续裁决被阻塞，合法裁决从未落盘（human_verdicts.jsonl 0 条）。毒事件 5 次重试耗尽转 blocked 后自动解除阻塞，约 1 分钟内自愈。无数据损坏（append-only）。
- **证据**：复现（in-process AgentControlHandler）：① POST confirmed → (400, '不支持的人工裁决动作: confirmed', 0.02s)；② 随即合法 accepted+final_classification=vulnerability → (400, 同一旧错误, 2.01s)；③ 第三次 → (400, 同旧错误, 4.03s)；④ control_plane.db commit_events：毒事件 retry_wait/attempts=3，合法事件全部 pending/attempts=0。代码链逐行确认：webapp.py:1400-1418 无前置校验直接调 QualityLedger().review → quality.py:56-65 先 freeze_action 冻结事件（aggregate=human_verdict:finding_id）再 submit → 校验在投影器 _review_legacy（quality.py:100-102）抛 ValueError → database.py:2464-2465 入 retry_wait 且 available_at=now+2^attempts → database.py:2283-2289 同 aggregate 更早的 retry_wait 事件阻塞后续事件 → drain_until(projector.py:55) 同步返回旧错误 → webapp.py:1696-1697+69-70 统一转 400。交叉验证：`pytest testwf/functional/test_webapi_functional.py::test_findings_review_valid_request_after_invalid_one_on_same_finding` → 1 xfailed in 2.09s。
- **复核状态**：verified（独立复现脚本 + 代码级双重确认）
- **严重度**：medium
- **建议**（依据证据推导）：在 webapp.py:1400 调用 review 前对 action 做白名单前置校验快速返回 400；或将动作校验前移至 quality.py freeze_action 之前，保证校验失败不产生提交事件、不污染 aggregate 队列。

### D2. 攻击面页签清除筛选按钮 data-clear-tab="surfaces" 与配置键 surface 失配，按钮永不显示且点击无效
- **位置**：`frontend/index.html:254`（关联：app.js:674、app.js:691、app.js:2157-2159、state.js:20-24）
- **现象**：清除按钮与 FINDING_TAB_CONFIG 键 surface（单数）失配：按钮永远 hidden；即使手动显示，点击处理取 findingFilters["surfaces"] 为 undefined 直接 return。另两键 vulns/leads 均匹配，唯独此处失配。
- **证据**：`pytest testwf/ui/test_dom_contract_ui.py -v` → 3 passed, 2 xfailed；`--runxfail` 显示真实断言错误 "data-clear-tab 值 ['leads','surfaces','vulns'] 与 FINDING_TAB_CONFIG 键 ['leads','surface','vulns'] 失配"。代码确认：app.js:691 以 `.toolbar-clear[data-clear-tab="surface"]` 拼选择器命不中 index.html:254 的 surfaces 按钮；state.js findingFilters 仅有 vulns/leads/surface 键；grep 确认 app.js 与 frontend/modules/ 全文无 "surfaces" 字符串，无补救逻辑。
- **复核状态**：verified（运行复现 + 代码确认）
- **严重度**：medium
- **建议**（依据证据推导）：统一命名——index.html:254 改为 `data-clear-tab="surface"`，或同步把 app.js FINDING_TAB_CONFIG 与 state.js findingFilters 键改为复数；与另两个页签保持同构。修复后 test_dom_contract_ui.py 两个 xfail 转绿即可验证。

### D3. _run_compatibility_bash 引用未定义变量 process（应为 completed），Grok 兼容模式 bash 工具必然崩溃 【高危】
- **位置**：`src/sorne/local_docker.py:456`
- **现象**：返回行 `_redact(combined, ...), process.returncode != 0` 引用从未赋值的 `process`，Grok（openai-tools 兼容）模式下每次 bash 工具调用在成功执行之后的返回值构造处 100% 抛 NameError，把正常工具执行变成运行时故障。
- **证据**：代码级：local_docker.py:434 `completed = run_cancellable_process(...)`，:444/:446 均用 completed，:456 用 process；grep 全模块确认 `process` 仅在 620 行起的另一函数内局部定义、无全局定义。运行复现：`SORNE_PROJECTS_DIR=$(mktemp -d) .venv/bin/python -m pytest testwf/regression/test_reg_local_docker.py --runxfail -v` → 参数化两用例（returncode=0/3）全部 FAILED，输出精确为 `NameError: name 'process' is not defined`（src/sorne/local_docker.py:456）。调用链：local_docker.py:286 在 openai-tools 兼容路径下非空 bash 命令即调用该函数。
- **复核状态**：verified（代码级 + 运行复现双重确认）
- **严重度**：high
- **建议**（依据证据推导）：local_docker.py:456 将 `process.returncode` 改为 `completed.returncode`；修复后 test_reg_local_docker.py 两个 xfail 转绿即为验证。

### D4. kind 为列表/对象（不可哈希）时 TypeError 逃出 DriverError 转换通道
- **位置**：`src/sorne/worker_payload.py:58`（frozenset 定义于 schemas.py:48；转换通道 drivers.py:141-153）
- **现象**：模型返回 kind 为列表/字典时，对 VALID_WORKER_KINDS（frozenset）做成员判断抛 `TypeError: unhashable type` 而非 WorkerPayloadError；drivers._extract_json 仅把 WorkerPayloadError 转 DriverError，TypeError 原样上抛。_extract_json 共 5 处真实调用（drivers.py:250/412/454/479/498）均受影响。
- **证据**：复现：`extract_worker_json('{"kind": ["vuln_report"]}')` → TypeError: unhashable type: 'list'（dict kind 抛 unhashable type: 'dict'）；drivers 层传入同输入时 TypeError 原样逃出。对照组合法 kind 正常、可哈希非法 kind 正常转 DriverError——证明仅不可哈希类型逃逸。
- **复核状态**：verified（独立复现 + 代码确认）
- **严重度**：medium
- **建议**（依据证据推导）：worker_payload.py:58 成员判断前先 `isinstance(kind, str)` 校验（非 str 直接抛 WorkerPayloadError）；drivers.py:141-153 可选增加 TypeError 兜底归一为 DriverError。

### D5. normalize_asset_candidate 异常面不完整，两类畸形输入 ValueError 逃逸违反 None 契约，可致整份资产导入失败 【合并条目：同根因 2 报，均来自模糊领域】
- **位置**：`src/sorne/asset_inventory.py:94`（_safe_url 内 urlsplit）与 `:153-155`（端口 isdigit/int）；契约声明 :124，except 面 :129-132，传播链 :254 → :707 → :917-919
- **现象**：normalize_asset_candidate 声明返回 `NormalizedCandidate | None`，但两个解析点裸抛 ValueError 且 except 只捕 AssetImportError（其本身是 ValueError 子类，但普通 ValueError 不在捕获面内），异常逃逸违反契约。两个触发点（同根因：异常处理面不完整）：
  - **触发一（原报 :94，模糊领域）**：未闭合 IPv6 括号的 URL（如 `http://[::1`）→ urlsplit 抛 `ValueError: Invalid IPv6 URL`；_URL_RE(:30) 字符类不排除 `[`，自由文本中此类串会作为候选进入。
  - **触发二（原报 :153，模糊领域）**：Unicode No 类"数字"端口（如 `①①`、`²`，isdigit()=True 但 isdecimal()=False）→ int() 抛 `ValueError: invalid literal for int()`。
  - 后果：经 extract_asset_candidates 逃逸传播至 _import_rows（:707 无保护），:917-919 回滚并 raise——一份导入中任意一行命中即**整份导入失败，正常行一并丢失**（实测 asset_import_files 与 enterprise_assets 均为空）。
- **证据**：两个触发点均有独立复现脚本 + 端到端验证：`normalize_asset_candidate('http://[::1')` 与 `('example.com:①①')`、`('h:²')` 均抛 ValueError；对照组合法输入（`https://example.com`、`example.com:443`）正常、`ftp://x` 正确返回 None。端到端：临时项目内 import_file 混合正常行 + 坏行 → 抛非 AssetImportError 的 ValueError，正常资产行丢失。
- **复核状态**：verified（两条原始上报各自独立复现 + 代码确认）
- **严重度**：medium
- **建议**（依据证据推导）：normalize_asset_candidate 内对 urlsplit 与 int() 分别 try/except ValueError → return None（与其余失败路径一致），保证坏行跳过而非整份失败；或把 :129-132 的捕获面扩为 `except (AssetImportError, ValueError)`。对应保留测试：testwf/fuzz/test_asset_url_fuzz.py（xfail，修复后转绿）。

### D6. evidence 冻结链路异常捕获面过窄：NUL 与超长路径引发的 ValueError/OSError 均逃逸 freeze_if_valid 【合并条目：同根因 2 报，均来自模糊领域】
- **位置**：`src/sorne/evidence.py:57-59`（freeze_if_valid 捕获面仅 EvidenceReferenceError）与 `:26`（_SAFE_PATH_SEGMENT 无长度上限）；逃逸栈 :63→:135-137→:163→:198→:206；调用点 automation.py:1577-1583
- **现象**：freeze_worker_result_evidence 链路的 freeze_if_valid 只捕 EvidenceReferenceError，底层路径/文件系统 API 抛出的 ValueError/OSError 全部逃逸；异常发生在 automation.py:1577 处理模型输出时会使 complete_job 不执行。两个触发点（同根因：freeze 链路捕获面过窄）：
  - **触发一（原报 evidence.py:57，模糊领域，medium）**：evidence_path 含 NUL 字符 → Path.resolve() 抛 `ValueError: embedded null byte`；对照组 'evidence/nope.txt' 被安全降级原样返回。
  - **触发二（原报 evidence.py:26，模糊领域，low）**：300 字符 run_id 通过 _SAFE_PATH_SEGMENT 段校验（无长度上限）后，冻结真实证据文件时 mkdir 抛 `OSError: [Errno 63] File name too long`。可达性受限：正常 run_id 由 database.py:1058 生成为 14 字符，且 automation.py:1603 有 except Exception 兜底——故原报定级 low。
- **证据**：两触发点均有 traceback 级复现：NUL 路径异常自 evidence.py:154 resolve() 抛出、经 :57 逃出（isinstance(exc, EvidenceReferenceError)==False）；超长 run_id 异常自 :206 mkdir 抛出，调用栈逐帧 :63→57→163→198→206。
- **复核状态**：verified（两条原始上报各自独立复现）
- **严重度**：medium（合并条目取两原始上报中较高者；触发一可直接由模型输出 evidence_path 到达）
- **建议**（依据证据推导）：freeze_if_valid 捕获面扩为 `except (EvidenceReferenceError, ValueError, OSError)` 并降级返回原 payload（与既有安全降级路径一致）；_SAFE_PATH_SEGMENT 增加段长度上限；正则中显式排除 NUL。对应保留测试：testwf/fuzz/test_evidence_path_fuzz.py（xfail）。

### D7. validated_evidence_file 对超长文件名未捕获 OSError，违反返回 bool 契约
- **位置**：`src/sorne/evidence.py:226`（调用方 evidence.py:327/333/355 指标层）
- **现象**：对超长文件名路径 `path.is_file()` 抛 `OSError: [Errno 63] File name too long`（Python 3.9 pathlib 的 is_file 仅吞 ENOENT/ENOTDIR/EBADF/ELOOP），违反返回 bool 契约；EvidenceNormalizer.normalize 消费含超长名的 fact.evidence_path 时同样被击穿（evidence.py:327）。注：原报中"NUL 路径"半句经复核**不成立**——`'a\0b'.is_file()` 在 3.9 返回 False，契约保持。
- **证据**：运行复现（.venv Python 3.9.6，SORNE_PROJECTS_DIR 与 evidence root 均指向临时目录）：`validated_evidence_file(ev/'x'*300, ev)` 抛 OSError errno 63，栈经 pathlib.py:1446 stat 证实；normalize() 消费同路径同样抛。
- **复核状态**：verified（运行复现成立；NUL 半句经复核排除，如实记录）
- **严重度**：low
- **建议**（依据证据推导）：validated_evidence_file 以 try/except OSError 包裹 is_file() 并返回 False。对应保留测试：testwf/fuzz/test_evidence_path_fuzz.py（xfail）。

### D8. ControlDatabase 并发冷初始化竞态：schema_meta 重复行致控制库永久损坏 【高危】
- **位置**：`src/sorne/database.py:630-635`（SELECT→INSERT 非原子窗口；:546 isolation_level=None 自动提交；:561-563 schema_meta 无唯一约束；:634-635 多行即永久抛错且无修复路径）；受影响构造点 webapp.py:1035（/api/projects 每项目构造，:1059 仅捕 ProjectNotFound）、automation.py:434-435
- **现象**：并发首次打开同一新库时 SELECT schema_meta→INSERT 非原子，可写出重复版本行；之后该库**每次初始化都抛 RuntimeError（'schema_meta 必须且只能包含一条版本记录'），项目控制库永久损坏**（数据损坏级）。伴随的瞬时 'database is locked' 也以 400 暴露给客户端；webapp /api/projects 上 RuntimeError 逃逸致连接无响应断开（RemoteDisconnected）。
- **证据**：① 独立脚本 16 线程×30 轮 Barrier 并发冷构造（SORNE_PROJECTS_DIR 指向 /tmp 隔离）：复核轮 10 轮出现 schema_meta≥2 行（原报 6 轮，复现率更高），且每轮损坏后再次初始化 100% 抛 RuntimeError；② 官方复现测试 `testwf/stress/test_db_init_race.py::test_concurrent_cold_init_keeps_single_schema_meta_row` XFAIL，`--runxfail` 真实失败为并发初始化抛 OperationalError: database is locked；③ webapp 端到端：损坏库下 GET /api/project/state 与 /api/metrics 均返回 400 {error:'schema_meta 必须且只能包含一条版本记录'}，GET /api/projects 因捕获面不足而 RemoteDisconnected；32 并发首波风暴 12 轮中 1 轮出现 database is locked 400；in-process 探测日志该错误出现 272 次。所有运行未触碰真实 projects/ 与钥匙串，仓库零改动。
- **复核状态**：verified（独立脚本 + 官方 xfail 测试 + webapp 端到端三重复现，代码级逐行确认）
- **严重度**：high
- **建议**（依据证据推导）：initialize() 的 SELECT→INSERT 用 BEGIN IMMEDIATE 事务包裹，或 schema_meta 加唯一约束后 INSERT OR IGNORE；增加启动自愈路径（检测多行时收敛为单行最新版本而非永久抛错）；webapp.py:1059 捕获面扩至 RuntimeError 并返回 503 而非断连。对应保留测试：testwf/stress/test_db_init_race.py、test_webapp_concurrency.py（xfail）。

### D9. serve() 未设 request_queue_size，listen backlog=5，并发突发下 78-89% 连接被重置且无任何 HTTP 响应
- **位置**：`src/sorne/webapp.py:1728`（`ThreadingHTTPServer((host,port), AgentControlHandler)`，导入自 webapp.py:14）
- **现象**：socketserver 默认 backlog=5，32 路并发新连接突发下大量连接被 RST，客户端收 Connection reset/Broken pipe 且**无任何 HTTP 响应**；前端页面并行拉取多个 /api/* 即可瞬时超限。发生在 HTTP 层之下，与 5xx 分开计量。
- **证据**：三重复现：① 代码级——全文件 grep 无 request_queue_size 设置，实测默认值 5；② xfail 复现测试 `testwf/stress/test_backlog_burst.py` `--runxfail` 显示 100/128（78%）突发连接被重置（TRANSPORT:URLError，无 HTTP 响应）；③ 独立对照实验（与 serve() 完全相同构造、同 handler、32 并发×8=256 请求打无 DB 依赖的 /healthz）：backlog=5 → 228/256（89%）传输失败，backlog=64/256/1024 → 0/256 失败。实测失败率 78-89%，略高于原报 60-70%，同量级同方向。
- **复核状态**：verified（代码级 + xfail 测试 + 独立对照实验三重确认）
- **严重度**：medium
- **建议**（依据证据推导）：serve() 设置 `request_queue_size`（子类化 ThreadingHTTPServer 或构造前设类属性），对照实验显示 64 即可归零失败，建议 64-256。对应保留测试：testwf/stress/test_backlog_burst.py（xfail）。

### 合并说明（原始 11 报 → 9 条）

| 合并条目 | 原始上报 | 位置 | 来源领域 | 合并理由 |
|---|---|---|---|---|
| D5 | 报 1：IPv6 urlsplit ValueError | asset_inventory.py:94 | 模糊 | 同一函数 normalize_asset_candidate、同一契约（返回 None）、同一根因（except 只捕 AssetImportError，裸调用可抛 ValueError 的解析） |
| D5 | 报 2：Unicode No 类端口 int() ValueError | asset_inventory.py:153 | 模糊 | 同上 |
| D6 | 报 3：NUL 路径 ValueError 逃逸 | evidence.py:57 | 模糊 | 同一 freeze_worker_result_evidence 链路、同一逃逸点 freeze_if_valid（捕获面仅 EvidenceReferenceError），触发器不同（NUL vs 超长段） |
| D6 | 报 4：超长 run_id 段 ENAMETOOLONG OSError 逃逸 | evidence.py:26 | 模糊 | 同上（原报 low，因可达性受限；合并条目严重度取较高者 medium） |

其余 7 条原始上报（D1、D2、D3、D4、D7、D8、D9）根因互不相同，各自单列。D7 与 D6 同在 evidence.py 但函数不同（validated_evidence_file vs freeze_if_valid）、契约不同（bool vs None）、调用方不同（指标层 vs automation 冻结点），故未合并。

---

## 四、覆盖与未覆盖

### 已覆盖（要点）
- **功能**：CLI（init 完整结构恰好 19 个 JSONL + 黑板/目标/检查清单 + 授权锁定字段、add-fact 经 Guardian、approve-gate 四动作、complete-subtask 强制 awaiting_approval 并阻断 tick、config-gate 拒绝 0/负间隔）；Web（target 规范化含 mrecon 六参数边界钳制、hints 四种干预类型与非法输入 400、findings/review 六种裁决组合、directions dismiss/restore、metrics 各口径精确断言 + SORNE_SERVER_TOKEN 401/Bearer 200）。
- **集成**：五方向全覆盖转绿——完整 Run 生命周期、提交链两处恢复窗口（after_database_commit / after_jsonl_append 幂等去重 store.py:244）、候选收敛栅栏（human_directive_fence_rejected / stale_candidate_rejected）、CLI 与自动化共用 apply_worker_output 投影（同幂等键+冻结载荷重放不双计）、phase 单调推进与决策日志一一对应。
- **界面**：HTTP 层（302/200/no-store 三头、8 种路径探测全 404、/healthz、/readyz 11 键、/api/projects 字段与空隔离、API 错误可展示）；前端安全（全文仅一处 innerHTML 填静态 SVG 字典 app.js:2094、dom.js/toast 走 textContent、无内联事件与外链脚本）；dashboard 快照渲染 9 区块 + hostile 数据转义。
- **回归**：六个守护点——local_docker NameError（参数化 0/3）、claim_version 条件更新（含旧客户端 None 兼容）、supersede 单事务原子性、人工否决围栏、投影 OSError 补写幂等、回执窗口重放不双计。
- **模糊**：固定种子 SEED=20261008 全量可复现；四端点约 1200 畸形载荷（含 2 万层嵌套炸弹、随机二进制）无一 5xx/连接重置；脱敏有效；read_jsonl/find_json_objects/valid_project_name 契约稳定。
- **压力**：锁竞争（16 线程×25 append 400 行精确无异常）、队列 claim 双端点 8×80 无双认领、Projector 400 事件全 committed 且二次 drain 零新增、webapp 32 并发×8 混合、10k 行 JSONL 0.02s、10MB 上传边界（超限 0.010s 拒绝且不建目录、真实落盘 sha256 一致无 .part 残留）、删除屏障与活动计数无泄漏。

### 未覆盖（各领域如实列出，属本轮边界）
- **功能**：metrics 的 automation 分口径（runs/jobs/成功率，需真实运行数据）；/api/automation/* 启动-恢复-取消链路、team-presets、/api/target/upload 与 /api/assets/import 流式上传、WAF、前端 UI 交互（属集成/界面域或需真实模型运行）。
- **集成**：webapp HTTP 进程内层（test_webapp.py 模式）——本次五项任务均落在 engine/CLI/projector 交界；真实 mrecon HTTP 采集器被禁用（铁律），仅验证派发/回写链路；跨进程并发（两引擎同项目竞争）与 Windows 文件锁分支；WAF 分支止损与 JEV 影子分类等支线提交动作。
- **界面**：真实浏览器端到端交互（环境无真机浏览器，Playwright 未启用）——页签切换、筛选输入、抽屉开合仅以源码契约覆盖；POST 表单流程、键盘可达性、响应式断点（≤1639px 抽屉）未验证；前端 JS 未做语法级执行（node --check）与运行时单测；性能/并发压测不在本轮范围。
- **回归**：local_docker 其余路径（OpenAI 传输重试、Claude 兼容执行 _execute）——超出指定回归点范围；方向语义并发真线程交错（沿用仓库确定性注入风格）；ProjectorManager 后台线程轮询兜底（与基线套件同口径，只测显式 recover）；needs_review 复核计数与背压高水位（基线 413 例已密集覆盖，回归价值低）。
- **模糊**：CSV/XLSX 导入解析器（zip 炸弹、Sniffer 方言探测）字节级模糊；仅模糊任务指定的 4 个 POST 端点（GET 端点、/api/assets/import 二进制上传、/api/team/run 未覆盖）；未用真实模型或外部网络；Windows 保留名仅逻辑层断言，未在真实 Windows 文件系统验证；evidence 冻结并发竞态与 digest sidecar 校验分支未覆盖。
- **压力**：跨进程（fcntl flock）锁竞争仅经同进程多线程间接覆盖，未做真多进程压测；Windows msvcrt 锁路径未覆盖（本机 macOS arm64）；mock 模型驱动的 AutomationEngine 多并发运行（engine.start/run 全链路）未压测（任务聚焦存储锁/队列/投影/web 层）；HTTP 层真实 10MB 网络传输未做（以内存流直调产品校验函数替代，已在测试内说明）；事件规模取 400（任务区间 300-500 内），未做 >500 极限。

---

## 五、新增测试资产

### 文件清单（34 个文件，经 `find /Users/thorneye/Documents/Agentcp/Sorne/testwf -type f` 于 2026-10-08 实际核实）

**testwf/functional/（3 个）**
- conftest.py（照抄 tests/conftest.py 钥匙串隔离 + SORNE_PROJECTS_DIR/PROJECTS 双重隔离）
- test_cli_functional.py
- test_webapi_functional.py（Web 用 in-process AgentControlHandler，不起子进程不占端口）

**testwf/integration/（5 个）**
- conftest.py
- test_candidate_fences.py
- test_commit_recovery_windows.py
- test_full_run_lifecycle.py
- test_shared_projection_and_phase.py

**testwf/ui/（5 个）**
- conftest.py（钥匙串隔离 fixture + SORNE_PROJECTS_DIR setenv + 模块 PROJECTS 双保险；live_server 夹具子进程启动 `sorne serve --port 28765`，teardown terminate→wait→kill，运行后 lsof 确认无残留）
- test_dashboard_snapshot.py
- test_dom_contract_ui.py
- test_frontend_security.py
- test_http_behavior.py

**testwf/regression/（4 个）**
- conftest.py
- test_reg_direction_semantics.py
- test_reg_local_docker.py
- test_reg_projection.py

**testwf/fuzz/（7 个）**
- conftest.py
- test_asset_url_fuzz.py
- test_evidence_path_fuzz.py
- test_platform_paths_fuzz.py
- test_store_jsonl_fuzz.py
- test_webapp_json_fuzz.py
- test_worker_payload_fuzz.py

**testwf/stress/（9 个）**
- conftest.py（独立：钥匙串 mock + SORNE_PROJECTS_DIR/tmp 隔离 + 模块级 PROJECTS 补丁）
- test_backlog_burst.py
- test_db_init_race.py
- test_deletion_barrier.py
- test_large_io.py
- test_lock_contention.py
- test_projector_stress.py
- test_queue_contention.py
- test_webapp_concurrency.py

### 运行命令（任一领域可单独执行；xfail 为缺陷固化用例，属预期结果）

```
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/functional -q
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/integration -q
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/ui -q
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/regression -q
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/fuzz -q
/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf/stress -q
```

六领域合跑：`/Users/thorneye/Documents/Agentcp/Sorne/.venv/bin/python -m pytest testwf -q` → 114 passed, 19 xfailed, 0 failed, 0 errors（xfail 即 9 条合并缺陷的固化用例，按铁律保留）。

> 注：本清单中的命令为各领域报告所载的执行命令；本报告撰写时仅核实了文件清单真实存在，未在撰写环节重跑套件（执行结果数据以各领域报告为准）。

---

*报告完。缺陷共 9 条（合并自 11 报）：high 2（D3、D8）、medium 6（D1、D2、D4、D5、D6、D9）、low 1（D7），全部 verified。*
