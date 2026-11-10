# t06 测试精读：judgements / verification / verification-default-policy

> 范围：test/judgements.test.mjs、test/verification.test.mjs、test/verification-default-policy.test.mjs
> 方法：逐个 test() 读用例体与断言，对照实现文件核对断言是否真的锁定行为；未运行测试（保持环境干净）。
> 只读源码与测试，只写本报告。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 组织方式 |
|---|---|---|---|
| test/judgements.test.mjs | 1430 | 28 | node:test 顶层 test()，无 describe/suite；夹具与 helper 在文件内（50-282） |
| test/verification.test.mjs | 1387 | 32 | 同上；8 个分区注释（验收映射用） |
| test/verification-default-policy.test.mjs | 28 | 2 | 纯函数/模块加载级 |

## ② 锁定的行为清单

**judgements.test.mjs**
- 纯函数：§7.1 规范化只归一明确等价（286-310，断言 canonical_key 精确值、路径大小写/查询序/编码保留、url_exact 原串）；§7.2 模板折叠（312-325，{n}/{uuid}/{hash}+rule_version）；§8.2 requires_state 语法（327-333，含不可解析→null）。
- §8.1 分层：三表独立成行 + 一观察多 supports 边 + 假设 rejected 后观察原样（337-372）；worker 执行 record_fact → 403 TRUST_DENIED（374-388）；无 verification_refs → 422（390-404）；引用不存在 INVALID_REFERENCE、outcome≠supported 拒绝、supported/versioned_rule 可归档且 status=verified（406-471）。
- §8.4 状态机（直接调 applyStateTransition + 直读 DB）：confirm 成功与 confirmed_version/事件/state_version=2（475-508）；三版本分别 STALE_STATE/CLAIM_CHANGED/STALE_EVIDENCE 且被拒后版本不变（510-537）；发现者自证 PRECONDITION_INVALID（539-564）；checks 失败不得确认（566-597）；insufficient 三分流（599-627）；conflicting→review=disputed 且重复不虚增版本（629-653）；overturn 守卫 + reopen 推 assessment_epoch（655-688）；evaluatePrerequisite 默认叠加 review=clear、显式 review 覆盖、不可解析保守拒绝、不存在对象拒绝（690-725）。
- 黑盒场景：场景 11（733-861，真实 #11/#12/#10/#20/#22/#27/#28 全链，断言事实行 deepEqual 前后一致、派发被 PRECONDITION_INVALID 拦截、change-log 有依赖事件、两次结果/2 个 blob 留档）；场景 19（959-999，新会话引用、台账仍 suspected、未确认不放行）。
- §7.1 资产（1003-1102：等价归并+original_input 保留、resource 参数组合独立、DNS 不合并）；§7.2 模板拆分保样本/captured_from/样本行不删（1106-1219）；§7.3 候选组不合成、duplicate_of、误合并可拆、组版本 STALE_STATE（1223-1290）；假设/事实状态机（1294-1332）；#30 台账（1336-1430：状态/复核分列、证据计数、过滤、游标、跨项目 403、缺参 400）。

**verification.test.mjs**
- 五要素与去重键（346-524）：Manifest 绑定/期望三版本/语义 subject_kind、缺失项分别 400/422、§7.3 四成分含「新证据→新任务」；角色面 worker/orchestrator/verifier 200、user/planner/runtime/projection 403。
- Manifest 服务（526-591）：声明一致性告警、同键幂等同 content_hash、新证据→新 Manifest 且旧行不可变。
- #28 合同（615-741）：非 verifier 403 且无落库；发现者自证 403、insufficient 允许且不得升级；错 Manifest/错 reviewed_evidence_revision/错策略/错 claim 分别 422 且不落库；检查项未覆盖拒绝、必需检查失败→applied=false+checks_failed+review=pending。
- 应用路径（760-950）：confirm 触发 confirmed+state_version=2+review=clear+applied=1+同一 commit_seq 的 vulnerability.state_changed（from=suspected、verification_result_id 回写）；falsified/conflicting/insufficient；再确认 no_transition 且不推 state_version；overturn 双向；hypothesis support。
- §12.3 五情形（954-1107）：STALE_EVIDENCE 错误信封带回执、review=pending、意见留档；确认后新证据→review=pending+evidence_set.revised；无关备注不推进；完全重复不去重不置复核；自报无关无效；其他（1111-1387）：场景 22、幂等重交（同 result_id、1 行 1 事件）、并发两 verifier 恰一应用且 state_version=2/review=clear、重启恢复原回执且单次确认、TRIGGER 注入整体回滚、#43/#44 verifier 读字节、#29 队列过滤/游标/跨项目 403、D2 装配集成与来源诊断。

**verification-default-policy.test.mjs**：默认策略随模块加载注册且 required_checks=["evidence_reviewed"]（12-20）；同键不同内容重注册 BAD_REQUEST（22-29）。

## ③ 测试替身 / 隔离 / 时钟手法

- 无 DB mock：全部经真实 runSerial 事务与真实 HTTP 端点。服务器由 `apply()` 注入假 `webServer.register` + QUIET logger 装配（verification.test.mjs:155-172；judgements.test.mjs:71-102），避免真实宿主。
- 隔离：每用例独立 mkdtemp 数据目录 + listen(0) 随机端口，finally 关服 + closeStore + rmSync（verification.test.mjs:175-206；judgements.test.mjs:98-102 与各用例 t.after）。
- 会话：issueSession 真实签发（verification.test.mjs:217-225；judgements.test.mjs:118-133），无伪造 token。
- 状态机替身仅条件安装：verification.test.mjs:50-130 定义 realTestApplier，仅在 `!D2_LANDED` 时 `__installStateTransitionForTests`（128-130）；D2 已落地→当前为不执行的死代码。**该替身与 D2 不等价**：不返回任何事件、mark_conflicting 语义与 from 集合更宽、require_review 仅 confirmed——因此若 D2 缺失，断言「D1 同事务 flush 状态事件」的用例（760-790）不可能通过，文档所称「未落地窗口由真实测试装配覆盖」实际不成立。
- 时钟：无假时钟/无时间推进；仅断言 waiting_ms 为 number（verification.test.mjs:392）、重启用真实 closeStore→重开（188-206、1193-1235）；全局状态：registerTestPolicy 写进程级策略注册表（verification.test.mjs:286-291，多处调用，不重置）；文件级可变全局 SEED_OBS_ID（595、602）被 §12.3-4 用例消费（1059）→ 依赖同文件串行执行，用例重排即失效。

## ④ 断言质量

**总体**：强断言占比高——大量直读 SQLite 核对状态/版本/计数/事件（如 verification.test.mjs:760-791 同时断言 subject 行、job.status=completed、result.applied=1、verification.completed 与 vulnerability.state_changed 同 commit_seq、payload.from/verification_result_id）；错误码 + message 正则 + 回执字段三件套（966-987）；错误路径普遍补「无落库」断言（631、654、704、719）。下表只列问题项。

| 类型 | 位置 | 现象 | 判断 |
|---|---|---|---|
| 同义反复 | test/verification.test.mjs:1031 | `assert.ok(note.body.warnings.length===0 \|\| note.body.warnings.join("").length>=0)` 恒真 | 无信息量断言，应删除或改为具体告警集 |
| **假绿风险（重要）** | test/judgements.test.mjs:850-854 | 用 `depEvents.some(e => e.payload.relation_id === requiresEdgeId)` 证明「推翻产生 dependency.changed」 | relation_id 只出现在 A1 add_relation 产生的 dependency.changed（record-service.mjs:371-376）；D2 失效事件 payload 是 affected_relations（judgements.mjs:238-252）。**删掉 D2 的 gate 逻辑该断言仍通过**，应改断言 `affected_relations.includes(requiresEdgeId)` 或 change==="invalidated" |
| 放宽 | test/judgements.test.mjs:844 | `assert.match(msg, /前提\|prereq\|confirmed/i)` 三个宽词任一 | 无法区分拒绝原因，宜断言 code + 具体前提对象 |
| 放宽 | test/verification.test.mjs:1295 | 用整段 JSON.stringify(cap.body).includes("COND-未登录") 或含字段名 | 头部元数据里出现同名串即通过，未定位字段 |
| 放宽 | test/verification.test.mjs:1146 | `plan.body.ids?.i1 ?? plan.body.intents_created?.[0]` 形状双兜底 | 掩盖回执形状回归 |
| 放宽 | test/verification.test.mjs:806-808、909-910；judgements.test.mjs:850 | 计数用 `>= 1` | 无法发现「重复留档/重复事件」 |
| 过拟合 | test/verification.test.mjs:970、382 | `result_id.startsWith("VR-")`、`member_id.startsWith("O-")` | 绑定编号制式；D2 编号双轨（A-<PRJ>-…）下同类断言策略不一致 |
| 过拟合 | test/judgements.test.mjs:234-259 | seedVerificationResult 硬编码 created_seq 9/10/11 与手工 id | 绕过 A1 编号与事务，且与 D1 真实结果行形态不同（checks 默认 "[]"，job 直接 completed） |
| 条件跳过 | test/verification.test.mjs:1367 | `{ skip: !D2_LANDED }` | D2 已落地故当前执行；但反之整条默认装配路径静默跳过，且 ③ 的替身不等价 |
| 顺序耦合 | test/verification.test.mjs:595-602、1059 | SEED_OBS_ID 文件级全局由 setupJob 写入、后续用例依赖 | node:test 同文件串行才成立；并发/重排即失效 |

## ⑤ 覆盖缺口（与实现风险对应）

1. **非必需检查失败 + supported**（第一阶段 P1-1）：verification.test.mjs:731 的失败项 conditions_reproduced 属 POLICY.required_checks（286），用例只覆盖「必需检查失败」；D1 checksPass（verification.mjs:1000）与 D2 严格判定（judgements.mjs:192-212）不一致导致的事务回滚路径**无任何用例**。
2. **review 直写路径的版本语义**（P1-2）：场景 8/9 中 review=pending 由 D1 直接 UPDATE 产生（verification.mjs:1106-1123），用例只断言 review 值（976、1003、1106），未断言该路径的 state_version 行为（不推进）——恰好把实现缺陷固化为预期。
3. **拆分撞唯一约束**（P1-4）：judgements.test.mjs:1137-1146 只拆到不存在的新路径；拆到已存在 path_template（UNIQUE，0001:107）的 500 路径无测。
4. **结果侧证据引用校验**：resultInput 恒 `supporting_refs: []`（verification.test.mjs:305-324），#28 的 validateEvidenceRefs 错误分支（不存在对象、超 64 条、非数组）从未触发；request 侧仅测了 rawOnly 与策略未注册（397-460）。
5. **入参形状分支**：validateChecksShape 的空数组/重复名/>64 项（verification.mjs:820-839）、overturn 非布尔、suggested_followups>32、condition_snapshot_id 与 job 冲突（结果行不回显校验）均无用例。
6. **版本竞争只测 state_version 变体**（1165-1191）；claim_revision 竞争（判断被 revise 后旧结果提交）无端到端用例，仅 D2 单测用 expected 参数直测（judgements.test.mjs:526-529）；evidence_revision 竞争有（954-987）。
7. **并发语义**：Promise.all 的两请求仍经同一进程/单队列（verification.test.mjs:1170-1176），未覆盖跨连接 WAL 竞争；「恰一应用」依赖结果排序筛选（1177-1183），若两份都 200 未 applied 才失败。
8. **Manifest 服务错误分支**：generateEvidenceManifest 对非判断对象/未注册策略的拒绝（verification.mjs:384-387）无测；跨项目同 subject 隔离无测；**default-policy 文件只守「注册存在」**：未测默认策略在真实 #27 请求中可用（依赖 verification.test.mjs 注册自有策略，反而绕开默认策略）；两个文件对默认策略的契约缺少交叉验证。

## ⑥ 与实现文件映射

| 测试文件 | 主要被测实现 | 关键落点 |
|---|---|---|
| test/judgements.test.mjs | lib/store/judgements.mjs | applyStateTransition（271-472）、evaluatePrerequisite/parseRequiresState（499-617）、record_fact（633-712）、listVulnerabilities（753-854） |
| 同上 | lib/store/dedup.mjs | 规范化（50-152）、提交操作（268-883）：模板/候选组/资产 |
| test/verification.test.mjs | lib/store/verification.mjs | requestVerification（536）、submitVerificationResult（853）、generateEvidenceManifest（379）、listVerificationJobs（1258）、evaluateAdmission（1305） |
| 同上（跨） | lib/store/judgements.mjs | D2 状态机（默认装配，断言来源 stateTransitionSource= d2/judgements） |
| test/verification-default-policy.test.mjs | lib/store/verification.mjs | 内置策略注册与版本不可变（149-206） |

**结论**：两个大测试文件的主体设计是「真实端点 + 真实事务 + 直读 DB」的高保真风格，竞争/重启/原子性/权限面覆盖到位；主要风险不在数量而在**关键分支被弱断言或固化为缺陷预期**：第 ④ 节的 dependency.changed 假绿与第 ⑤ 节 1/2/3 三条，恰好对应第一阶段报告 P1-1、P1-2、P1-4 三条实现缺陷——测试在该处未形成约束，修复时需同时补测。

