// 数据派生层：从 /api/project/state 构建视图模型。实体各自身份保留：
// 线索=已提交 risk_lead Fact；方向=directions；漏洞=vulnerability Fact。
function factClassification(fact) {
  return String(fact.classification || fact.status || "attack_surface");
}
function classificationLabel(value) {
  return ({ attack_surface: "攻击面", risk_lead: "线索", vulnerability: "漏洞", same_root_vulnerability: "同源漏洞", negative_evidence: "负向证据", inconclusive: "证据不足" })[value] || value || "攻击面";
}
function latestVerdictMap(project) {
  const result = {};
  (project.human_verdicts || []).forEach(item => { result[item.finding_id] = item; });
  return result;
}
function verdictLabel(verdict) {
  if (!verdict) return "待人工复核";
  const action = ({ accepted: "人工认可", adjusted: "人工调级", same_root: "同源漏洞", refuted: "已驳斥", reclassified: "已降级", retest_requested: "要求复验" })[verdict.action] || verdict.action;
  const master = verdict.duplicate_of_finding_id ? ` · 主漏洞 ${verdict.duplicate_of_finding_id}` : "";
  return `${action} · ${classificationLabel(verdict.final_classification)} · ${verdict.final_severity || "unknown"}${master}`;
}
function riskLeadLifecycle(item) {
  if (item.__pending) return { key: "pending_commit", label: "待收敛", detail: "模型结果尚未写入黑板" };
  if (item.intent_id) return { key: "queued", label: "待关联验证", detail: `已关联方向 ${item.intent_id}` };
  return { key: "unscheduled", label: "待转验证", detail: "尚未生成可执行验证方向" };
}
function riskLeadIdentity(item) {
  const normalize = value => String(value || "").replace(/^\[(?:候选|待验证|执行中)\]\s*/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return `${normalize(item.title)}${normalize(item.business_impact)}`;
}
function deduplicateRiskLeads(items) {
  const priority = { queued: 4, pending_commit: 3, unscheduled: 2 };
  const selected = new Map();
  items.forEach(item => {
    const key = riskLeadIdentity(item);
    const lifecycle = riskLeadLifecycle(item);
    const current = selected.get(key);
    const score = (item.__confirmedVulnerabilities?.length ? 100 : 0) + (priority[lifecycle.key] || 0);
    const currentScore = current ? (current.__confirmedVulnerabilities?.length ? 100 : 0) + (priority[riskLeadLifecycle(current).key] || 0) : -1;
    if (!current || score > currentScore) selected.set(key, item);
  });
  return [...selected.values()].sort((left, right) => {
    const confirmedDiff = Number(Boolean(right.__confirmedVulnerabilities?.length)) - Number(Boolean(left.__confirmedVulnerabilities?.length));
    if (confirmedDiff) return confirmedDiff;
    const stateDiff = (priority[riskLeadLifecycle(right).key] || 0) - (priority[riskLeadLifecycle(left).key] || 0);
    return stateDiff || String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""));
  });
}
function vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById) {
  const refs = new Set();
  const add = value => { if (value) refs.add(String(value)); };
  const addMany = values => (Array.isArray(values) ? values : []).forEach(add);
  add(vulnerability.intent_id); add(vulnerability.hypothesis_id);
  const direction = directionById.get(vulnerability.intent_id);
  if (direction) {
    const intent = direction.intent || {};
    add(direction.id); add(intent.id); add(intent.hypothesis_id); add(intent.parent_id); add(intent.chain_id);
    addMany(intent.source_fact_ids);
  }
  const hypothesis = hypothesisById.get(vulnerability.hypothesis_id);
  if (hypothesis) { add(hypothesis.id); addMany(hypothesis.parent_fact_ids); addMany(hypothesis.intent_ids); }
  return refs;
}
function vulnerabilityLinksForLead(lead, vulnerabilities, directionById, hypothesisById) {
  const leadRefs = [lead.id, lead.intent_id, lead.hypothesis_id, ...(Array.isArray(lead.source_fact_ids) ? lead.source_fact_ids : [])].filter(Boolean).map(String);
  return vulnerabilities.filter(vulnerability => {
    const refs = vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById);
    if (leadRefs.some(reference => refs.has(reference))) return true;
    const leadEvidence = String(lead.evidence_path || "").replace(/\/+$/g, "");
    const vulnerabilityEvidence = String(vulnerability.evidence_path || "").replace(/\/+$/g, "");
    return Boolean(leadEvidence && vulnerabilityEvidence && leadEvidence === vulnerabilityEvidence);
  });
}
function buildDerived(project, automation, evidenceResult) {
  const jobs = automation.jobs || [];
  const pendingFactRows = jobs
    .filter(job => job.status === "completed" && !job.committed_at && job.result?.payload?.kind === "fact")
    .map(job => ({ ...job.result.payload, __pending: true, __member: job.member_name }));
  const factRows = [...project.facts, ...pendingFactRows];
  const attackIntel = factRows.filter(fact => factClassification(fact) === "attack_surface");
  const vulnerabilities = factRows.filter(fact => factClassification(fact) === "vulnerability");
  const directionById = new Map((project.directions || []).map(direction => [direction.id, direction]));
  const hypothesisById = new Map((project.hypotheses || []).map(hypothesis => [hypothesis.id, hypothesis]));
  // 风险线索只来自 risk_lead Fact（候选明确标注）；Direction 不伪装成线索。
  const rawRiskLeads = factRows.filter(fact => factClassification(fact) === "risk_lead")
    .map(lead => ({ ...lead, __confirmedVulnerabilities: vulnerabilityLinksForLead(lead, vulnerabilities, directionById, hypothesisById) }));
  const riskLeads = deduplicateRiskLeads(rawRiskLeads);
  const sourceLeadsByVulnerability = new Map(vulnerabilities.map(vulnerability => [
    vulnerability.id,
    riskLeads.filter(lead => (lead.__confirmedVulnerabilities || []).some(item => item.id === vulnerability.id)),
  ]));
  const negativeEvidence = project.negative_evidence || [];
  const directionRows = (project.directions || []).map(direction => {
    const intent = direction.intent || {};
    const confirmed = vulnerabilities.filter(vulnerability => vulnerabilityReferenceSet(vulnerability, directionById, hypothesisById).has(direction.id));
    // 负向结论无 intent_id：同 target 只作候选关联。
    const directionTarget = String(intent.target || "").toLowerCase();
    const directionHypothesis = String(intent.hypothesis || "");
    const candidateNegatives = negativeEvidence.filter(item => {
      const target = String(item.target || "").toLowerCase();
      if (!target || !directionTarget || target !== directionTarget) return false;
      const hypothesis = String(item.hypothesis || "");
      return !hypothesis || !directionHypothesis || hypothesis.includes(directionHypothesis) || directionHypothesis.includes(hypothesis);
    });
    return {
      ...intent,
      direction_id: direction.id,
      direction_status: direction.status,
      terminal_reason: direction.terminal_reason,
      claimed_by: direction.claimed_by || "",
      source_hypothesis: hypothesisById.get(intent.hypothesis_id) || null,
      confirmed_vulnerabilities: confirmed,
      candidate_negative_evidence: candidateNegatives,
    };
  });
  return {
    pendingFactRows, factRows, attackIntel, vulnerabilities, riskLeads, rawRiskLeads,
    directionRows, directionById, hypothesisById, sourceLeadsByVulnerability,
    verdicts: latestVerdictMap(project),
    indexedEvidence: evidenceResult.evidence || [],
  };
}
function directionStatusInfo(intent) {
  const terminalReason = String(intent.terminal_reason || "");
  const humanDismissed = intent.direction_status === "cancelled" && terminalReason.startsWith("human_dismissed:");
  const policyCooling = intent.direction_status === "released" && terminalReason.startsWith("policy_blocked_until:") && new Date(terminalReason.slice("policy_blocked_until:".length)).getTime() > Date.now();
  return {
    humanDismissed, policyCooling,
    label: humanDismissed ? "人工否决" : policyCooling ? "策略冷却" : intent.direction_status || "open",
  };
}
const LABELS = {
  phase: { intake: "接入", probe: "探测", recon: "侦察", hunt: "狩猎", verify: "验证", report: "报告" },
  role: { reason: "推理规划", metacog: "盲点检查", executor: "执行验证", reviewer: "质量复核", waf_analyst: "WAF 对抗", profile_mapper: "画像采集" },
  roleShort: { reason: "推理员", metacog: "盲点检查员", executor: "执行器", reviewer: "复核员", waf_analyst: "WAF 分析员", profile_mapper: "画像员" },
  stage: { swarm: "并发执行", review: "结果复核", commit: "结果提交", profile: "基础画像", profile_incremental: "增量画像", mrecon: "前置采集", finished: "已结束" },
  jobStatus: { queued: "排队", running: "运行中", completed: "已完成", failed: "失败", restricted: "策略受限", cancelled: "已取消", cancelling: "取消中" },
  verb: { verify: "验证", inspect: "检查", execute: "执行", waf_characterize: "WAF 刻画" },
  coverage: {
    api_endpoint: "API 路由", listening_port_service: "外网端口服务", priv_esc_path: "越权与鉴权边界",
    asset_web_directory: "目录与资产", framework_config: "框架与配置", parser_target: "解析与反序列化",
    supply_chain_third_party: "供应链组件", credential_leak: "外泄凭据", cloud_entitlement: "云权限边界",
    business_logic: "业务逻辑", ipc_endpoint: "IPC 通信", listening_port: "本地监听", lpe_path: "本地提权",
    asset: "文件信任", electron_config: "WebView 配置", supply_chain: "供应链更新", entitlement: "权限沙箱", deeplink: "深链路由",
  },
  coverageStatus: { unverified: "未观察", observed: "已观察", verified: "已验证" },
  hypothesisStatus: { proposed: "待评", selected: "已选中", testing: "验证中", supported: "已支持", blocked: "受阻", refuted: "已证伪" },
};
function labelOf(dict, key) { return LABELS[dict][key] || key || "—"; }
function phaseLabel(value) { return labelOf("phase", value); }
function roleLabel(value) { return labelOf("role", value); }
function roleShort(value) { return LABELS.roleShort[value] || "工作线程"; }
function stageLabel(value) { return labelOf("stage", value); }
function jobStatusLabel(value) { return labelOf("jobStatus", value); }
function verbLabel(value) { return labelOf("verb", value); }
const coverageLabels = LABELS.coverage;
const coverageStatusLabels = LABELS.coverageStatus;
function hypothesisStatusLabel(value) { return labelOf("hypothesisStatus", value); }
function isModelPolicyRestriction(value) {
  const text = String(value?.error || value || "").toLowerCase();
  return text.includes("flagged for possible cybersecurity risk") || text.includes("trusted access for cyber") || text.includes("content policy") || text.includes("safety policy refusal");
}
export {
  buildDerived, directionStatusInfo, factClassification, classificationLabel,
  verdictLabel, riskLeadLifecycle, vulnerabilityReferenceSet,
  phaseLabel, roleLabel, roleShort, stageLabel, jobStatusLabel, verbLabel,
  coverageLabels, coverageStatusLabels, hypothesisStatusLabel, isModelPolicyRestriction,
};
