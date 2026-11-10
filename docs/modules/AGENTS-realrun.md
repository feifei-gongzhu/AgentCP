# AGENTS-realrun 竣工记录 —— AI 运行时真实可用性（DeepSeek flash 联调）

> 施工者只写本文件与自己独占的代码/测试文件；蓝图（../BLUEPRINT.md）是冻结契约，
> 与实现冲突时先停工上报架构师，不得就地改契约。
> 本记录是 docs/modules/AGENTS.md 的第 3 轮打磨增量记录（该文件保留第 2 轮内容）。

## 1. 基本信息

- 模块 ID / 阶段：AGENTS-realrun / 第 3 轮（AI 运行时真实可用性；跨 §21 阶段 C–E）
- 负责规范章节：§3.1/§3.2（AI 决策与程序保障边界）、§10.1/§10.2（意图完成语义/执行与工具网关）、
  §13/§18.3（证据固定与完整依据层）、§16.1/§16.4（唤醒、等待不空转）、§11.1（幂等提交）、
  §17（范围逐跳校验，沿用 C2）
- 独占文件（本任务卡 write_scopes；未增删）：
  - 修复：lib/agents/model.mjs、loop.mjs、worker.mjs、planner.mjs、runtime.mjs
  - 核查未改：lib/agents/orchestrator.mjs、verifier.mjs（P0 修复不需要改；线格式修复在 model.mjs 统一生效）
  - 新增：tools/mock-target.mjs（只绑 127.0.0.1 的本地故意漏洞靶标）
  - 测试：test/agents.test.mjs（迁移 + 增断言）、test/agents-realrun.test.mjs（新增 8 用例）
  - 本记录：docs/modules/AGENTS-realrun.md
- **未修改** lib/store/intents.mjs、lib/store/attempts.mjs（任务允许「必要最小改动」）：完成闭环直接复用
  既有 reviewCompletion/transitionIntent，不新增存储语义，也不改动 attempts.test.mjs:712
  「完成建议不自动改意图状态（C1/AI 语义域）」这条既有领域断言——闭环接线放在 agent 层（见 §2.4）。
- 开工日期 / 竣工日期：2026-11-06 / 2026-11-06

## 2. 实现范围

### 2.1 P0-1 多步工具调用线格式（真实 DeepSeek 已验证旧实现必失败）

- 事实（修复前）：normalizeAssistantMessage 产出 {id,name,arguments:对象}；loop 把该形状原样回灌进
  messages；httpProvider.chat 用 {...m} 透传 ⇒ 第二步请求给上游的 assistant.tool_calls 缺 type、
  缺 function 包装、arguments 是对象。
- 实测（curl，2026-11-06，模型 deepseek-flash，key 不落盘不回显）：
  - 标准形状 + tools：HTTP 200，返回 tool_calls:[{index:0,id,type:function,function:{name,arguments:JSON字符串}}]，
    finish_reason=tool_calls；
  - assistant.tool_calls + role=tool 再问：HTTP 200（多步回灌可用）；
  - **旧实现的形状**（无 type、name/arguments 在顶层、arguments 为对象）：HTTP 422
    Failed to deserialize the JSON body into the target type: messages[1]: missing field type。
- 修复：
  - lib/agents/model.mjs 新增并导出 toWireMessages(messages)（L70 起）：assistant →
    {role,content,tool_calls:[{id,type:function,function:{name,arguments:JSON字符串}}]}；
    tool 消息只保留 {role:tool,tool_call_id,content}（剥离内部 name）；其它角色只留 role/content。
    httpProvider.chat 的 messages 统一经 toWireMessages（L119）。
  - lib/agents/loop.mjs（L77-L96）：assistant 消息保留**全部** tool_calls；超出 maxToolCallsPerStep
    的调用不执行，但为每个 id 回一条 tool 消息（RESOURCE_LIMIT + next_requirements，trace 标
    skipped:true），不再产生悬空 tool_call id。
  - 回归：test/agents-realrun.test.mjs 用例 1/2/3（严格校验服务器按 DeepSeek 422 行为校验
    type/function/arguments 字符串/每个 id 有 tool 应答；旧形状会被该服务器拒绝）；真实模型全链路
    43 次调用无 provider_error（§3.1）。

### 2.2 P0-2 Worker 证据完整性（§13/§18.3）

修复前：http_probe 只留 body 前 2000 字符 + 前 30 个响应头；store_evidence 固定的是含摘要的 JSON；
raw_body 只是标签。修复后（lib/agents/worker.mjs）：

| 项 | 实现（行号） |
|---|---|
| 完整原始响应字节 | executeHttpProbe 用 res.arrayBuffer() → Buffer（L134-L201），不经 res.text()；记录 body_sha256、body_bytes |
| 全量响应头 | headersToArray 保留全部头与重复头（多个 Set-Cookie 经 getSetCookie() 逐个保留），不截断条数 |
| 字符集 | 从 Content-Type 解析 charset（gb2312→gbk），TextDecoder 解码摘要；观察里注明 body_charset、body_charset_declared、body_charset_supported、body_charset_note。**Node v22.23.2 实测 TextDecoder 支持 gbk/gb18030**（解码「你好」正确）；不支持时保留原始字节并按 utf-8 尽力解码且如实标注 |
| raw_body 表示 | 逐字节固定真实响应体（Buffer），expectedSha256 用响应体哈希；另固定请求记录（request_record）与全量响应头（derived）作为 capture 的 request_ref/response_headers_ref（完整依据层） |
| exchange_record 表示 | 固定完整 JSON：schema=sorne.exchange_record/v1、请求元数据、全量响应头、响应体（文本按 charset 解码；含 NUL/二进制用 base64）、body_sha256/body_bytes/timing（L236-L270） |
| 上限与截断 | 仅响应体超过 MAX_EVIDENCE_BYTES = 64 MiB（L45）才显式截断，并写 truncated/cap_bytes/kept_bytes/omitted_bytes/truncation_note，绝不静默丢字节 |
| 表示唯一性/幂等 | 同一 tool_call 只允许一种表示（C2 采集按 tool_call_id 去重，§13）；同表示重复调用幂等返回原 Blob/Capture；换表示给出 PRECONDITION_INVALID + next_requirements |
| 模型上下文边界 | 模型只看摘要（MAX_CONTEXT_BODY_CHARS=2000 字符 + 头数组），完整字节留在进程内供证据固定（避免上下文爆量） |

回归：
- test/agents-realrun.test.mjs 用例 5：raw_body 读回字节与运行后重新 GET 的真实响应**逐字节相等**；
  capture.request_ref/response_headers_ref 均非空；GBK 页面 body_charset=gbk、body_charset_supported=true、
  摘要含「你好」。
- 用例 6：exchange_record 对 application/zip 二进制保存 base64，解码后与真实响应逐字节相等；
  全量头 ≥3；body_sha256 等于真实响应哈希。
- test/agents.test.mjs Worker 用例：exchange_record 的 body_text 是完整 /sorne/health JSON
  （含 db/outbox 字段），body_bytes 等于完整文本字节数（旧实现只有摘要 JSON，无法通过）。

### 2.3 P0-3 提交幂等（确定性 submission_id）

- worker.mjs L73 deterministicSubmissionId(prefix, parts) = prefix + sha256(stableJson(parts)).slice(0,32)。
  submit_findings 的键输入 = {project_id, attempt_id, operations}；planner.mjs 的 submit_plan 键输入 =
  {project_id, plan_run_id, plan_revision, rationale, intents}。
- 效果：同一 Attempt 同一内容重复提交 → 同 submission_id + 同 request_digest → A1
  submit()（record-service.mjs L853-L863）返回**原回执**，不重复建观察/假设/漏洞；
  planner 同 run 同 revision 重发也返回原回执（不同内容仍被 C1 的 UNIQUE/IDEMPOTENCY_KEY_REUSED 拒绝）。
- 回归：agents-realrun 用例 5 连续两次 submit_findings 同内容 → submission_id/ids 相同、
  observations 仅 1 条；planner 侧由既有 intents.test「幂等接收」用例继续覆盖。
- 说明：worker 的 note 字段在工具 schema 里改称「本批提交说明（不参与幂等键）」，避免误导模型。

### 2.4 P0-4 意图完成闭环（真实运行停摆点）

**复现（Lead + 本机双重复现）**：Planner 建意图是 proposed（领域语义，测试钉死不可改），
E1 orchestratorOverview.wake_signals.dispatchable_intents 只数 queued ⇒ Orchestrator 看到 0 可派发、
attempts 为空；即使派发，C2 completion 只置 Attempt，transitionIntent/reviewCompletion 在生产
无调用方 ⇒ 意图永不 resolved，项目停摆。

修复（不改 C1/C2 存储语义，全部在 agent 层）：

1. runtime.mjs L96-L135 admitProposedIntents + L256 接线：runOnce 在 Orchestrator 之前做**队列准入**，
   把「proposed 且从未有 Attempt」的意图 activate（proposed→queued，§10.1 合法链路，actor=runtime）。
   程序只做队列记账，不选方向、不派发；派发仍由 Orchestrator AI 的 assign_execution 决定。
   每轮最多 8 条；失败逐条忽略不阻断本轮。
2. worker.mjs L206-L234 ensureIntentRunning：执行开始时把意图推进 proposed→queued→running
   （已 running/awaiting_review/resolved 不改写；blocked/deferred 交协调 AI，不写死重试）。
3. worker.mjs report_progress（L700-L780 一带）：completion 落定 Attempt 后由程序调
   reviewCompletion（C1 语义）复核意图完成：
   - AI 提供 deliverables_proof（每项 index/key + 真实 record_ids）→ 交付物齐备则 resolved +
     intent.completed 事件；齐备性/存在性仍由 C1 校验；
   - AI 未带证明被拒时，程序用**本次执行最近一次 A1 提交回执里的真实编号**兜底重试一次
     （来源标注 auto_from_latest_submission，不伪造记录）；
   - 意图未声明交付物 → awaiting_review（一句完成不能直接 resolved，既有领域语义不变）；
   - late 的重复 completion 允许补做复核（否则一次缺证明的完成会让意图永久 running）。
4. planner.mjs：submit_plan 的 intents[] 新增 deliverables 字段并在 system 提示中要求「每意图至少声明
   1 项必要产物」；供给面新增 project_scope（可执行目标 URL 来源）并要求 question 含具体目标。

选择理由（相对候选方案）：不改 receivePlanRevision 的默认状态（不会破坏 agents.test:153、
intents.test 对「新建意图=proposed」的断言）；不改 dispatchAttempt（不会破坏 attempts.test:712）；
不改 E1（不在 write scope）；派发/方向仍是 AI 决策；完成判定仍走 C1 校验。

回归：agents-realrun 用例 7：带 deliverables_proof 的完成 → completion_review.decision=resolved、
意图 resolved、outbox 有 intent.completed；未声明交付物 → awaiting_review 且意图状态一致。
真实模型全链路：3/3 意图 resolved（§3.1）。

### 2.5 P0-5 真实联调（DeepSeek flash + 本地靶标）

- tools/mock-target.mjs（新增，117 行）：只绑 127.0.0.1，端点 /、/health、/admin（故意未鉴权 +
  两个 Set-Cookie）、/api/echo、/robots.txt、/gbk（GBK 字节）、/backup.zip（二进制）、404 回显路径；
  支持 startMockTarget({port:0}) 供测试复用；拒绝绑定非 127.0.0.1。
- 真实模型配置：<dataDir>/llm.json（M2 通道，store>env；本次用 sorne-data/llm.json 复制到临时数据目录，
  key 不回显、不写仓库，运行结束删除副本）。

## 3. 验证

### 3.1 真实模型全链路（本机实测，2026-11-06 04:07:45–04:10:52 UTC / 12:07–12:10 +08）

- 环境：node v22.23.2；model=deepseek-flash @ https://api.deepseek.com（key 不打印）；
  tools/mock-target.mjs 随机端口 http://127.0.0.1:55294；独立临时数据目录（非 sorne-data，未访问外网）。
- 结果（evidence-summary.json 摘录）：
  - project PRJ-0002（临时库内编号）；plan_run PR-PRJ-0002-0002 received；plan_revision
    PLAN-PRJ-0002-0001 r1 accepted；
  - intents：I-PRJ-0002-0001/0002/0003 **全部 resolved**（基线采集 / /admin 匿名访问 / 认证一致性）；
  - attempts：ATT-0002(I-0001, worker-1)、ATT-0003(I-0002, worker-1)、ATT-0004(I-0003, worker-2)
    全部 completed；
  - 11 个 http_probe tool_calls 全部 succeeded（evidence_refs 成对 CAP-/B-）；
  - blobs 11（全 exchange_record、storage_status=fixed）；captures 11（integrity=verified）；
    observations 11（含 /admin 未授权 200 + 双 Set-Cookie、硬 404 对照特征、认证一致性矩阵）；
  - worker_reports：WR-0002 completion handled，WR-0003/0004 pending（intent resolved 后停机，下一轮唤醒处理）；
  - orchestration_decisions 4 条、actions 9 条全部 executed（request_planning、assign_execution×3、
    set_execution_limits、handle_report accepted、record_strategy×2）；
  - 43 次真实 LLM 调用（日志 token 示例：prompt 18,984 / completion 4,078），**无 provider_error**
    ⇒ 多步线格式修复生效；
  - 队列准入日志原文：队列准入：意图置 queued I-PRJ-0002-0003、I-PRJ-0002-0002、I-PRJ-0002-0001，
    随后同轮 Orchestrator 下达 3 个 assign_execution（ATT-0002/3/4）。
- 证据字节核对（程序化，11/11 全过）：
  - 读回 Blob 的 sha256 == 登记 sha256（11/11）；
  - exchange_record.response.body_sha256 == 运行后重新 GET 同一 URL 的 body sha256（11/11，证明保存的是
    完整真实响应而不是摘要）；
  - headers_count 8–10（全量头），charset=utf-8（本轮目标均为 utf-8；gbk 由用例 5 覆盖）；
  - 本轮 AI 均选择 exchange_record（raw_body 由用例 5/6 确定性覆盖，见 §5-1）。

### 3.2 门禁与测试（原文尾部）

- node --test test/agents.test.mjs → # tests 10 / # pass 10 / # fail 0
- node --test test/agents-realrun.test.mjs（默认，不联网）→
  # tests 8 / # pass 7 / # fail 0 / # skipped 1（第 8 例为 SORNE_REALRUN 门控）
- SORNE_REALRUN=1 node --test test/agents-realrun.test.mjs →
  # tests 8 / # pass 8 / # fail 0 / # skipped 0（真实模型用例 87,811 ms 通过）
- node --test test/intents.test.mjs test/attempts.test.mjs test/orchestrator.test.mjs test/e2e-lifecycle.test.mjs
  → # tests 70 / # pass 70 / # fail 0（任务卡要求的相关回归全绿）
- 全量门禁 npm test（check + 全部测试，2026-11-06 本机）：
  # tests 539 / # pass 538 / # fail 0 / # cancelled 0 / # skipped 1
  （唯一 skipped = 真实模型门控用例；check.mjs 通过）

### 3.3 curl 直测证据（DeepSeek flash，档位核实）

- tools 支持：200 + 标准 tool_calls（见 §2.1）；
- 多步 tool 回灌：assistant.tool_calls + role=tool 再问 → 200；
- 旧线格式负例：422 messages[1]: missing field type；
- 结论：deepseek-flash 支持 tools 与多步 tool 消息，本次修复必需且可验证。

### 3.4 复现命令

    # 确定性回归（不联网，无需凭据）
    node --test test/agents-realrun.test.mjs

    # 真实模型全链路（需 sorne-data/llm.json；自建 mock 靶标，不访问外网）
    SORNE_REALRUN=1 node --test test/agents-realrun.test.mjs

## 4. 自查

- [x] 未修改任何冻结共享文件（index.js、client.js、test-ui-server.mjs、lib/db.mjs、lib/http.mjs、
      lib/errors.mjs、lib/router.mjs、lib/routes/ui.routes.mjs、test/helpers.mjs、test/smoke.test.mjs、
      迁移 0001–0005）
- [x] 未修改前端文件（lib/ui/**、页面、client.js）
- [x] 未修改同阶段其他模块文件；lib/store/intents.mjs、attempts.mjs 未改（原因见 §1）
- [x] 测试并行安全：真实模型用例使用独立 mkdtemp + 随机端口 + finally 关服务/删目录；不改全局 env
      （env 用例 finally 恢复）；不访问外网靶标；不触碰 ~/.sorne
- [x] 无 501 桩相关变更；职责内端点未改
- [x] 语义纪律：无交付物完成仍 awaiting_review；resolved 只表示该版本问题已处理；unknown/租约/范围
      校验仍由 C2 拒绝路径覆盖（既有 attempts/e2e 用例全绿）

## 5. 偏差与已知问题

1. **真实模型本轮均选择 exchange_record**（未选 raw_body）：raw_body 的逐字节一致性由确定性用例 5
   （GBK 页面）与用例 6（二进制）覆盖，不依赖模型偏好；两表示都满足「完整真实证据」。
2. **Worker 步数上限**：ATT-0002 用满 14 步（探测了 /、robots.txt、favicon.ico、随机 404、/health 等），
   stop_reason=max_steps 但 completion 已在步内提交、Attempt 正常 completed。侦察面扩大时步数上限
   会限制覆盖（程序资源边界，符合 §3.2；后续可按意图 budget 调整）。
3. **队列准入是 agent 层对 E1 信号的偿付**：wake_signals.dispatchable_intents 仍只数 queued；建议后续
   在 E1 侧改为统计 proposed+queued（不在本次 write scope，未改）。当前效果等价且可观测（runOnce summary
   的 queue_admission 字段 + 日志）。
4. **无交付物意图的终局**：Planner 未声明 deliverables 时，完成只能到 awaiting_review；目前没有
   「复核者」工具/动作（transitionIntent resolve 仍无生产调用方），此类意图会停在 awaiting_review。
   本次通过 Planner 提示要求声明 deliverables + 程序回执兜底降低概率；彻底解决需在协调 AI 动作面
   增加复核动作或由 Planner 修订声明（留待后续阶段）。
5. **pending 汇报不丢**：真实运行在 intent resolved 后停止，WR-0003/0004 保持 pending（delivered≠handled），
   下一轮 runtime 会因 pending_reports 唤醒 Orchestrator 处理，不丢记录。
6. model.mjs 新增 token 用量日志（[sorne-llm] tokens: in/out/total，不含内容/key），
   用于真实联调取证；logger 缺失时静默。
7. 运行数据目录与端口为临时值（本次 /var/folders/.../T/sorne-realrun-R8Jlx0、55294），
   证据摘录见 §3.1；llm.json 副本运行结束已删除。
