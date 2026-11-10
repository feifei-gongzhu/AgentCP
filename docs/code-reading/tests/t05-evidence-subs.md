# t05 · 证据固定与幂等提交 测试精读

> 任务 task-16。只读测试源码，未运行 npm test。合计 1794 行、47 个 node:test 用例。
> 一句话结论：两个文件都用真实 HTTP + 真实 SQLite + 真实故障注入，证据侧「哈希校验/半状态/孤立 Blob」与提交侧「幂等/身份域/回滚」覆盖扎实；主要缺口是 representation「混称」的跨表示复用路径完全未测（这也解释了 derived 混称为何没被测试抓到）、证据侧无并发上传用例、身份域用例只断言 commit_seq 不同而未证两条提交并存。

## ① 文件与用例数

| 文件 | 行数 | 用例数 | 用例起始行 |
|---|---|---|---|
| test/evidence.test.mjs | 895 | 23 | 95/130/148/174/191/219/247/270/305/322/394/436/472/524/571/602/630/664/704/757/770/848/872 |
| test/submissions.test.mjs | 899 | 24 | 126/154/165/199/223/262/293/313/339/357/388/407/451/474/524/561/632/656/672/708/759/796/821/879 |

## ② 锁定的行为清单

- **证据写入流水线**：staging→sha256→固定到 $dataDir/evidence/blobs/sha256/<ab>/<hash>→库登记→回执，staging 清空、stored_path 相对路径、created_by 取 x-sorne-actor（evidence:95-128）；rawBody 300KiB 远超 256KiB JSON 上限仍往返一致（130-146）；超自定上限 413 且 blobs 0 行/无暂存残留（148-172）；内容寻址去重返回原回执与 created_seq、库中一行（174-189）；representation 必填+枚举、expected_sha256 不符拒绝并清 staging（191-217）。
- **失败与半状态**：存储不可用（staging 路径被普通文件占据）→500 retryable+next_requirements+0 行，修复后同上传成功（219-245）；目标路径被异内容占用→拒绝覆盖且 0 行（247-268）；GET blob 字节+7 个 x-sorne-* 头、404/坏哈希 400/lost→EVIDENCE_NOT_COMMITTED（270-303）；磁盘内容与登记哈希不符→500 integrity=mismatch 不静默供数（305-318）；场景23 固定成功+登记事务外键失败→0 行、orphan_files 可识别（436-468）；文件消失→blob 置 lost 且拒绝新 capture、历史 capture 保留（602-628）。
- **场景 4/5**：同 URL 两版本 blob/capture 并存、旧锚点可读、错绑版本 INVALID_REFERENCE、同事务 capture.completed×2+resource.content_changed（322-392）；Token 差异两份原始证据、同 transform 降噪同哈希、capture 详情派生链 representation=derived（394-434）。
- **capture 与来源**：POST /captures 幂等（同 tool_call_id 原回执）、同 ID 异内容 IDEMPOTENCY_KEY_REUSED、恰好一条 capture.completed（472-522）；未固定 Blob/未知项目/未知 blob/resource/attempt 全部拒绝且 0 行（524-569）；source_kind 如实入库、非法值 400（571-599）；详情三层读取入口与空 transforms（630-660）。
- **布局与锚点**：assets/ 路径穿越（编码 %2e%2e、IPv6 怪字符）中和、sidecar 保全文 URL（664-702）；URL 冲突以资源编号/确定性哈希消歧、未知占用不覆盖（704-755）；work/<intent>/<attempt> 穿越中和（757-766）；EvidenceAnchor 表示形式强校验、line_range/byte_range 左闭右开/json_pointer/derived 绑定 transform/whole（770-844）。
- **跨项目与恢复**：同哈希双项目两行、无 project_id 时 400 列 project_ids、按项目读取头正确（848-870）；句柄真实重开后证据/采集/锚点/Outbox 仍可读（872-895）。
- **提交服务**：项目/生命周期/范围版本（submissions:126-258）；会话与角色（无会话/过期/user 提交、worker 访问用户面、自报字段拒绝，262-309）；场景2 原回执（313-337）、场景24 回执丢失恢复（339-355）、场景3 ID 复用回执+不覆盖（357-386）；身份域（388-403）；场景1 并发同资产一节点两来源、归并告警、first_discovery 一真一假（407-449）；并发 commit_seq 唯一连续（451-470）；场景10 无关备注不推进 evidence_revision（474-522）；证据成员重复不重复推进（524-559）；修改型 expected_state_version/claim_revision（561-628）；INVALID_REFERENCE 整组回滚（632-654）；attempt_id 校验（656-670）；注入「写后抛错」整事务回滚（672-704）；场景19 疑似漏洞即时持久化、worker 不能确认（708-755）；requires 新增/撤回 dependency.changed（759-792）；同内容两次独立提交两份记录（796-817）；场景12 重启后 Outbox pending=5、event_index 连续、跨重启幂等（821-875）；health 扩展（879-899）。

## ③ 替身 / 隔离 / 时钟

- 无 mock 事务：evidence 的 25/23 场景用真实文件系统注入（占位文件、损坏字节、删文件、删项目行触发外键失败）；submissions 用真实 `registerSubmissionOps` 注册测试专用 op `__test_explode_after_write`（submissions:106-122，模块加载即注册，全进程生效）。
- 隔离：evidence 用 `withEnv` mkdtemp+pctx 并 finally `evidence.closeAllStores()`（:34-43），HTTP 服务器用同一 dataDir 另开 `withTestServer`（:59-61）；submissions 每用例 `withTestServer`+`closeStore`，重启用例私有 `bootServer`（:53-78）并 `openDatabase` 另开连接核对（:856-869）。
- 种子数据：evidence 多数用例直接用 SQL 插 projects 行（:45-56）绕过 `createProject`，因此不覆盖「HTTP 建项目→上传」链路的编号/事件耦合。
- 时钟：evidence 无时间依赖；submissions 过期会话用 TTL=1ms + 真实 setTimeout 5ms（:274-276），只会更过期，无 flake 方向；其余顺序断言基于 commit_seq/event_index 而非墙钟。
- 环境变量：SORNE_EVIDENCE_MAX_BYTES 在服务回调内装拆并在 finally 恢复（:151-170），注释显式说明「裸 return+外层 finally 会提前恢复」的坑——写法正确。

## ④ 断言质量

- **强项**：HTTP 响应与库内行双断言，失败分支断言「零半状态」而非只看状态码（evidence:164-166/212-215/237-238/265-267/456-458/566-567；submissions:649-652/691-702）；字节级相等（evidence:117/144/279/843）；staging 空目录（evidence:124-126/214-215）；孤立文件路径精确匹配（evidence:461-463）；场景1 用「一个节点/两条观察/两条边/first_discovery 一真一假」证明并发归并语义（submissions:427-447）；场景12 用 pending=5+event_index [1..5]+跨重启回执 deepEqual 证明同事务与可扫描性（:836-866）。
- **过拟合（可接受但脆）**：硬编码编号/序号——B-PRJ-T1-0001（evidence:107）、CAP-PRJ-CAP-0001（:490）、event_id evt-PRJ-CAP-<seq>-0（:492）、场景4 事件串 [capture.completed@3:0,…]（:383）、commit_seq [2,3,4,5,6,7]（submissions:468）、commit_seq==2（:838）、schema_version>=7（:894）。新增任何建项目/派发事件或调整编号宽度都会成片红；维护时若顺手放宽，会削弱幂等与同事务语义。
- **同义反复风险低**：基本是「结果态 vs 期望常量」；仅一处近似同义——evidence:433 断言 derived_blob.representation=="derived" 恰是被测逻辑返回值回显（见 ⑤）。
- **放宽/弱断言**：submissions 身份域用例只断言两提交 commit_seq 不同（:401），未断言两条 submissions 行/两份回执并存（如果实现把第二份静默替换，本用例仍绿）；注入回滚用例用 health 的 outbox.total 相对比较（:698-702）而非事件集合；重复关系用例依赖中文告警文案（:549）；并发归并用告警文案匹配（:430）。
- **无跳过**：两个文件无 test.skip/todo/only；无「断言包在 if 里」的条件断言。
- **假绿风险**：evidence 场景5 的 derived representation 断言（:433）只在「派生字节哈希≠任何既有 Blob」时成立，恰好回避了唯一会暴露混称的路径；场景25 用「staging 被文件占据」而非真实 ENOSPC，错误码路径（INTERNAL_ERROR+retryable）被锁定，但 ENOSPC→RESOURCE_LIMIT 分支未验证。

## ⑤ 覆盖缺口（含「derived representation 混称为何未测出」结论）

1. **derived Blob representation 混称未被测出的原因（本报告重点）**：
   - 去重用例（evidence:174-189）只做「同一 representation 重复上传」，从未测「同一 sha 以不同 representation 再次登记」。实现遇到该情形不新建行、保留首次 representation 并给 warning（`lib/store/evidence.mjs:262-282`，warning 文案「同一字节不混称多种表示」）；这条路径断言为零。
   - 场景5（evidence:394-434）构造的降噪产物哈希与两份原始证据都不同，所以 `registerTransform(derived_bytes)` 一定新建一个 representation='derived' 的行，:433 才恒绿。
   - 而 `registerTransform` 的 `derived_bytes` 分支只按 sha 取行、**不复核** representation（`evidence.mjs:813-822`）；只有 `derived_sha256` 分支强制校验 `row.representation === "derived"`（:828-830）。因此若派生字节恰好等于已登记的 raw_body/uploaded_file（恒等 transform、格式化后字节不变、用户先上传同一文件），transform 行会静默引用非 derived Blob，且 capture 详情的 `derived_blob.representation` 变成 raw_body——§5.3「原始与派生不混称」被破坏，而现有 23 个用例无一构造「派生字节哈希 == 既有非 derived Blob」。建议补该用例，并在 :813 分支同样校验/拒绝。
2. 同哈希不同 representation 的上传（raw_body 后再传 uploaded_file / decoded_body）无用例，也无断言 warning 文案与「声明 representation 丢失」的取舍。
3. 证据侧无并发用例：两个并发 storeBlob 同字节（尤其不同 representation）是否只留一行、是否为竞态留 orphan，未测；对比 submissions 有场景1 并发。
4. 跨项目隔离只测 blob（evidence:848-870）；captures/transforms/anchor 跨项目引用（P1 的 capture 用 P2 的 sha、anchor 指向他项目 capture）未测。
5. capture 幂等只变了 response_body_blob（:501-512）；同 tool_call_id 改 method/url 等其它字段、同 tool_call_id 跨项目（UNIQUE(project,tool_call_id) 域）未测。
6. 故障注入覆盖面：ENOSPC/EDQUOT 映射分支、readRawBody 中途断流、WAL 模式下未提交事务崩溃（evidence「重启」只是 closeAllStores，不是进程级崩溃）未测；submissions 场景12 是优雅关服，未覆盖「提交事务已提交但进程被 kill」的 WAL 恢复路径。
7. submissions 身份域、receipt 内容只取样 commit_seq（:378/401），未断言原提交行不被覆盖、两行并存。

## ⑥ 与实现文件映射

- evidence.test.mjs ↔ `lib/store/evidence.mjs`（storeBlob:341-、registerBlob:256-、stageBytes:197-/fixBlobFile:220-、registerCapture:544-、readBlobBytes:399-、registerTransform:783-、findStorageAnomalies:460-、resolveEvidenceAnchor:938-）、`lib/store/layout.mjs`（blobPath/evidenceDirs/relToDataDir/materializeAssetEntry/ensureWorkspace）、`lib/routes/evidence.routes.mjs:24-91`。
- submissions.test.mjs ↔ `lib/store/record-service.mjs`（submit:847-、registerSubmissionOps:277-、createProject:1180-、updateProjectLifecycle:1277-、createScopeRevision:1329-）、`lib/routes/projects.routes.mjs:132-268`、`lib/db.mjs:46-113`（openDatabase 重启核对）、`index.js:36-79`（bootServer 用 apply 装载真实路由）。
- 共同依赖：`test/helpers.mjs`（withTestServer/makeTempDir）、`lib/store/sessions.mjs`（issueSession）。本组未覆盖 evidence/layout 的 HTTP 路径之外分支不在此列（见 ⑤）。

