# TianTi 设计逻辑对照

本文档记录对《面向客户端漏洞挖掘 Agent 的设计与实践之路》的独立实现对照。只吸收公开设计原则，不复制任何参考项目的代码。

## 吸收的核心原则

1. Agent 能力由循环工程、工具质量和模型规划能力共同决定，不用单轮 Prompt 假装自动化。
2. Agent 无状态，记忆外部化。任务、租约、候选结果和事件全部持久化。
3. Worker 不直接修改黑板，只输出结构化候选。调度器统一经过 Guardian 提交。
4. Worker 之间不私聊，只通过 Fact、Intent、Hint 和候选状态间接协作。
5. 不采用固定 DAG 预言渗透路径，采用 Stigmergy 驱动的循环调度。
6. Reason 负责收敛，Metacog 负责正交发散。Metacog 由任务计数、低价值连续输出、无方向连续输出或人工 Hint 触发。
7. 现象不等于漏洞，质量标准由确定性代码实现。降级结果保留，支持后续验证升级。
8. Intent 必须包含 `verb / target / evidence_sink / success_criteria`，并扩展业务影响、风险等级和长链路编号。

## 已落地机制

- 每项目 SQLite WAL 控制库。
- 持久化 Run / Job / Event。
- Job Claim、Lease、Heartbeat、Retry 和过期重新认领。
- Codex / Claude CLI 子进程取消。
- 跨线程、跨进程项目锁和原子文件替换。
- 十维攻击面覆盖状态。
- Fact / Intent / Hint 共享原语。
- 候选输出先落库，调度器后提交。
- HTTP 协议客户端和 Bearer Token 鉴权。
- 15 分钟或迭代完成后的强制人工门禁。

## 与参考设计的有意差异

- 授权策略按项目所有者要求固定为 `authorized + scope=["*"]`。
- Reviewer 作为可选的模型审计者保留，但不代替确定性 Guardian。
- 为满足可审计控制，每次 V3 多波运行收敛后仍会进入强制门禁。守护进程在用户批准后自动开始下一运行。

## 后续产品化

- Host Worker 与 Container Worker 执行面隔离。
- 将服务端协议从当前本地 HTTP 实现升级为独立部署服务。
- Intent 专用认领 API 和跨主机 Worker 水平扩展。
- 覆盖率、验证率、误报率、重复 Intent 率和单个高价值发现成本的评测体系。
