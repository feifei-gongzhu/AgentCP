# t01-agents 测试精读报告

> 范围：test/agents.test.mjs、test/agents-realrun.test.mjs、test/smoke.test.mjs、test/helpers.mjs（共 1843 行）。全部打开读过，用例按聚合理解、关键断言原文核对。未运行 npm test。门禁命令见 package.json:10（npm run check && node --test "test/*.test.mjs"；helpers.mjs 不匹配 glob，不会被当作测试执行）。行号为当前磁盘快照。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 备注 |
|---|---|---|---|
| test/helpers.mjs | 93 | 0 | 测试沙箱设施：makeTempDir(:19)、startTestServer(:28)、withTestServer(:86) |
| test/agents.test.mjs | 839 | 10 | 用例起点 :129/:175/:208/:312/:402/:449/:502/:524/:604/:649（自编号 1–8 与 10） |
| test/agents-realrun.test.mjs | 481 | 8 | :99/:114/:178/:208/:268/:335/:374/:439；**仅** :439 带条件 skip（SORNE_REALRUN=1 且存在 llm.json） |
| test/smoke.test.mjs | 430 | 17 | 入口/HTTP/信任边界/DB 迁移/client.js/页面形状 |
| 合计 | 1843 | 35 | 全仓 skip 仅 1 个（与 docs/实弹测试记录.md:95 的 539 tests/1 skip 一致）；无 .only/.todo |

## ② 锁定的行为清单（按模块/场景）

**agents.test.mjs（四角色 + 内核，模型全为脚本替身）**
- Planner：submit_plan 经 C1 落库、新意图 status=proposed、created_by=planner-agent；幽灵资产 A-9999 被 INVALID_REFERENCE 拒绝且错误回灌（:129-171）。
- Orchestrator：submit_decision → E1 决定落库、assign_execution 被执行（action.status=executed）、C2 条件领取建 leased Attempt（worker_id 正确）（:175-204）。
- Worker：执行开始意图置 running（:241）；SCOPE_DENIED/SCOPE_UNRESOLVED 回灌后循环仍 final，越界 Attempt 仍真实登记（:283-307）；capture.tool_call_id 绑定、blob fixed、exchange_record 含全量头与完整 body_text、观察 capture_id 关联（:254-281）；完成复核结论∈{awaiting_review,resolved} 且意图状态与之一致（:243-250）。
- Verifier：发现者同名应用型结果 TRUST_DENIED 且状态不提升（:359-374）；独立 verifier required_checks 全过 → suspected→confirmed、review=clear（:376-397）。
- 循环内核：maxSteps=3 → stop_reason=max_steps/steps=3/final=null；未知工具 BAD_REQUEST；工具抛 INVALID_REFERENCE 回灌后继续并 final（:402-445）。
- model.mjs：normalizeAssistantMessage 解析 tool_calls、真实 /v1/chat/completions URL、Bearer 头、HTTP 500 → /HTTP 500/（:449-500）。
- runtime：无提供方 → started:false、reason 含 SORNE_LLM_BASE_URL 与"等待"、runOnce skipped（:502-520）；runOnce 两轮（协调→执行→汇报处理）后第三轮 idle skipped=waiting_for_change（:524-600）。
- dsh-bridge：≥6 个 sorne_ 前缀工具、无 tools 服务返回空、dispose 清空（:604-639）。
- env HTTP 提供方端到端：不注入 __modelProvider，经真实 fetch 驱动 runOnce 两轮，断言 URL/Bearer/model、observations/captures 落库、report handled（:649-839）。

**agents-realrun.test.mjs（真实传输 / 证据完整性 / 完成闭环）**
- toWireMessages 精确线格式：assistant.tool_calls={id,type:function,function:{name,arguments:JSON 字符串}}、剥离 finish_reason、tool 消息剥离 name（:99-112，deepEqual）。
- 严格校验服务器（复刻 DeepSeek 实测 422 行为）逐项检查 type/function.name/arguments 为 JSON 字符串/无悬空 tool_call id/tool.content 为字符串；两轮真实 HTTP；invalid 为空（:114-176）。
- 循环每步上限：6 个调用、limit=2 → 仅执行 2 个、4 个 skipped 且 code=RESOURCE_LIMIT、6 个 id 全有应答、assistant.tool_calls 仍为 6（:178-204）。
- mock-target：只绑 127.0.0.1（host:0.0.0.0 被拒）、/admin 多 Set-Cookie、/gbk 为 GBK 字节且 TextDecoder(gbk) 解出「你好」、/backup.zip 保留 PK 魔数（:208-235）。
- raw_body 证据：body_charset=gbk/supported、摘要含中文；同表示二次 store_evidence 幂等（blob_id 相同）；request_ref/response_headers_ref 非空；固定字节与重新 fetch 的真实响应 sha256 逐字节相等；captures=1、observations=1、两次 submit_findings 的 submission_id 与 ids 相同（:268-333）。
- exchange_record：schema=sorne.exchange_record/v1、全量头≥3、body_sha256 等于真实响应、二进制 body_text=null 且 base64 逐字节相等、body_truncated=false（:335-372）。
- 完成闭环：执行置 running；带 deliverables_proof → resolved + intent.completed 事件；未声明交付物 → awaiting_review（:374-434）。

**smoke.test.mjs（骨架门禁，不含 AI 半端）**
- 入口形状/路由注册（:30-46）；health（:50-57）；501 桩改为 lib/stub.mjs 工厂直测（:59-77）；信任边界：缺 Origin/异源/非回环 + x-forwarded-for 一律 403 TRUST_DENIED 且先于路由匹配（:89-163）；404（:107-112）；rawBody 300KiB 可达 handler（:165-196）；manifest 与页面目录 deepEqual、页面源与路径穿越 404（:198-229）；迁移到最新 schema_version、42 张表 + 7 个 §6.3 索引、planner_view 快照可插入、迁移幂等、并发 openDatabase 单飞、runSerial 回滚（:233-340）；client.js 无头注册 settings.section 与外壳钩子（:351-389）；全部页面 id/title/render 形状（:393-430）。

## ③ 测试替身 / 隔离 / 时钟手法

- 沙箱：每个用例 mkdtemp 临时目录 + 监听 127.0.0.1 随机端口，close 时 rmSync 并恢复 SORNE_DATA_DIR（helpers.mjs:19-21,28-31,75-80）；以 mock ctx 调真实 apply()，/sorne/* 全走真实 dispatcher（:34-47）。
- **清理被丢弃**：helpers.mjs:42 用 effect:(fn)=>fn() 即时执行且不保存 disposer，index.js:73-77 的 route dispose / agents.stop() / dshBridge.dispose() 永不执行。后果：每次 withTestServer 的 apply() 都会 startAgentRuntime（index.js:57）；在进程内已设置 SORNE_LLM_* 之后（agents.test.mjs:754 设 env → :759 withTestServer）会启动一个 unref 的 5s ticker，跨用例残留到文件结束，指向随后被删除的临时目录。
- 模型替身：reactiveModel 用 system 正则判角色（agents.test.mjs:71-76；realrun:61-65），游标步进、脚本耗尽后**重复最后一步**（script[Math.min(turn,len-1)]）→ 若实现多走一步会被"最后一步"掩盖；agents.test 的替身返回前经 normalizeAssistantMessage（:95），只覆盖内部归一化路径，不覆盖 toWireMessages（由 realrun :99/:114 补上）。
- 真实网络面：两处用真实 http 服务器假扮 OpenAI 兼容端点（agents.test.mjs:451-474、realrun:117-151），env 注入 + 手工 save/restore（agents.test.mjs:475-497）；真实靶标 tools/mock-target.mjs 只绑 127.0.0.1。
- 时钟：**无 fake timer**；统一传 tickMs=60_000/600_000 让定时器不触发（agents.test.mjs:571,795；realrun:456），因此 429 退避（model.mjs:167-172）、租约 TTL、sweep 时序均未被测。
- 全局状态：smoke 的 client.js 用例写 globalThis.window 后不恢复（smoke:346）；临时目录删除后仍有会话/定时器对象存活（见上）。

## ④ 断言质量

**强断言（回归价值高）**：toWireMessages deepEqual 精确形状（realrun:107-111）；严格服务器主动否定式校验 6 类线格式错误（:126-138）；raw_body / exchange_record 与"测试内重新 fetch 的真实响应"逐字节比对（:317-320,:363-368）；幂等三连（submission_id 相同 + ids 相同 + observations=1，:310,322-329）；迁移幂等/回滚/并发单飞（smoke:284-285,323-334,297-302）；manifest 与磁盘页面 deepEqual（smoke:202-207）。

**宽松或同义反复**：
- Worker 完成复核只断 ∈{awaiting_review,resolved}（agents.test.mjs:244-247）——两种结论都过，实际只锁"进入了复核"。
- runOnce 空闲轮只断 skipped===true（:596-597），未断 reason 之外的副作用（是否重复消费/重复写事件）。
- dsh 桥接"不得注册变更类工具"用正则 /dispatch|submit|create|delete|update/（:632）——按名字启发式，非能力/形状检查。
- 页面形状 hasTitle || hasComponent 任一即过（smoke:428）；文件头写"id/title/order/render"但**未断言 order**（:393 注释 vs :409-411）。
- GBK 用例 :223 把原始字节 sha256 与解码文本的 UTF-8 sha256 比较——对 GBK 内容恒真，属弱断言。
- 501 桩语义从"路由级"降为工厂直测（smoke:59-63 注释自述 44 端点全实装）——路由装载的 501 行为不再有测试。

**假绿风险（与实现缺陷耦合）**：
1. 所有 Worker 用例都**显式**调 store_evidence（agents.test.mjs:217,551；realrun:279,344,386,418），从不断言 register_tool_call 回执里的 evidence 字段 → 掩盖 worker.mjs 的 autoFixEvidence 不可解析（主报告 P0-1）。
2. 更严重：realrun:279-280 期望第二次 store_evidence 返回 idempotent 且表示仍是 raw_body；若修好 autoFix（register 后 probeCache 已有 exchange_record，worker.mjs:352,567），首次 raw_body 固定会命中"已固定另一种表示"的 PRECONDITION_INVALID（worker.mjs:691-701）→ 该用例会失败。同理 agents.test.mjs:225,554 读 result.capture.capture_id，在 autoFix 生效后回执形状变为扁平 {blob_id,capture_id}（worker.mjs:400-406）→ 断言失效。**这两处测试当前锁定的是缺陷状态，修 P0 时必须同步改测试。**
3. realrun:439 唯一真实模型用例默认 skip（需 SORNE_REALRUN=1 且本机绝对路径 llm.json，realrun:42,438），其断言仅 ≥1（captures/blobs/succeeded tool_calls，:468-472）且不断言 autoFix/observations → 真实模型行为完全不在门禁内。

## ⑤ 覆盖缺口（与主报告 05-agents §8 逐条核对）

- 已澄清/由他文件覆盖：per_role 覆盖由 test/llm-settings.test.mjs:180-215 覆盖（本包不重复）；reload 由 llm-settings.test.mjs:220-256 覆盖；messages/report/attempts/verification 的存储面由各自模块测试覆盖。
- 本包确认无断言：① autoFixEvidence 与 register_tool_call 的 evidence 回执；② loop.mjs:154 导出的 __test__.toolResultMessage 截断（test 内零引用）；③ 429 退避重试；④ Worker 的 http_request（非 GET）、resolve_tool_call、probe 前置检查（"上一个调用未落定"）、mark_unknown 收口、max_steps→blocked+cancel 收口、store_evidence 表示冲突分支；⑤ Planner 的 compactView 裁剪、read_changes 游标、分支摘要 4 工具、plan_request 反查（planner.mjs:354-381）；⑥ Orchestrator 的 shelve/resume/wake/checkpoint/recover 与 read_blob 文本/二进制分支；⑦ Verifier 的 job 失效/不存在分支（verifier.mjs:38-46）；⑧ runtime 的 drivenAttempts/drivenJobs 成本护栏、孤儿意图唤醒、协调者指纹去重、admitProposedIntents 上限、resumeWaitingProject（仅 messages.test.mjs 覆盖 resume 事实）；⑨ recon.mjs 零直接测试（planner.mjs:128 / orchestrator.mjs:329 均 .catch(()=>null) 静默降级）；⑩ dsh-bridge 注册失败与 dispose 内异常分支；⑪ smoke 不覆盖 AI 半端启动失败路径（index.js:62-64 catch）。

## ⑥ 与实现文件映射

| 测试文件 | 主要覆盖实现 |
|---|---|
| test/agents.test.mjs | lib/agents/{loop,model,planner,orchestrator,worker,verifier,runtime,dsh-bridge}.mjs（+ 真实 store 链路、lib/routes/*） |
| test/agents-realrun.test.mjs | lib/agents/model.mjs（toWireMessages/httpProvider）、loop.mjs（每步上限）、worker.mjs（executeHttpProbe/store_evidence/buildExchangeRecord/report_progress 闭环）、planner.mjs（种子计划）、runtime.mjs（runOnce）、tools/mock-target.mjs |
| test/smoke.test.mjs | index.js、lib/router.mjs、lib/http.mjs、lib/db.mjs、lib/stub.mjs、client.js、lib/ui/pages/*.page.mjs |
| test/helpers.mjs | index.js apply()：路由注册 + 隐式启动 agents runtime / dsh-bridge（因 disposer 被丢弃而不可回收） |

**结论**：agents 的两个测试文件对"程序保障边界"（范围拒绝、幂等、证据完整、完成复核对、线格式）质量高、可直接作为回归网；但对**成本/资源边界（步数、驱动护栏、429）与证据自动固定链路**几乎无覆盖，且 realrun 的两处断言把缺陷状态写进了期望值——修 P0 前需先改测试。
