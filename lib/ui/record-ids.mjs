/**
 * Sorne —— 统一编号解析（lib/ui/record-ids.mjs；M1 独占，全站唯一正则来源）。
 *
 * 蓝图 §2.3（冻结契约）。修复评审 §4a：
 *   旧实现 `([A-Z][A-Z0-9]{0,6}-\d{1,8})` 是子串匹配，对项目段编号
 *   `A-PRJ-0002-0002` 只取中段 `PRJ-0002`，点击「按编号追溯」会静默打开
 *   项目记录——CDP 实测的真实交互 bug。本模块改为**整体匹配**（非子串），
 *   项目段必须整体解析；解析失败一律返回 null，调用方降级为纯文本 chip，
 *   绝不猜测、绝不截断匹配。
 *
 * 两族编号并存（蓝图 §0 实测，0004 迁移的历史结果）：
 *   - 全局族   PREFIX-nnnn          例：A-0002、V-0003、TC-0009、ATT-0001
 *   - 项目段族 PREFIX-PRJ-nnnn-nnnn 例：A-PRJ-0002-0002、I-PRJ-0002-0001、
 *                                          WR-PRJ-0002-0003、MSG-PRJ-0002-0001
 *
 * 本文件不得 import 任何包或 Node 内置模块（浏览器动态 import 加载，
 * Node 测试直接 import，两端同源）。
 */

/** 项目段固定字面量（编号中段，非正则通配）。 */
const PRJ_SEGMENT = "-PRJ-";

/**
 * 记录编号正则（整体匹配，锚定首尾；蓝图 §2.3 冻结形状）：
 *   ^([A-Z][A-Z0-9]{0,5})(?:-PRJ-(\d{1,8}))?-(\d{1,8})$
 * 前缀 1–6 位大写字母开头（含数字），项目段可选，尾段 1–8 位数字。
 * 例：A-0002 ✓ ｜ A-PRJ-0002-0002 ✓ ｜ MSG-PRJ-0002-0001 ✓
 *     PRJ-0002 ✓（项目记录自身） ｜ evt-… ✗（事件编号不属 /records）
 */
export const RECORD_ID_RE = /^([A-Z][A-Z0-9]{0,5})(?:-PRJ-(\d{1,8}))?-(\d{1,8})$/;

/**
 * 事件编号正则：evt-<PRJ>-<commit_seq>-<event_index>；大小写两种前缀并存
 * （record-service.mjs 的 EVT- 与 evidence.mjs 的 evt-）。事件编号不属
 * /records（后端维持 404 + hint 指向 /changes 的语义）。
 */
export const EVENT_ID_RE = /^[Ee][Vv][Tt]-[A-Za-z0-9-]+$/;

/**
 * 客户端前缀表：与后端 lib/store/records-read.mjs PREFIX_TABLES 同步的只读镜像
 * （蓝图 §2.3）。**定位一律以 /records 服务端为准**，本表只用于 chip 悬停显示
 * 目标类型；后端前缀表由 M2 扩展（WR/TC/VJ/VR/OD/OA/PR/CG/RES/SUBS/CP/ASM/M/MSG、
 * RR 双表），后端登记后此处同步补齐即可，前端解析不依赖本表（未登记前缀仍可解析
 * 与跳转，由服务端定位）。
 */
export const PREFIX_TABLES = Object.freeze({
  A: "assets",
  ATT: "attempts",
  ASM: "attempts",
  B: "blobs",
  CAP: "captures",
  CG: "candidate_groups",
  CP: "checkpoints",
  EM: "evidence_memberships",
  F: "facts",
  G: "goals",
  H: "hypotheses",
  I: "intents",
  M: "memberships",
  MSG: "messages",
  OA: "orchestration_actions",
  OD: "orchestration_decisions",
  O: "observations",
  PR: "plan_runs",
  PRJ: "projects",
  R: "relations",
  RES: "resources",
  RR: "report_revisions / report_receipts（跨两类，按存储定位）",
  SNAP: "snapshots",
  SR: "scope_revisions",
  SUBS: "subscriptions",
  T: "endpoint_templates",
  TC: "tool_calls",
  V: "vulnerabilities",
  VJ: "verification_jobs",
  VR: "verification_results",
  WR: "worker_reports",
});

/** 前缀 → 中文类型标签（chip 悬停/旁注显示）。 */
export const PREFIX_LABELS = Object.freeze({
  A: "资产",
  ATT: "执行尝试",
  ASM: "执行尝试",
  B: "证据字节",
  CAP: "采集记录",
  CG: "线索聚合",
  CP: "检查点",
  EM: "证据成员关系",
  F: "事实",
  G: "目标",
  H: "假设",
  I: "意图（探索方向）",
  M: "成员关系",
  MSG: "消息",
  OA: "协调动作",
  OD: "协调决定",
  O: "观察",
  PR: "规划运行",
  PRJ: "项目",
  R: "关系",
  RES: "资源",
  RR: "报告版本/报告回执",
  SNAP: "快照",
  SR: "范围版本",
  SUBS: "订阅",
  T: "接口模板",
  TC: "工具调用",
  V: "漏洞",
  VJ: "验证任务",
  VR: "验证结果",
  WR: "Worker 汇报",
});

/**
 * 解析一个编号（整体匹配；蓝图 §2.3 冻结）。
 * @param {string} text 任意文本（首尾空白容忍）
 * @returns {{ id: string, prefix: string, projectSeq: string|null, seq: string,
 *             table: string|null, kindLabel: string|null } | null}
 *   解析失败 → null（调用方必须降级为纯文本 chip，不得猜测）。
 *   EVENT_ID_RE 命中的事件编号同样返回 null（不属 /records）。
 */
export function parseRecordId(text) {
  if (typeof text !== "string") return null;
  const id = text.trim();
  if (!id || !RECORD_ID_RE.test(id)) return null;
  if (EVENT_ID_RE.test(id)) return null;
  const m = RECORD_ID_RE.exec(id);
  const prefix = m[1];
  const projectSeq = m[2] || null;
  const seq = m[3];
  const table = Object.prototype.hasOwnProperty.call(PREFIX_TABLES, prefix)
    ? PREFIX_TABLES[prefix]
    : null;
  const kindLabel = Object.prototype.hasOwnProperty.call(PREFIX_LABELS, prefix)
    ? PREFIX_LABELS[prefix]
    : null;
  return { id, prefix, projectSeq, seq, table, kindLabel };
}

/** 是否事件编号（不属 /records；chip 对其降级并提示去向变化流）。 */
export function isEventId(text) {
  return typeof text === "string" && EVENT_ID_RE.test(text.trim());
}

/** 判断文本是否「含项目段」的项目内嵌族编号（用于 chip 形态标注，蓝图 §10-3）。 */
export function hasProjectSegment(text) {
  const parsed = parseRecordId(text);
  return Boolean(parsed && parsed.projectSeq);
}

export { PRJ_SEGMENT };
