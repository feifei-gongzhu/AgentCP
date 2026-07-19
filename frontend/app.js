const state = {
  vendor:null,projects:[],route:"hub",newTaskMode:false,runId:null,runStatus:null,timer:null,
  teamConfig:null,teamDirty:false,configVendor:null,targetConfig:null,targetDirty:false,
  targetConfigVendor:null,secretStatus:{},requestGeneration:0,
  gateContext:null,gateSubmitting:false,projectData:null,qualitySummary:null,
  promptMemberIndex:0,
};
const $ = id => document.getElementById(id);

const projectActionIds=[
  "deleteProjectButton","saveTargetButton","uploadClientArtifactButton","launchButton","cancelButton",
  "hintButton","addRoleButton","saveTeamButton","copyBoard",
  "enterProjectButton","startAuditButton","gateContinueButton","gateStopButton","submitFindingReview",
];
function setProjectControlsEnabled(enabled){
  projectActionIds.forEach(id=>{$(id).disabled=!enabled});
  if(enabled)$("cancelButton").disabled=true;
}

const routeNames=new Set(["hub","config","run"]);
function routeFromLocation(){
  const raw=location.hash.replace(/^#/,"");
  if(routeNames.has(raw))return raw;
  if(["target-setup","project-configuration","project-blackboard"].includes(raw))return "config";
  if(["overview","automation","intelligence","control"].includes(raw))return "run";
  return "hub";
}
function routeUrl(route){
  const params=new URLSearchParams(location.search);
  if(state.vendor)params.set("vendor",state.vendor);else params.delete("vendor");
  const query=params.toString();return `${location.pathname}${query?`?${query}`:""}#${route}`;
}
function applyRoute(requested){
  let route=routeNames.has(requested)?requested:"hub";
  if(route==="run"&&!state.vendor)route="hub";
  if(route==="config"&&!state.vendor&&!state.newTaskMode)route="hub";
  state.route=route;document.body.dataset.route=route;
  document.querySelectorAll("[data-view]").forEach(element=>{element.hidden=element.dataset.view!==route});
  document.querySelectorAll("[data-route-action]").forEach(element=>{
    const visible=element.dataset.routeAction.split(/\s+/).includes(route);
    const contextHidden=element.id==="viewRunButton"&&!state.runId;
    element.hidden=!visible||contextHidden;
  });
  document.querySelectorAll("[data-route-link]").forEach(link=>{
    const linkRoute=link.dataset.routeLink;link.classList.toggle("active",linkRoute===route);
    const unavailable=(linkRoute==="config"&&!state.vendor&&!state.newTaskMode)||(linkRoute==="run"&&!state.vendor);
    link.classList.toggle("disabled",unavailable);link.setAttribute("aria-disabled",String(unavailable));
  });
  $("newProjectBox").hidden=!state.newTaskMode;
  $("projectSelect").disabled=!state.projects.length;
  $("enterProjectButton").disabled=!state.vendor;
  $("deleteProjectButton").disabled=!state.vendor;
  const runActive=["running","paused","awaiting_approval","stopping"].includes(state.runStatus);
  $("startAuditButton").disabled=!state.vendor||!state.teamConfig||runActive;
  $("launchButton").disabled=!state.vendor||runActive;
  if(route==="hub"){$("routeEyebrow").textContent="授权安全研究工作区";$("projectTitle").textContent="任务中心"}
  else if(route==="config"){$("routeEyebrow").textContent="目标 · 模型团队 · 黑板";$("projectTitle").textContent=state.newTaskMode?"新建审计任务":`${state.vendor} · 项目配置`}
  else{$("routeEyebrow").textContent="实时审计过程 · 结论";$("projectTitle").textContent=`${state.vendor} · 执行与结果`}
  return route;
}
function navigate(route,{replace=false}={}){
  const resolved=applyRoute(route);history[replace?"replaceState":"pushState"]({},"",routeUrl(resolved));
}

function showToast(message,isError=false){
  const toast=$("toast"); toast.textContent=message;
  toast.className=`toast show${isError?" error":""}`;
  clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>toast.className="toast",4200);
}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const raw=await response.text();let payload;
  try{payload=raw?JSON.parse(raw):{}}
  catch(_error){throw new Error(`HTTP ${response.status}：服务返回了非 JSON 响应${raw?` · ${truncateText(raw,180)}`:""}`)}
  if(!response.ok||!payload.ok) throw new Error(payload.error||`HTTP ${response.status}`);
  return payload;
}
function setBadge(element,value){
  const normalized=String(value||"idle").toLowerCase(); element.textContent=normalized;
  const blocked=["awaiting_approval","paused","failed","cancelled","stopping","stopped"].includes(normalized);
  element.className=`status-badge ${blocked?"blocked":normalized==="completed"?"completed":normalized==="running"?"running":"neutral"}`;
}
function setConnectionStatus(text,online=false){
  $("connectionText").textContent=text;
  $("connectionText").parentElement.classList.toggle("online",online);
}
function cell(text,className=""){const td=document.createElement("td");td.textContent=text??"—";if(className)td.className=className;return td}
function factClassification(fact){
  if(fact.classification)return fact.classification;
  if(fact.status==="vulnerability")return "vulnerability";
  const attackSurfaceCategories=new Set(["asset","listening_port","electron_config","supply_chain","entitlement","deeplink"]);
  const impact=Number(fact.impact_score||0);
  if(attackSurfaceCategories.has(fact.category)&&impact<0.4)return "attack_surface";
  return "risk_lead";
}
function classificationLabel(value){
  return ({attack_surface:"攻击面",risk_lead:"线索",vulnerability:"漏洞",negative_evidence:"负向证据",inconclusive:"证据不足"})[value]||value||"攻击面";
}
function percent(value){return value==null?"—":`${Math.round(Number(value)*100)}%`}
function phaseLabel(value){return ({intake:"目标接入",phase_0_5_probe:"可达性探测",recon:"攻击面侦察",hunt:"漏洞狩猎",verify:"证据验证",report:"结果报告"})[value]||value||"目标接入"}
function hypothesisStatusLabel(value){return ({proposed:"候选",selected:"已选中",testing:"验证中",supported:"已支持",blocked:"受阻",rejected:"已证伪",completed:"已完成"})[value]||value||"候选"}
function renderFactRow(fact,{withImpact=false,pending=false}={}){
  const row=document.createElement("tr");
  const level=pending?`${fact.severity||"unknown"} · 待审查`:(fact.severity||classificationLabel(factClassification(fact)));
  const title=pending?`[候选] ${fact.title}`:fact.title;
  row.append(cell(level,`severity ${fact.severity||""}`),cell(title),cell(fact.business_impact||"尚未形成漏洞闭环"));
  if(withImpact)row.append(cell(percent(fact.impact_score)));
  row.append(cell(percent(fact.confidence)));
  return row;
}
function latestVerdictMap(project){const result={};(project.human_verdicts||[]).forEach(item=>{result[item.finding_id]=item});return result}
function verdictLabel(verdict){if(!verdict)return "待人工复核";const action=({accepted:"人工认可",adjusted:"人工调级",refuted:"已驳斥",reclassified:"已降级",retest_requested:"要求复验"})[verdict.action]||verdict.action;return `${action} · ${classificationLabel(verdict.final_classification)} · ${verdict.final_severity||"unknown"}`}
function evidenceForFact(fact,indexedEvidence){
  const configured=String(fact.evidence_path||"").replace(/\/+$/,"");
  return (indexedEvidence||[]).filter(item=>
    item.fact_id===fact.id||Boolean(configured&&(item.path===configured||String(item.path||"").startsWith(`${configured}/`)))
  );
}
function reproductionCell(fact,indexedEvidence){
  const wrapper=cell("","reproduction-cell");const steps=Array.isArray(fact.reproduction_steps)?fact.reproduction_steps.filter(Boolean):[];
  const matches=evidenceForFact(fact,indexedEvidence);const summary=document.createElement("strong");summary.textContent=`${steps.length} 步复现 · ${matches.length} 份证据`;wrapper.append(summary);
  if(steps.length){const list=document.createElement("ol");steps.forEach(step=>{const item=document.createElement("li");item.textContent=step;list.append(item)});wrapper.append(list)}
  else{const missing=document.createElement("small");missing.textContent="缺少结构化复现步骤";wrapper.append(missing)}
  const evidenceList=document.createElement("div");evidenceList.className="finding-evidence-links";
  matches.forEach(item=>{const button=document.createElement("button");button.type="button";button.className="button ghost small vulnerability-evidence-open";button.dataset.path=item.path;button.textContent=`查看证据 · ${item.path}`;button.title=`SHA-256 ${item.sha256||"未索引"}`;evidenceList.append(button)});
  if(!matches.length){const missing=document.createElement("small");missing.textContent=fact.evidence_path?`证据未进入索引：${fact.evidence_path}`:"漏洞未声明证据路径";evidenceList.append(missing)}
  wrapper.append(evidenceList);return wrapper;
}
function renderVulnerabilityRow(fact,verdict,indexedEvidence){
  const row=renderFactRow(fact,{withImpact:true,pending:fact.__pending});row.append(reproductionCell(fact,indexedEvidence));const action=cell("","human-review-cell");
  const label=document.createElement("small");label.textContent=verdictLabel(verdict);action.append(label);
  const button=document.createElement("button");button.type="button";button.className="button ghost small finding-review-open";button.dataset.findingId=fact.id;button.textContent=verdict?"重新判断":"人工判断";action.append(button);row.append(action);return row;
}
function riskLeadFromDirection(direction){
  const intent=direction.intent||{};
  const risk=String(intent.risk_level||"unknown").toLowerCase();
  const active=["open","claimed","released"].includes(direction.status);
  const meaningful=["critical","high","medium"].includes(risk)||intent.requires_human_confirmation;
  if(!active||!meaningful)return null;
  return {
    id:direction.id,
    title:intent.hypothesis||intent.target||"未指定目标",
    severity:risk,
    classification:"risk_lead",
    business_impact:intent.expected_business_impact||intent.success_criteria||"需要验证是否能形成具体业务危害闭环",
    impact_score:risk==="critical"?0.9:risk==="high"?0.75:0.55,
    confidence:direction.status==="claimed"?0.45:0.35,
    __direction:true,
    direction_status:direction.status,
    created_at:direction.created_at,
    updated_at:direction.updated_at,
  };
}
function projectTypeOption(value){
  const text=String(value||"").toLowerCase();
  if(text.includes("web")||text.includes("api")||text.includes("网站")||text.includes("网页"))return "Web渗透";
  if(text.includes("client")||text.includes("客户端")||text.includes("electron"))return "客户端";
  return "Web渗透";
}
const coverageLabels={
  api_endpoint:"接口路由挖掘",
  listening_port_service:"外网端口与服务识别",
  priv_esc_path:"越权与鉴权边界",
  asset_web_directory:"目录与资产暴破",
  framework_config:"框架指纹与配置缺陷",
  parser_target:"输入解析与反序列化测试",
  supply_chain_third_party:"供应链与三方组件识别",
  credential_leak:"外泄凭据检索",
  cloud_entitlement:"云原生边界探测",
  business_logic:"业务逻辑黑盒对抗",
  ipc_endpoint:"进程通信入口",
  listening_port:"监听端口",
  lpe_path:"本地提权路径",
  asset:"资产识别",
  electron_config:"客户端框架配置",
  supply_chain:"供应链组件",
  entitlement:"权限声明",
  deeplink:"深链与生命周期入口",
};
const coverageStatusLabels={unverified:"未验证",observed:"已观察",verified:"已验证"};
const roleLabels={
  reason:"推理规划",
  metacog:"盲点检查",
  executor:"执行验证",
  pentester:"执行验证",
  reviewer:"质量复核",
  waf_analyst:"WAF 对抗分析",
};
const stageLabels={
  swarm:"并发执行",
  review:"结果复核",
  commit:"写入黑板",
  finished:"已结束",
};
const jobStatusLabels={
  queued:"排队中",
  running:"运行中",
  completed:"已完成",
  restricted:"模型策略受限",
  failed:"失败",
  cancelled:"已取消",
  paused:"已暂停",
  cancelling:"正在取消",
  stopping:"正在停止",
  stopped:"已停止",
};
function roleLabel(value){return roleLabels[value]||value||"模型角色"}
function stageLabel(value){return stageLabels[value]||value||"—"}
function jobStatusLabel(value){return jobStatusLabels[value]||value||"等待中"}
function workerLabel(job){
  const raw=String(job.member_name||"worker");
  const role=job.role||"";
  const slotMatch=raw.match(/#(\d+)$/);
  const slot=slotMatch?` ${slotMatch[1]}`:"";
  const base={
    reason:"推理员",
    metacog:"盲点检查员",
    executor:"执行器",
    pentester:"执行器",
    reviewer:"复核员",
    waf_analyst:"WAF 分析员",
  }[role]||"工作线程";
  return `${base}${slot}`;
}
function verbLabel(value){
  return ({
    inspect:"检查",
    reason:"推理",
    verify:"验证",
    execute:"执行",
    review:"复核",
    exploit:"验证利用",
  })[value]||value||"执行";
}
function emptyRow(body,columns,text="暂无记录"){
  body.replaceChildren();const row=document.createElement("tr");const td=cell(text,"empty-row");td.colSpan=columns;row.append(td);body.append(row);
}
function renderRows(body,items,columns,mapper){
  if(!items.length)return emptyRow(body,columns);body.replaceChildren();[...items].reverse().slice(0,60).forEach(item=>body.append(mapper(item)));
}

function modelInfoForJob(job){
  const member=job.payload?.member||{};
  return {
    model:job.model||member.model||job.result?.model||"默认模型",
    driver:job.driver||member.type||member.backend||job.backend||null,
  };
}
function formatEventTime(value){
  if(!value)return "—";
  const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString();
}
function ageLabel(value){
  if(!value)return "时间未知";
  const timestamp=new Date(value).getTime();
  if(Number.isNaN(timestamp))return "时间未知";
  const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));
  if(seconds<60)return "刚刚";
  const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes} 分钟前`;
  const hours=Math.floor(minutes/60);if(hours<24)return `${hours} 小时前`;
  return `${Math.floor(hours/24)} 天前`;
}
function riskLeadLifecycle(item){
  if(item.__pending)return {key:"pending_commit",label:"待收敛",detail:"模型结果尚未写入黑板"};
  if(item.__direction){
    if(item.direction_status==="claimed")return {key:"validating",label:"验证中",detail:"执行器已认领"};
    const cooldown=String(item.terminal_reason||"").match(/^policy_blocked_until:(.+)$/);
    if(cooldown&&new Date(cooldown[1]).getTime()>Date.now())return {key:"blocked",label:"模型策略冷却",detail:`${formatEventTime(cooldown[1])} 后可重新调度`};
    const createdAt=new Date(item.created_at||item.updated_at||0).getTime();
    const stale=Number.isFinite(createdAt)&&createdAt>0&&Date.now()-createdAt>=24*60*60*1000;
    if(stale)return {key:"stale",label:"已积压",detail:"等待超过 24 小时，需调度或人工处理"};
    if(item.direction_status==="released")return {key:"queued",label:"已释放重排",detail:"前次未闭环，等待重新认领"};
    return {key:"queued",label:"排队验证",detail:"等待执行器认领"};
  }
  if(item.intent_id)return {key:"queued",label:"待关联验证",detail:`已关联方向 ${item.intent_id}`};
  return {key:"unscheduled",label:"待转验证",detail:"尚未生成可执行验证方向"};
}
function riskLeadIdentity(item){
  const normalize=value=>String(value||"").replace(/^\[(?:候选|待验证|执行中)\]\s*/,"").replace(/\s+/g," ").trim().toLocaleLowerCase();
  return `${normalize(item.title)}\u001f${normalize(item.business_impact)}`;
}
function deduplicateRiskLeads(items){
  const priority={validating:6,pending_commit:5,queued:4,unscheduled:3,stale:2};
  const selected=new Map();
  items.forEach(item=>{
    const key=riskLeadIdentity(item);const lifecycle=riskLeadLifecycle(item);
    const current=selected.get(key);const currentLifecycle=current?riskLeadLifecycle(current):null;
    if(!current||(priority[lifecycle.key]||0)>(priority[currentLifecycle.key]||0))selected.set(key,item);
  });
  return [...selected.values()].sort((left,right)=>{
    const stateDiff=(priority[riskLeadLifecycle(right).key]||0)-(priority[riskLeadLifecycle(left).key]||0);
    return stateDiff||String(right.updated_at||right.created_at||"").localeCompare(String(left.updated_at||left.created_at||""));
  });
}
function renderRiskLeadRow(item){
  const row=document.createElement("tr");const lifecycle=riskLeadLifecycle(item);
  const level=item.__pending?`${item.severity||"unknown"} · 待审查`:(item.severity||"unknown");
  const title=item.__pending?`[候选] ${item.title}`:item.title;
  const stateCell=cell("",`lead-state ${lifecycle.key}`);
  const state=document.createElement("strong");state.textContent=lifecycle.label;
  const detail=document.createElement("small");detail.textContent=lifecycle.detail;stateCell.append(state,document.createElement("br"),detail);
  const timestamp=item.created_at||item.updated_at;
  const timeCell=cell("","lead-time");const absolute=document.createElement("span");absolute.textContent=formatEventTime(timestamp);
  const age=document.createElement("small");age.textContent=ageLabel(timestamp);timeCell.append(absolute,document.createElement("br"),age);
  row.append(cell(level,`severity ${item.severity||""}`),cell(title),stateCell,timeCell,cell(item.business_impact||"尚未形成漏洞闭环"),cell(percent(item.impact_score)),cell(percent(item.confidence)));
  return row;
}
function truncateText(value,limit=260){
  const text=String(value||"").trim();return text.length>limit?`${text.slice(0,limit)}…`:text;
}
function isModelPolicyRestriction(value){
  const text=String(value?.error||value||"").toLowerCase();
  return text.includes("flagged for possible cybersecurity risk")||text.includes("trusted access for cyber")||text.includes("content policy")||text.includes("safety policy refusal");
}
function activityForJob(job){
  const intent=job.payload?.direction?.intent;
  if(intent)return {verb:intent.verb||"execute",target:intent.target||"未指定目标",success_criteria:intent.success_criteria||"",evidence_sink:intent.evidence_sink||"",risk_level:intent.risk_level||"unknown"};
  const defaults={
    reason:["分析黑板并生成审计方向","产出可执行 Intent 或有证据的 Fact"],
    metacog:["检查盲点、反例与高价值路径","补充或修正当前审计方向"],
    reviewer:["审查候选结果与证据质量","决定接受、驳回或请求人工确认"],
  };
  const fallback=defaults[job.role]||[`执行 ${job.role||"worker"} 角色任务`,"返回结构化候选结果"];
  return {verb:job.role||"worker",target:fallback[0],success_criteria:fallback[1],evidence_sink:"",risk_level:""};
}
function latestModelSignal(job,events){
  const matching=[...events].reverse().filter(event=>event.job_id===job.id);
  const progressTypes=["model_tool_started","model_tool_completed","model_assistant_update","model_stream_result"];
  if(["completed","failed","restricted","cancelled"].includes(job.status))return matching.find(event=>["model_call_completed","model_call_failed","model_policy_restricted"].includes(event.event_type))||matching[0];
  if(job.status==="queued")return matching.find(event=>["model_retry_scheduled","model_call_failed"].includes(event.event_type))||matching[0];
  const startIndex=matching.findIndex(event=>event.event_type==="model_call_started");
  const currentAttempt=startIndex<0?matching:matching.slice(0,startIndex+1);
  return currentAttempt.find(event=>progressTypes.includes(event.event_type))||currentAttempt.find(event=>["model_stream_started","model_call_started","model_call_waiting"].includes(event.event_type));
}
function jobSignalText(job,event){
  const data=event?.data||{};
  if(event?.event_type==="model_tool_started")return `正在执行工具：${data.tool_name||"Claude Tool"} · ${truncateText(data.input_summary,100)}`;
  if(event?.event_type==="model_tool_completed")return data.is_error?`工具执行失败：${data.tool_name||"Claude Tool"}`:`工具已完成：${data.tool_name||"Claude Tool"}，等待下一步`;
  if(event?.event_type==="model_assistant_update")return `Claude 正在分析：${truncateText(data.text,100)}`;
  if(event?.event_type==="model_stream_result")return "Claude 已返回最终结果，正在持久化";
  if(event?.event_type==="model_stream_started")return "Claude 会话已建立，等待第一个工具动作";
  if(job.status==="running")return data.elapsed_seconds==null?"等待 Claude CLI 返回":`等待 Claude CLI 返回 · ${data.elapsed_seconds}s / ${data.timeout_seconds||"?"}s`;
  if(job.status==="queued")return job.attempts?"等待下一次重试":"等待 Worker 领取";
  if(job.status==="completed")return "模型结果已接收并持久化";
  if(job.status==="restricted")return "模型策略受限，未产生候选结果";
  if(job.status==="cancelled")return "任务已取消";
  if(job.status==="failed")return isModelPolicyRestriction(job)?"模型策略受限":"模型任务失败";
  return job.status||"等待状态更新";
}
function renderRunFailure(automation){
  const alert=$("runFailure");const run=automation.run||{};const jobs=automation.jobs||[];
  const failedJob=[...jobs].reverse().find(job=>job.error&&["failed","cancelled"].includes(job.status));
  const restrictedJob=[...jobs].reverse().find(job=>job.error&&job.status==="restricted");
  const runFailed=run.status==="failed";
  const runStopped=["stopped","cancelled"].includes(run.status);
  const error=runStopped?(run.error||"运行已由用户停止"):runFailed?(run.error||failedJob?.error):restrictedJob?.error||failedJob?.error;
  if(!error){alert.hidden=true;alert.replaceChildren();return}
  const policyRestricted=!runFailed&&!runStopped&&Boolean(restrictedJob||isModelPolicyRestriction(failedJob));
  const title=document.createElement("strong");title.textContent=runStopped?"运行已停止":runFailed?"运行失败":policyRestricted?"模型策略受限":"模型任务失败";
  const detail=document.createElement("span");detail.textContent=truncateText(error,900);detail.title=String(error);
  alert.className=`run-failure${runFailed?" critical":""}`;alert.replaceChildren(title,detail);alert.hidden=false;
}
function renderGateApproval(data,automation){
  const card=$("gateApprovalCard");const run=automation.run||null;
  const awaiting=data.gate_status==="awaiting_approval";
  const visible=awaiting;
  state.gateContext={visible,awaiting,run,data};card.hidden=!visible;
  if(!visible)return;
  $("gateApprovalReason").textContent=data.gate_reason||run?.error||"自动化运行已暂停，必须由用户明确批准后才能继续。";
  $("gateApprovalPhase").textContent=phaseLabel(data.phase);
  $("gateApprovalElapsed").textContent=`${data.elapsed_minutes??0} min`;
  $("gateApprovalAssets").textContent=`${data.asset_count??0} / ${data.vulnerability_count??0}`;
  $("gateApprovalHighRisk").textContent=data.high_risk_fingerprint_count??0;
  $("gateApprovalDiscovery").textContent=data.last_discovery_at?formatEventTime(data.last_discovery_at):"无";
  $("gateApprovalRun").textContent=run?`${run.id} · ${run.status}`:"无可恢复运行";
  setBadge($("gateApprovalRunBadge"),awaiting?"awaiting_approval":run?.status||"paused");
  $("gateContinueButton").textContent=run?.status==="paused"?"批准并恢复运行":["completed","failed","stopped","cancelled"].includes(run?.status)?"批准并开始下一轮":"批准继续";
  $("gateStopButton").textContent=["completed","failed","stopped","cancelled"].includes(run?.status)?"确认止损，不再续跑":"止损并终止运行";
  $("gateContinueButton").disabled=state.gateSubmitting;
  $("gateStopButton").disabled=state.gateSubmitting;
}
function objectiveGateReason(action,context){
  const data=context.data||{};const note=$("gateApprovalNote").value.trim();
  const decision=action==="continue"?"批准继续":"批准止损结束";
  const objective=`${decision}；阶段 ${phaseLabel(data.phase)}，已用 ${data.elapsed_minutes??0} min，资产 ${data.asset_count??0} 个，漏洞 ${data.vulnerability_count??0} 个，敏感线索 ${data.high_risk_fingerprint_count??0} 个。`;
  return note?`${objective} 人工备注：${note}`:objective;
}
async function submitGateDecision(action){
  const context=state.gateContext;if(!state.vendor||!context?.visible)return showToast("当前没有待批准的强制门禁",true);
  if(action==="stop_loss"&&!window.confirm("确认止损结束？对应自动化运行会被终止，未完成任务不会继续。"))return;
  state.gateSubmitting=true;const continueButton=$("gateContinueButton");const stopButton=$("gateStopButton");
  continueButton.disabled=true;stopButton.disabled=true;
  const activeButton=action==="continue"?continueButton:stopButton;const originalText=activeButton.textContent;
  activeButton.textContent=action==="continue"?"正在批准并恢复…":"正在止损并结束…";
  try{
    const result=await api("/api/gate/approve",{method:"POST",body:JSON.stringify({
      vendor:state.vendor,action,reason:objectiveGateReason(action,context),run_id:context.run?.id||"",
    })});
    $("gateApprovalNote").value="";
    if(result.transition==="started_next_iteration")showToast(`门禁已批准，下一轮 ${result.run_id} 已启动`);
    else if(result.resumed)showToast(`门禁已批准，运行 ${result.run_id} 已恢复`);
    else if(result.cancelled)showToast(`止损已批准，运行 ${result.run_id} 已结束`);
    else showToast(action==="continue"?"门禁已批准，可以继续执行":"止损决定已提交");
    await refresh();
  }catch(error){showToast(error.message,true)}
  finally{
    state.gateSubmitting=false;activeButton.textContent=originalText;
    if(state.gateContext?.visible){continueButton.disabled=false;stopButton.disabled=false}
  }
}
function friendlyEvent(event){
  const type=event.event_type||event.action||"event";const data=event.data||event.details||{};
  const member=data.member||data.member_name||"模型任务";
  const activity=data.activity||{};const activityTarget=activity.target||null;
  if(type==="model_local_guest_image_build_started")return {
    kind:"started",title:"正在构建本地运行镜像",summary:data.image||"agent-compose-guest:latest",
    detail:"首次使用本地 Docker 时只构建一次；并发 Worker 会等待并复用该镜像。",
  };
  if(type==="model_local_guest_image_build_progress")return {
    kind:"waiting",title:"本地镜像构建中",summary:data.image||"agent-compose-guest:latest",detail:data.text,
  };
  if(type==="model_local_guest_image_build_completed")return {
    kind:"completed",title:"本地运行镜像已就绪",summary:data.image||"agent-compose-guest:latest",
  };
  if(type==="model_stream_started")return {
    kind:"started",title:"Claude 会话已建立",summary:member,
    meta:[data.session_id&&`会话 ${data.session_id}`,Array.isArray(data.tools)&&data.tools.length&&`可用工具 ${data.tools.length} 个`].filter(Boolean).join(" · "),
  };
  if(type==="model_agent_compose_log")return {
    kind:"assistant",title:"模型实时输出",summary:member,
    meta:activityTarget&&`当前任务：${activityTarget}`,detail:data.text,
  };
  if(type==="model_agent_compose_status")return {
    kind:data.status==="failed"?"failed":"waiting",title:"模型运行状态",summary:member,
    meta:data.status?`状态：${data.status}`:"agent-compose 运行中",
  };
  if(type==="model_agent_compose_run_completed")return {
    kind:"completed",title:"模型任务完成",summary:member,
    meta:data.duration_ms!=null?`耗时 ${(Number(data.duration_ms)/1000).toFixed(1)}s`:"agent-compose 已返回结果",
  };
  if(type==="model_tool_started")return {
    kind:"tool-running",title:"正在执行工具",summary:data.tool_name||"Claude Tool",
    meta:activityTarget&&`任务目标：${activityTarget}`,
    detail:data.input_summary||"工具未提供参数摘要",
  };
  if(type==="model_tool_completed")return {
    kind:data.is_error?"failed":"tool-completed",title:data.is_error?"工具执行失败":"工具执行完成",summary:data.tool_name||"Claude Tool",
    meta:data.tool_use_id&&`调用 ${data.tool_use_id}`,
    detail:data.output_summary||"工具未提供结果摘要",
  };
  if(type==="model_assistant_update")return {
    kind:"assistant",title:"Claude 阶段输出",summary:member,detail:data.text,
  };
  if(type==="model_stream_result")return {
    kind:data.is_error?"failed":"completed",title:data.is_error?"Claude 返回错误结果":"Claude 已返回最终结果",summary:member,
    meta:[data.duration_ms!=null&&`耗时 ${(Number(data.duration_ms)/1000).toFixed(1)}s`,data.num_turns!=null&&`${data.num_turns} 轮`].filter(Boolean).join(" · "),
  };
  if(type==="model_call_started")return {
    kind:"started",title:"正在调用模型",summary:activityTarget||`${member} · ${data.model||"默认模型"}`,
    meta:[data.driver&&`驱动 ${data.driver}`,data.endpoint&&`服务 ${data.endpoint}`,data.attempt&&`第 ${data.attempt}/${data.max_attempts||"?"} 次`,data.timeout_seconds&&`超时 ${data.timeout_seconds}s`].filter(Boolean).join(" · "),
    detail:activity.success_criteria&&`成功标准：${activity.success_criteria}${activity.evidence_sink?` · 证据输出：${activity.evidence_sink}`:""}`,
  };
  if(type==="model_call_completed")return {
    kind:"completed",title:"模型调用完成",summary:member,
    meta:data.duration_seconds==null?"已收到并持久化模型响应":`耗时 ${data.duration_seconds}s · 已收到并持久化模型响应`,
  };
  if(type==="model_call_failed")return {
    kind:"failed",title:/402|insufficient balance/i.test(data.error||"")?"模型账户余额不足，已停止重试":data.retryable?"模型调用失败，可重试":"模型调用失败，已停止重试",summary:member,
    meta:[data.duration_seconds!=null&&`耗时 ${data.duration_seconds}s`,data.status&&`任务状态 ${data.status}`].filter(Boolean).join(" · "),error:data.error,
  };
  if(type==="model_policy_restricted")return {
    kind:"waiting",title:"模型策略受限",summary:member,
    meta:[data.duration_seconds!=null&&`耗时 ${data.duration_seconds}s`,"已停止重试，其他并发结果继续收敛"].filter(Boolean).join(" · "),
    detail:data.error,
  };
  if(type==="model_policy_fallback_started")return {
    kind:"retry",title:"切换为内置角色提示词重试",summary:member,
    meta:"项目提示词保持原样保存；本次调用不再附加触发策略的自定义内容",
    detail:data.reason,
  };
  if(["model_call_retry","model_call_retried","model_retry_scheduled","model_call_retry_scheduled"].includes(type))return {
    kind:"retry",title:"已安排模型重试",summary:member,
    meta:data.next_attempt?`下一次：第 ${data.next_attempt}/${data.max_attempts||"?"} 次`:"即将重新调用模型服务",
  };
  if(type==="model_call_waiting")return {
    kind:"waiting",title:"等待 Claude CLI 新事件",summary:activityTarget||member,
    meta:data.elapsed_seconds==null?"AgentCP 调度心跳正常":`已等待 ${data.elapsed_seconds}s / ${data.timeout_seconds||"?"}s · AgentCP 调度心跳正常`,
    detail:"这是调度心跳；任务行会继续保留最近一次 Claude 工具动作。",
  };
  return null;
}
function renderEvent(event){
  const friendly=friendlyEvent(event);const row=document.createElement("div");
  row.className=`event-row${friendly?` model-event ${friendly.kind}`:""}`;
  const time=document.createElement("time");time.textContent=formatEventTime(event.created_at);
  if(!friendly){
    const type=document.createElement("strong");type.textContent=event.event_type||event.action;
    const detail=document.createElement("small");detail.textContent=JSON.stringify(event.data||event.details||{});
    row.append(time,type,detail);return row;
  }
  const content=document.createElement("div");content.className="model-event-content";
  const heading=document.createElement("div");heading.className="model-event-heading";
  const title=document.createElement("strong");title.textContent=friendly.title;
  const summary=document.createElement("span");summary.textContent=friendly.summary;heading.append(title,summary);content.append(heading);
  if(friendly.meta){const meta=document.createElement("small");meta.textContent=friendly.meta;content.append(meta)}
  if(friendly.detail){const detail=document.createElement("p");detail.className="model-event-detail";detail.textContent=friendly.detail;content.append(detail)}
  if(friendly.error){const error=document.createElement("code");error.textContent=truncateText(friendly.error,700);error.title=String(friendly.error);content.append(error)}
  row.append(time,content);return row;
}

function fieldControl(field,value,options=null,className=""){
  const control=document.createElement(options?"select":"input");control.dataset.field=field;if(className)control.className=className;
  if(options){options.forEach(item=>{const option=document.createElement("option");const optionValue=typeof item==="object"?item.value:item;option.value=optionValue;option.textContent=typeof item==="object"?item.label:item;control.append(option)});control.value=value||(typeof options[0]==="object"?options[0].value:options[0])}
  else{control.value=value??"";if(["max_running","priority"].includes(field)){control.type="number";control.min=field==="max_running"?"1":"0"}}
  return control;
}
function runtimeSecretControl(member){
  const control=document.createElement("input");control.type="password";control.autocomplete="new-password";control.dataset.runtimeSecret="true";
  control.placeholder=state.secretStatus[member.name]?"已安全保存，留空保持":"填写后保存到系统钥匙串";return control;
}
function renderTeamEditor(config,force=false){
  if(state.teamDirty&&!force&&state.configVendor===state.vendor)return;
  state.teamConfig=structuredClone(config||{name:"project",members:[]});state.configVendor=state.vendor;if(!state.teamDirty||force)state.teamDirty=false;
  const body=$("roleConfigBody");body.replaceChildren();
  (state.teamConfig.members||[]).forEach((member,index)=>{
    const row=document.createElement("tr");row.dataset.index=String(index);
    const controls=[
      fieldControl("name",member.name),
      fieldControl("role",member.role,[
        {value:"reason",label:"推理规划"},
        {value:"metacog",label:"盲点检查"},
        {value:"executor",label:"执行验证"},
        {value:"reviewer",label:"质量复核"},
        {value:"pentester",label:"执行验证"},
        {value:"waf_analyst",label:"WAF 对抗分析"},
      ]),
      fieldControl("runtime_mode",member.runtime_mode||"local-docker",[
        {value:"local-docker",label:"本地 Docker（默认）"},
        {value:"agent-compose",label:"CT agent-compose"},
        {value:"local-cli",label:"本地 CLI"},
      ]),
      fieldControl("type",member.type||member.backend||"codex",["codex","claude-cli","openai-compatible","ollama"]),
      fieldControl("model",member.model||""),
      fieldControl("base_url",member.base_url||"",null,"wide-input"),
      fieldControl("api_key_env",member.api_key_env||""),
      fieldControl("auth_mode",member.auth_mode||"auto",["auto","bearer","x-api-key"]),
      runtimeSecretControl(member),
      fieldControl("sandbox",member.sandbox||"read-only",["read-only","workspace-write","danger-full-access"]),
      fieldControl("max_running",member.max_running||1),
      fieldControl("priority",member.priority||0),
    ];
    controls.forEach(control=>{const td=document.createElement("td");td.append(control);row.append(td)});
    const action=cell("");const remove=document.createElement("button");remove.type="button";remove.className="button danger small role-remove";remove.textContent="删除";action.append(remove);row.append(action);body.append(row);
  });
  renderRolePromptEditor();
}
function renderRolePromptEditor(){
  const select=$("rolePromptMember");const textarea=$("rolePromptText");const status=$("rolePromptStatus");
  select.replaceChildren();const members=state.teamConfig?.members||[];
  if(!members.length){textarea.value="";textarea.disabled=true;select.disabled=true;status.textContent="请先添加 Agent。";return}
  state.promptMemberIndex=Math.min(Math.max(Number(state.promptMemberIndex)||0,0),members.length-1);
  members.forEach((member,index)=>{const option=document.createElement("option");option.value=String(index);option.textContent=`${member.name} · ${roleLabel(member.role)}`;select.append(option)});
  select.value=String(state.promptMemberIndex);select.disabled=false;textarea.disabled=false;
  textarea.value=members[state.promptMemberIndex].custom_prompt||"";
  status.textContent=`当前编辑：${members[state.promptMemberIndex].name}。已输入 ${textarea.value.length}/30000 字符；保存并应用后生效。`;
}
function clearRolePromptEditor(message="请先加载项目。"){
  $("rolePromptMember").replaceChildren();$("rolePromptMember").disabled=true;$("rolePromptText").value="";$("rolePromptText").disabled=true;$("rolePromptStatus").textContent=message;
}
function collectTeamConfig(){
  if(!state.teamConfig)return {name:"project",members:[]};
  const members=[...$("roleConfigBody").querySelectorAll("tr")].map(row=>{
    const original=state.teamConfig.members[Number(row.dataset.index)]||{};const member={...original};
    row.querySelectorAll("[data-field]").forEach(control=>{let value=control.value.trim();if(["max_running","priority"].includes(control.dataset.field))value=Number(value);member[control.dataset.field]=value||(["model","base_url","api_key_env"].includes(control.dataset.field)?null:value)});
    member.env=original.env||{};member.dangerously_bypass_sandbox=false;delete member.backend;return member;
  });
  return {name:"project",members};
}
function collectRuntimeSecrets(){const secrets={};$("roleConfigBody").querySelectorAll("tr").forEach(row=>{const name=row.querySelector('[data-field="name"]').value.trim();const value=row.querySelector('[data-runtime-secret="true"]').value.trim();if(name&&value)secrets[name]=value});return secrets}

function renderTargetEditor(target,force=false){
  if(state.targetDirty&&!force&&state.targetConfigVendor===state.vendor)return;
  state.targetConfig=structuredClone(target||{});state.targetConfigVendor=state.vendor;if(!state.targetDirty||force)state.targetDirty=false;
  $("targetTargets").value=(state.targetConfig.targets||[]).join("\n");
  $("targetPath").value=state.targetConfig.target_path||"";
  $("targetProjectType").value=projectTypeOption(state.targetConfig.project_type);
  $("targetGoal").value=state.targetConfig.goal||"";
  $("targetOutOfScope").value=(state.targetConfig.out_of_scope||[]).join("\n");
  $("targetSuccessCriteria").value=(state.targetConfig.success_criteria||[]).join("\n");
  $("targetNotes").value=state.targetConfig.notes||"";
  $("saveTargetButton").disabled=!state.vendor;
  renderClientUpload();
}
function renderClientUpload(){
  const visible=projectTypeOption($("targetProjectType").value)==="客户端";
  $("clientUploadPanel").hidden=!visible;
  $("webTargetField").hidden=visible;
  $("localTargetPathField").hidden=visible;
  if(!visible)return;
  const file=$("clientArtifactFile").files?.[0];
  $("uploadClientArtifactButton").disabled=!state.vendor||!file;
  const artifact=state.targetConfig?.uploaded_artifact;
  $("clientUploadStatus").textContent=artifact
    ? `当前文件：${artifact.name} · ${Number(artifact.size||0).toLocaleString()} bytes · SHA-256 ${String(artifact.sha256||"").slice(0,16)}…`
    : state.vendor?(file?`待上传：${file.name} · ${file.size.toLocaleString()} bytes`:`请选择文件。单文件默认上限 2 GiB。`):"请先创建或选择项目，再上传文件。";
}
function lines(id){return $(id).value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean)}
function collectTargetConfig(){const client=projectTypeOption($("targetProjectType").value)==="客户端";return {
  targets:client?[]:lines("targetTargets"),target_path:client?(state.targetConfig?.uploaded_artifact?state.targetConfig.target_path||"":""):$("targetPath").value.trim(),project_type:$("targetProjectType").value.trim(),
  goal:$("targetGoal").value.trim(),out_of_scope:lines("targetOutOfScope"),success_criteria:lines("targetSuccessCriteria"),notes:$("targetNotes").value.trim()
}}

function renderProjectCards(){
  const container=$("projectCards");container.replaceChildren();
  if(!state.projects.length){
    const empty=document.createElement("div");empty.className="hub-empty";
    const content=document.createElement("div");const title=document.createElement("h2");title.textContent="还没有审计项目";
    const description=document.createElement("p");description.textContent="点击“新建审计任务”，先录入授权目标，再配置模型团队。";
    content.append(title,description);empty.append(content);container.append(empty);return;
  }
  state.projects.forEach(project=>{
    const card=document.createElement("article");card.className=`project-card${project.vendor===state.vendor?" selected":""}`;card.dataset.vendor=project.vendor;
    const head=document.createElement("div");head.className="project-card-head";
    const heading=document.createElement("h3");heading.textContent=project.vendor;
    const badge=document.createElement("span");setBadge(badge,project.run_status||project.gate_status||"idle");head.append(heading,badge);
    const summary=document.createElement("p");summary.className="subtle";summary.textContent=project.current_task||project.goal||"尚未定义当前审计任务";
    const meta=document.createElement("div");meta.className="project-card-meta";
    [["阶段",phaseLabel(project.phase)],["目标",`${project.target_count??0} 个`],["事实",`${project.fact_count??0} 条`],["漏洞",`${project.vulnerability_count??0} 个`]].forEach(([label,value])=>{
      const item=document.createElement("span");item.textContent=label;const strong=document.createElement("strong");strong.textContent=value;item.append(strong);meta.append(item);
    });
    const quality=project.quality_metrics||{};const qualityBox=document.createElement("div");qualityBox.className="project-card-quality";
    const qualityHead=document.createElement("div");const qualityLabel=document.createElement("span");qualityLabel.textContent="项目误报率";const qualityRate=document.createElement("strong");qualityRate.textContent=quality.false_positive_rate==null?"暂无样本":percent(quality.false_positive_rate);qualityHead.append(qualityLabel,qualityRate);
    const qualityTrack=document.createElement("div");qualityTrack.className="quality-rate-track";const qualityFill=document.createElement("i");qualityFill.style.width=quality.false_positive_rate==null?"0%":percent(quality.false_positive_rate);qualityTrack.append(qualityFill);
    const qualityDetail=document.createElement("small");qualityDetail.textContent=`已复核 ${quality.reviewed??0} · 驳斥 ${quality.false_positives??0} · 待复核 ${quality.pending??0}`;
    qualityBox.append(qualityHead,qualityTrack,qualityDetail);
    const updated=document.createElement("small");updated.className="subtle";updated.textContent=project.updated_at?`更新于 ${new Date(project.updated_at).toLocaleString()}`:"尚未更新";
    const open=document.createElement("button");open.type="button";open.className=`button ${project.gate_status==="awaiting_approval"?"primary":"secondary"} project-open`;open.dataset.vendor=project.vendor;open.dataset.route=project.gate_status==="awaiting_approval"?"run":"config";open.textContent=project.gate_status==="awaiting_approval"?"处理控制器审批":"配置项目";
    card.append(head,summary,meta,qualityBox,updated,open);container.append(card);
  });
}

function renderProject(project,metrics,automation,config,evidenceResult,auditResult){
  state.projectData=project;
  const data=project.state;state.runId=automation.run?.id||null;state.runStatus=automation.run?.status||null;
  $("interventionScopeNote").textContent=automation.run&&["running","paused"].includes(automation.run.status)?`关联运行 ${automation.run.id}；从下一次 Worker 调度开始生效`:`当前没有活动 Run；内容会保留并在下一轮开始时生效`;
  setProjectControlsEnabled(true);
  $("currentTask").textContent=data.current_task||"尚未定义当前任务";
  $("goalText").textContent=project.target.goal||`授权模式：${project.target.authorization_mode} · scope ${JSON.stringify(project.target.scope)}`;
  $("phaseValue").textContent=phaseLabel(data.phase);
  $("updatedValue").textContent=data.updated_at?`更新于 ${new Date(data.updated_at).toLocaleString()}`:"尚未更新";
  $("decisionValue").textContent=data.current_decision||"continue";
  $("gateReason").textContent=data.gate_reason||"尚未触发强制节拍";
  setBadge($("gateBadge"),data.gate_status==="awaiting_approval"?"awaiting_approval":automation.run?.status||"idle");
  renderGateApproval(data,automation);
  const jobs=automation.jobs||[];const terminalJobs=jobs.filter(job=>["completed","failed","restricted","cancelled","cancelling"].includes(job.status));
  const completedJobs=jobs.filter(job=>job.status==="completed").length;const failedJobs=jobs.filter(job=>["failed","cancelled","cancelling"].includes(job.status)).length;
  const restrictedJobs=jobs.filter(job=>job.status==="restricted").length;
  const currentRun=metrics.automation.current_run||{jobs:jobs.length,finished_jobs:terminalJobs.length,completed_jobs:completedJobs,failed_jobs:failedJobs,restricted_jobs:restrictedJobs,progress_rate:jobs.length?terminalJobs.length/jobs.length:0};
  const declaredAssets=new Set((project.target.targets||[]).map(value=>String(value).trim().toLowerCase()).filter(Boolean)).size;
  const assetTotal=metrics.assets?.total??Math.max(data.asset_count??0,declaredAssets);
  const pendingFacts=metrics.quality.pending_facts??jobs.filter(job=>job.status==="completed"&&!job.committed_at&&job.result?.payload?.kind==="fact").length;
  $("assetMetric").textContent=assetTotal;
  $("assetMetricNote").textContent=metrics.assets?`${metrics.assets.declared} 个目标 · ${metrics.assets.discovered} 个新发现`:`${declaredAssets} 个已配置目标`;
  $("factMetric").textContent=metrics.quality.facts;
  $("factMetricNote").textContent=pendingFacts?`${metrics.quality.facts} 已入库 · ${pendingFacts} 待提交`:`${metrics.quality.facts} 条已提交到黑板`;
  $("vulnMetric").textContent=metrics.quality.vulnerabilities;
  $("vulnMetricNote").textContent=`系统漏洞池 · ${project.quality_metrics?.pending??0} 待人工复核`;
  $("coverageMetric").textContent=`${Math.round(metrics.coverage.coverage_rate*100)}%`;
  $("coverageMetricNote").textContent=`${metrics.coverage.covered}/${metrics.coverage.dimensions} 个维度已观察`;
  $("jobMetric").textContent=`${Math.round(currentRun.progress_rate*100)}%`;
  $("jobMetricNote").textContent=currentRun.jobs?`${currentRun.finished_jobs}/${currentRun.jobs} 已结束 · ${currentRun.completed_jobs} 成功 / ${currentRun.failed_jobs} 失败${currentRun.restricted_jobs?` / ${currentRun.restricted_jobs} 策略受限`:""}`:"暂无 Job";
  setBadge($("runBadge"),automation.run?.status||"idle");
  $("runSummary").textContent=automation.run?`${automation.run.id} · ${automation.run.team} · ${automation.run.stage} · workers ${automation.run.max_workers}`:"暂无自动化运行";
  renderRunFailure(automation);
  $("cancelButton").disabled=!automation.run||["completed","failed","cancelled","stopping","stopped"].includes(automation.run.status);
  const automationEvents=automation.events||[];
  renderRows($("jobsBody"),automation.jobs||[],8,job=>{
    const row=document.createElement("tr");const model=modelInfoForJob(job);
    const modelCell=cell(model.model,"job-model");if(model.driver){const driver=document.createElement("small");driver.textContent=model.driver;modelCell.append(driver)}
    const task=activityForJob(job);const taskCell=cell("","job-task");const target=document.createElement("strong");target.textContent=`${verbLabel(task.verb)} · ${task.target}`;taskCell.append(target);
    if(task.success_criteria){const success=document.createElement("small");success.textContent=`成功标准：${task.success_criteria}`;taskCell.append(success)}
    if(task.evidence_sink){const evidence=document.createElement("small");evidence.textContent=`证据输出：${task.evidence_sink}`;taskCell.append(evidence)}
    const signal=latestModelSignal(job,automationEvents);const activity=cell("","job-activity");const status=document.createElement("strong");status.textContent=jobSignalText(job,signal);activity.append(status);
    const heartbeat=document.createElement("span");heartbeat.textContent=job.last_heartbeat_at?`AgentCP 调度心跳 ${formatEventTime(job.last_heartbeat_at)}`:"尚未收到 AgentCP 调度心跳";activity.append(heartbeat);
    if(job.status==="running"){const caveat=document.createElement("small");caveat.textContent="工具事件来自 Claude stream-json；调度心跳与工具进度独立";activity.append(caveat)}
    if(job.error){const error=document.createElement("code");error.textContent=truncateText(job.error,220);error.title=String(job.error);activity.append(error)}
    const visibleStatus=job.status==="failed"&&isModelPolicyRestriction(job)?"模型策略受限":jobStatusLabel(job.status);
    row.append(cell(workerLabel(job)),cell(roleLabel(job.role)),modelCell,taskCell,cell(stageLabel(job.stage)),cell(visibleStatus,`job-status ${job.status||""}`),cell(`${job.attempts??0}/${job.max_attempts??"?"}`),activity);return row;
  });
  const events=[
    ...(automation.events||[]).filter(event=>event.event_type!=="model_agent_compose_log"),
    ...(auditResult.audit||[]).map(item=>({created_at:item.created_at,event_type:`api:${item.action}`,data:item.details})),
  ].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,50);
  $("eventsCount").textContent=`${events.length} 条`;$("eventsList").replaceChildren();
  events.forEach(event=>$("eventsList").append(renderEvent(event)));
  if(!events.length){const empty=document.createElement("div");empty.className="empty-row";empty.textContent="暂无运行事件";$("eventsList").append(empty)}

  const coverageEntries=Object.entries(data.attack_surface_coverage||{});$("coverageList").replaceChildren();
  coverageEntries.forEach(([name,statusValue])=>{
    const row=document.createElement("div");row.className=`coverage-row ${statusValue}`;
    const nameNode=document.createElement("span");nameNode.textContent=coverageLabels[name]||name;
    const track=document.createElement("div");track.className="coverage-track";track.append(document.createElement("i"));
    const flag=document.createElement("small");flag.textContent=coverageStatusLabels[statusValue]||statusValue;row.append(nameNode,track,flag);$("coverageList").append(row);
  });
  $("verifiedCoverage").textContent=`${metrics.coverage.verified} 已验证`;
  const hypotheses=project.hypotheses||[];const methodPack=project.method_pack||{};const planBatches=project.plan_batches||[];
  $("hypothesesCount").textContent=`${hypotheses.length} 个假设 · ${planBatches.length} 个计划批次`;
  $("methodPackSummary").textContent=methodPack.name?`已加载 ${methodPack.name} ${methodPack.version||""}，包含 ${(methodPack.dimensions||[]).length} 个攻击面维度。列表展示最新假设与其确定性优先分。`:"尚未加载项目方法包。";
  renderRows($("hypothesesBody"),[...hypotheses].reverse().slice(0,40),7,item=>{const row=document.createElement("tr");row.append(cell(item.statement||item.title),cell(item.target),cell(coverageLabels[item.dimension]||item.dimension),cell(percent(item.score??item.priority_score)),cell(item.evidence_maturity||"假设"),cell(hypothesisStatusLabel(item.status)),cell(item.source||"方法包"));return row});
  const counterfactualRows=(project.counterfactuals||[]).map(item=>({type:"反事实",target:item.target,content:item.claim,condition:item.falsification_criteria,status:hypothesisStatusLabel(item.status)}));
  const lessonRows=(project.lessons||[]).map(item=>({type:"经验",target:item.target,content:item.pattern,condition:(item.expiry_conditions||[]).join("、")||item.valid_until||"人工解除",status:item.valid_until&&new Date(item.valid_until).getTime()<=Date.now()?"已失效":"有效"}));
  const memoryRows=[...counterfactualRows,...lessonRows].reverse().slice(0,30);$("researchMemoryCount").textContent=`${counterfactualRows.length+lessonRows.length} 条`;
  renderRows($("researchMemoryBody"),memoryRows,5,item=>{const row=document.createElement("tr");row.append(cell(item.type),cell(item.target),cell(item.content),cell(item.condition),cell(item.status));return row});
  const pendingFactRows=jobs
    .filter(job=>job.status==="completed"&&!job.committed_at&&job.result?.payload?.kind==="fact")
    .map(job=>({...job.result.payload,__pending:true,__member:job.member_name}));
  const factRows=[...project.facts,...pendingFactRows];
  const directionRiskLeads=(project.directions||[]).map(riskLeadFromDirection).filter(Boolean);
  const attackIntel=factRows.filter(fact=>factClassification(fact)==="attack_surface");
  const rawRiskLeads=[...factRows.filter(fact=>factClassification(fact)==="risk_lead"),...directionRiskLeads];
  const riskLeads=deduplicateRiskLeads(rawRiskLeads);
  const vulnerabilities=factRows.filter(fact=>factClassification(fact)==="vulnerability");
  const verdicts=latestVerdictMap(project);
  const pendingSuffix=pendingFactRows.length?` · ${pendingFactRows.length} 待审查`:"";
  $("attackIntelCount").textContent=`${attackIntel.length} 条${pendingSuffix}`;
  const leadLifecycleCounts=riskLeads.reduce((counts,item)=>{const key=riskLeadLifecycle(item).key;counts[key]=(counts[key]||0)+1;return counts},{});
  const duplicateCount=rawRiskLeads.length-riskLeads.length;
  $("riskLeadsCount").textContent=`${riskLeads.length} 条 · 验证中 ${leadLifecycleCounts.validating||0} · 积压 ${leadLifecycleCounts.stale||0}${duplicateCount?` · 合并重复 ${duplicateCount}`:""}`;
  $("vulnerabilitiesCount").textContent=`${vulnerabilities.length} 条`;
  renderRows($("attackIntelBody"),attackIntel,4,fact=>renderFactRow(fact,{pending:fact.__pending}));
  renderRows($("riskLeadsBody"),[...riskLeads].reverse(),7,renderRiskLeadRow);
  const indexedEvidence=evidenceResult.evidence||[];
  renderRows($("vulnerabilitiesBody"),vulnerabilities,7,fact=>renderVulnerabilityRow(fact,verdicts[fact.id],indexedEvidence));
  const quality=project.quality_metrics||{};
  const globalQuality=project.global_quality_metrics||{};
  $("qualitySystemVulns").textContent=quality.system_vulnerabilities??vulnerabilities.length;
  $("qualityReviewed").textContent=quality.reviewed??0;
  $("qualityConfirmed").textContent=quality.confirmed??0;
  $("qualityRefuted").textContent=quality.false_positives??0;
  $("qualityFalsePositiveRate").textContent=percent(globalQuality.false_positive_rate);
  $("qualitySample").textContent=`长期样本 ${globalQuality.sample_size??0} · ${globalQuality.sample_quality||"样本严重不足"}`;
  const suggestions=globalQuality.rule_suggestions||[];$("qualityRuleSuggestions").textContent=suggestions.length?`发现 ${suggestions.length} 个重复误报模式，已生成规则候选；需历史回放并由人工批准后启用。`:"尚未形成重复误报规则建议。";
  const reviewSelect=$("reviewFinding");const selectedFinding=reviewSelect.value;reviewSelect.replaceChildren();
  vulnerabilities.forEach(fact=>{const option=document.createElement("option");option.value=fact.id;option.textContent=`${fact.id} · ${fact.title}`;reviewSelect.append(option)});
  if(vulnerabilities.some(fact=>fact.id===selectedFinding))reviewSelect.value=selectedFinding;
  $("submitFindingReview").disabled=!vulnerabilities.length;
  const wafAssessments=project.waf_assessments||[];$("wafAssessmentsCount").textContent=`${wafAssessments.length} 条`;
  renderRows($("wafAssessmentsBody"),wafAssessments,5,item=>{const row=document.createElement("tr");row.append(cell(item.target),cell(item.original_hypothesis),cell(item.status),cell((item.signals||[]).join("；")||"等待刻画"),cell(`${item.used_minutes??0}/${item.budget_minutes??12} min`));return row});
  const negativeEvidence=project.negative_evidence||[];$("negativeEvidenceCount").textContent=`${negativeEvidence.length} 条`;
  renderRows($("negativeEvidenceBody"),negativeEvidence,5,item=>{const row=document.createElement("tr");const validUntil=item.valid_until?new Date(item.valid_until):null;const active=!validUntil||validUntil.getTime()>Date.now();row.append(cell(item.target),cell(item.hypothesis),cell(item.reason),cell(validUntil&&!Number.isNaN(validUntil.getTime())?validUntil.toLocaleString():"未设置"),cell(active?"有效期内剪枝":"已失效，可重新验证"));return row});
  const directionRows=(project.directions||[]).map(direction=>({...direction.intent,direction_id:direction.id,direction_status:direction.status,terminal_reason:direction.terminal_reason}));
  $("intentsCount").textContent=`${directionRows.length} 条`;
  renderRows($("intentsBody"),directionRows,6,intent=>{const row=document.createElement("tr");const terminalReason=String(intent.terminal_reason||"");const humanDismissed=intent.direction_status==="cancelled"&&terminalReason.startsWith("human_dismissed:");const policyCooling=intent.direction_status==="released"&&terminalReason.startsWith("policy_blocked_until:")&&new Date(terminalReason.slice("policy_blocked_until:".length)).getTime()>Date.now();const riskText=`潜在 ${intent.risk_level||"未知"} / 操作 ${intent.action_safety_risk||"low"}`;row.append(cell(intent.verb),cell(intent.target),cell(intent.success_criteria),cell(riskText),cell(humanDismissed?"人工否决":policyCooling?"模型策略冷却":intent.direction_status||"open"));const action=cell("");const button=document.createElement("button");button.type="button";button.className=`button ${humanDismissed?"ghost":"danger"} small direction-dismiss`;button.dataset.directionId=intent.direction_id;button.textContent=humanDismissed?"已删除":"删除方向";button.disabled=humanDismissed;action.append(button);row.append(action);if(humanDismissed)row.title=terminalReason.replace(/^human_dismissed:/,"");return row});
  const indexedPaths=new Set(indexedEvidence.map(item=>item.path));
  const pendingEvidence=pendingFactRows
    .map(fact=>({fact_id:`候选 · ${fact.__member}`,path:fact.evidence_path,size_bytes:"待索引",sha256:"待提交",pending:true}))
    .filter(item=>item.path&&!indexedPaths.has(item.path));
  const evidence=[...indexedEvidence,...pendingEvidence];
  $("evidenceCount").textContent=pendingEvidence.length?`${indexedEvidence.length} 已索引 · ${pendingEvidence.length} 待审查`:`${indexedEvidence.length} 份`;
  renderRows($("evidenceBody"),evidence,5,item=>{const row=document.createElement("tr");row.append(cell(item.fact_id),cell(item.path),cell(item.pending?String(item.size_bytes):`${item.size_bytes} B`),cell(item.sha256,"hash"));const action=cell("");const button=document.createElement("button");button.type="button";button.className="button ghost small evidence-open";button.dataset.path=item.path;button.textContent="查看";action.append(button);row.append(action);return row});

  renderTeamEditor(config);
  renderTargetEditor(project.target);
  $("blackboardText").textContent=project.blackboard||"黑板为空";
  applyRoute(state.route);
}

function renderEmptyWorkspace(){
  state.vendor=null;state.runId=null;state.runStatus=null;state.teamConfig=null;state.configVendor=null;state.teamDirty=false;
  state.targetConfig=null;state.targetConfigVendor=null;state.targetDirty=false;state.secretStatus={};state.gateContext=null;state.gateSubmitting=false;
  setProjectControlsEnabled(false);
  $("projectSelect").disabled=true;
  $("projectTitle").textContent="创建第一个项目";
  $("currentTask").textContent="尚未初始化项目";$("goalText").textContent="请先填写目标并创建项目";
  $("phaseValue").textContent="—";$("updatedValue").textContent="尚未更新";
  $("decisionValue").textContent="—";$("gateReason").textContent="尚无控制器评估";
  $("gateApprovalCard").hidden=true;$("gateApprovalNote").value="";
  setBadge($("gateBadge"),"idle");setBadge($("runBadge"),"idle");
  $("assetMetric").textContent="0";$("factMetric").textContent="0";$("vulnMetric").textContent="0";
  $("coverageMetric").textContent="0%";$("jobMetric").textContent="0%";
  $("runSummary").textContent="暂无自动化运行";$("runFailure").hidden=true;$("runFailure").replaceChildren();emptyRow($("jobsBody"),8);
  $("eventsCount").textContent="0 条";$("eventsList").replaceChildren();
  const emptyEvent=document.createElement("div");emptyEvent.className="empty-row";emptyEvent.textContent="暂无运行事件";$("eventsList").append(emptyEvent);
  $("coverageList").replaceChildren();$("verifiedCoverage").textContent="0 已验证";
  $("hypothesesCount").textContent="0 个假设";$("methodPackSummary").textContent="尚未加载项目方法包。";emptyRow($("hypothesesBody"),7);
  $("researchMemoryCount").textContent="0 条";emptyRow($("researchMemoryBody"),5);
  $("attackIntelCount").textContent="0 条";emptyRow($("attackIntelBody"),4);
  $("riskLeadsCount").textContent="0 条";emptyRow($("riskLeadsBody"),7);
  $("vulnerabilitiesCount").textContent="0 条";emptyRow($("vulnerabilitiesBody"),7);
  $("qualitySystemVulns").textContent="0";$("qualityReviewed").textContent="0";$("qualityConfirmed").textContent="0";$("qualityRefuted").textContent="0";$("qualityFalsePositiveRate").textContent="—";$("qualitySample").textContent="样本 0";$("reviewFinding").replaceChildren();$("submitFindingReview").disabled=true;
  $("qualityRuleSuggestions").textContent="尚未形成重复误报规则建议。";
  $("wafAssessmentsCount").textContent="0 条";emptyRow($("wafAssessmentsBody"),5);
  $("negativeEvidenceCount").textContent="0 条";emptyRow($("negativeEvidenceBody"),5);
  $("intentsCount").textContent="0 条";emptyRow($("intentsBody"),6);
  $("evidenceCount").textContent="0 份";emptyRow($("evidenceBody"),5);$("evidencePreview").textContent="选择一份证据查看内容";
  $("roleConfigBody").replaceChildren();clearRolePromptEditor("请先创建项目。场景创建后可逐 Agent 配置提示词。");$("blackboardText").textContent="请先创建项目";
  renderTargetEditor({targets:[],out_of_scope:[],success_criteria:[]},true);
  setConnectionStatus("实时同步",true);
}

function prepareNewTask(){
  ++state.requestGeneration;state.vendor=null;state.newTaskMode=true;state.runId=null;state.runStatus=null;
  state.teamConfig=null;state.configVendor=null;state.teamDirty=false;state.targetConfigVendor=null;state.targetDirty=false;state.secretStatus={};state.gateContext=null;state.gateSubmitting=false;
  $("gateApprovalCard").hidden=true;$("gateApprovalNote").value="";
  renderTargetEditor({targets:[],out_of_scope:[],success_criteria:[]},true);
  $("newProjectName").value="";$("roleConfigBody").replaceChildren();clearRolePromptEditor("项目创建后可逐 Agent 配置提示词。");$("blackboardText").textContent="项目创建后将自动初始化双层黑板";
  setProjectControlsEnabled(false);$("createProjectButton").disabled=false;applyRoute("config");
}

async function loadProjects(preferred=null){
  try{
    const payload=await api("/api/projects");const select=$("projectSelect");const requested=new URLSearchParams(location.search).get("vendor");
    state.projects=payload.projects||[];state.qualitySummary=payload.quality_summary||null;select.replaceChildren();
    const qualitySummary=state.qualitySummary||{};$("hubFalsePositiveRate").textContent=qualitySummary.false_positive_rate==null?"暂无样本":percent(qualitySummary.false_positive_rate);$("hubReviewedCount").textContent=qualitySummary.reviewed??0;$("hubRefutedCount").textContent=qualitySummary.false_positives??0;$("hubSampleQuality").textContent=qualitySummary.sample_quality||"样本严重不足";
    state.projects.forEach(project=>{const option=document.createElement("option");option.value=project.vendor;option.textContent=project.vendor;select.append(option)});
    const desired=preferred||state.vendor||requested;
    state.vendor=state.projects.some(item=>item.vendor===desired)?desired:state.projects[0]?.vendor||null;
    select.disabled=!state.projects.length;if(state.vendor)select.value=state.vendor;
    $("enterProjectButton").disabled=!state.vendor;$("deleteProjectButton").disabled=!state.vendor;
    renderProjectCards();applyRoute(state.route);setConnectionStatus("实时同步",true);
  }catch(error){setConnectionStatus("连接异常",false);throw error}
}
function selectVendor(vendor){
  if(!state.projects.some(project=>project.vendor===vendor))return false;
  ++state.requestGeneration;state.vendor=vendor;state.newTaskMode=false;state.runId=null;state.runStatus=null;
  state.teamDirty=false;state.configVendor=null;state.teamConfig=null;state.targetDirty=false;state.targetConfigVendor=null;state.targetConfig=null;state.secretStatus={};state.gateContext=null;state.gateSubmitting=false;
  $("gateApprovalCard").hidden=true;$("gateApprovalNote").value="";
  $("projectSelect").value=vendor;renderProjectCards();applyRoute(state.route);return true;
}
async function openProject(vendor=state.vendor){
  if(!selectVendor(vendor))return showToast("请选择有效项目",true);
  $("roleConfigBody").replaceChildren();clearRolePromptEditor("正在读取 Agent 配置…");$("blackboardText").textContent="正在读取项目黑板…";
  renderTargetEditor({targets:[],out_of_scope:[],success_criteria:[]},true);navigate("config");await refresh();
}
async function refresh(){
  if(!state.vendor)return;
  const requestedVendor=state.vendor;const generation=++state.requestGeneration;
  try{
    const vendor=encodeURIComponent(requestedVendor);
    const [project,metricsResult,automation,configResult,evidenceResult,auditResult]=await Promise.all([api(`/api/project/state?vendor=${vendor}`),api(`/api/metrics?vendor=${vendor}`),api(`/api/automation/status?vendor=${vendor}`),api(`/api/config?vendor=${vendor}`),api(`/api/evidence?vendor=${vendor}`),api(`/api/audit?vendor=${vendor}`)]);
    if(generation!==state.requestGeneration||requestedVendor!==state.vendor)return;
    state.secretStatus=configResult.secret_status||{};renderProject(project,metricsResult.metrics,automation,configResult.config,evidenceResult,auditResult);
    setConnectionStatus("实时同步",true);
  }catch(error){if(generation!==state.requestGeneration||requestedVendor!==state.vendor)return;setConnectionStatus("连接异常",false);showToast(error.message,true)}
}
async function post(path,body,success){
  try{const result=await api(path,{method:"POST",body:JSON.stringify({vendor:state.vendor,...body})});showToast(success(result));await refresh();return result}
  catch(error){showToast(error.message,true);throw error}
}
async function openEvidence(path,{scroll=true}={}){
  const vendor=encodeURIComponent(state.vendor);const encodedPath=encodeURIComponent(path);
  const result=await api(`/api/evidence/content?vendor=${vendor}&path=${encodedPath}`);
  const preview=$("evidencePreview");preview.textContent=`${result.path}${result.truncated?"（仅显示前 64 KiB）":""}\n\n${result.content}`;
  if(scroll)preview.scrollIntoView({behavior:"smooth",block:"center"});
}
async function uploadClientFile(vendor,file,projectType="客户端"){
  const query=new URLSearchParams({vendor,filename:file.name,project_type:projectType});
  const response=await fetch(`/api/target/upload?${query}`,{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});
  const raw=await response.text();let payload;
  try{payload=raw?JSON.parse(raw):{}}catch(_error){throw new Error(`HTTP ${response.status}：上传接口返回非 JSON 响应`)}
  if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
  return payload;
}

function canLeaveConfiguration(){
  return !(state.route==="config"&&(state.targetDirty||state.teamDirty))||window.confirm("当前配置有未保存的修改，确定离开吗？");
}
async function goToHub(){
  if(!canLeaveConfiguration())return;
  if(!state.vendor&&state.projects.length)selectVendor(state.projects[0].vendor);
  state.newTaskMode=false;navigate("hub");renderProjectCards();
}
async function requestRoute(route){
  if(route==="hub")return goToHub();
  if(route==="config"){
    if(!state.vendor){prepareNewTask();navigate("config");return}
    navigate("config");if(!state.teamConfig)await refresh();return;
  }
  if(!state.vendor){navigate("hub");return showToast("请先选择项目",true)}
  if(!canLeaveConfiguration())return;
  navigate("run");if(!state.teamConfig)await refresh();
}
async function persistPendingConfiguration(){
  if(state.targetDirty){
    const result=await api("/api/target",{method:"POST",body:JSON.stringify({vendor:state.vendor,target:collectTargetConfig()})});
    state.targetDirty=false;renderTargetEditor(result.target,true);
  }
  if(state.teamDirty){
    const config=collectTeamConfig();const secrets=collectRuntimeSecrets();
    const result=await api("/api/config",{method:"POST",body:JSON.stringify({vendor:state.vendor,config,secrets})});
    state.secretStatus=result.secret_status||state.secretStatus;state.teamConfig=structuredClone(result.config||config);state.teamDirty=false;renderTeamEditor(state.teamConfig,true);
  }
}
async function launchAudit(){
  if(!state.vendor)return showToast("请先创建或选择项目",true);
  if(!state.teamConfig)return showToast("项目配置尚未加载完成",true);
  if(projectTypeOption(state.targetConfig?.project_type)==="客户端"&&!state.targetConfig?.uploaded_artifact)return showToast("客户端项目必须先上传测试文件",true);
  const confirmed=window.confirm(`即将保存当前配置，并把 ${state.vendor} 的目标信息、黑板上下文及相关源码片段发送给团队配置中的真实模型服务。\n\n确认启动并发审计吗？`);
  if(!confirmed)return;
  $("startAuditButton").disabled=true;$("launchButton").disabled=true;
  try{
    await persistPendingConfiguration();
    const result=await api("/api/automation/launch",{method:"POST",body:JSON.stringify({vendor:state.vendor,team:$("teamInput").value.trim()||"default",max_workers:Number($("workersInput").value),timeout:Number($("timeoutInput").value)})});
    state.runId=result.run_id;state.runStatus="running";showToast(`运行 ${result.run_id} 已启动`);await refresh();navigate("run");
  }catch(error){showToast(error.message,true)}finally{applyRoute(state.route)}
}

$("refreshButton").addEventListener("click",refresh);
$("enterProjectButton").addEventListener("click",()=>openProject());
$("newTaskButton").addEventListener("click",()=>{prepareNewTask();navigate("config")});
$("returnHubButton").addEventListener("click",goToHub);
$("backConfigButton").addEventListener("click",()=>requestRoute("config"));
$("viewRunButton").addEventListener("click",()=>requestRoute("run"));
$("startAuditButton").addEventListener("click",launchAudit);
$("launchButton").addEventListener("click",launchAudit);
$("projectCards").addEventListener("click",async event=>{const button=event.target.closest(".project-open");if(!button)return;if(button.dataset.route==="run"){if(!selectVendor(button.dataset.vendor))return;navigate("run");await refresh()}else await openProject(button.dataset.vendor)});
$("projectSelect").addEventListener("change",event=>{if(selectVendor(event.target.value))navigate("hub",{replace:true})});
document.querySelectorAll("[data-route-link]").forEach(link=>link.addEventListener("click",event=>{
  event.preventDefault();if(link.classList.contains("disabled"))return;requestRoute(link.dataset.routeLink);
}));
$("deleteProjectButton").addEventListener("click",async()=>{
  const vendor=state.vendor;if(!vendor)return showToast("当前没有可删除的项目",true);
  const confirmation=window.prompt(`删除项目会永久移除目标、配置、黑板、证据和运行记录。\n\n请输入项目名“${vendor}”确认删除：`);
  if(confirmation===null)return;if(confirmation!==vendor)return showToast("项目名不匹配，已取消删除",true);
  if(!window.confirm(`最后确认：永久删除项目“${vendor}”？此操作不可恢复。`))return;
  ++state.requestGeneration;$("deleteProjectButton").disabled=true;
  try{
    await api("/api/projects/delete",{method:"POST",body:JSON.stringify({vendor,confirmation})});
    state.vendor=null;state.newTaskMode=false;state.teamDirty=false;state.targetDirty=false;state.secretStatus={};state.runId=null;state.runStatus=null;
    await loadProjects();navigate("hub",{replace:true});
    if(!state.vendor)renderEmptyWorkspace();renderProjectCards();applyRoute("hub");
    showToast(`项目 ${vendor} 已删除${state.vendor?`，已选择 ${state.vendor}`:"，现在可以创建新任务"}`);
  }catch(error){showToast(error.message,true);await loadProjects(vendor);applyRoute("hub")}
});
$("cancelButton").addEventListener("click",async()=>{if(state.runId)await post("/api/automation/cancel",{run_id:state.runId,reason:"用户从 Web 控制台取消"},()=>"运行已取消")});
$("hintButton").addEventListener("click",async()=>{const content=$("hintContent").value.trim();if(!content)return showToast("请填写项目所有者指令",true);await post("/api/hints",{content,target:$("hintTarget").value.trim()||null,priority:Number($("hintPriority").value),intervention_type:$("interventionType").value,run_id:state.runId||"",scope:"project"},()=>"最高优先级指令已写入；旧上下文结果将被拦截");$("hintContent").value=""});
$("gateContinueButton").addEventListener("click",()=>submitGateDecision("continue"));
$("gateStopButton").addEventListener("click",()=>submitGateDecision("stop_loss"));
$("intentsBody").addEventListener("click",async event=>{const button=event.target.closest(".direction-dismiss");if(!button||button.disabled)return;const reason=window.prompt("请输入删除这个方向的理由。该方向会立即停止调度，但审计记录仍会保留：");if(reason===null)return;if(!reason.trim())return showToast("必须填写删除理由",true);if(!window.confirm("确认人工否决并停止这个方向？"))return;await post("/api/directions/dismiss",{direction_id:button.dataset.directionId,reason:reason.trim()},()=>"方向已人工否决，不会再参与调度")});
$("copyBoard").addEventListener("click",async()=>{await navigator.clipboard.writeText($("blackboardText").textContent);showToast("黑板内容已复制")});
$("evidenceBody").addEventListener("click",async event=>{const button=event.target.closest(".evidence-open");if(!button)return;try{await openEvidence(button.dataset.path,{scroll:false})}catch(error){showToast(error.message,true)}});
$("vulnerabilitiesBody").addEventListener("click",async event=>{
  const evidenceButton=event.target.closest(".vulnerability-evidence-open");
  if(evidenceButton){try{await openEvidence(evidenceButton.dataset.path)}catch(error){showToast(error.message,true)}return}
  const button=event.target.closest(".finding-review-open");if(!button)return;
  $("reviewFinding").value=button.dataset.findingId;const fact=(state.projectData?.facts||[]).find(item=>item.id===button.dataset.findingId);
  if(fact){$("reviewSeverity").value=["info","low","medium","high","critical"].includes(fact.severity)?fact.severity:"medium"}
  $("reviewReason").focus();$("reviewReason").scrollIntoView({behavior:"smooth",block:"center"});
});
$("submitFindingReview").addEventListener("click",async()=>{
  const findingId=$("reviewFinding").value;const reason=$("reviewReason").value.trim();if(!findingId)return showToast("请选择系统漏洞",true);if(!reason)return showToast("请填写人工判断或驳斥理由",true);
  const reasonCodes=$("reviewReasonCodes").value.split(",").map(item=>item.trim()).filter(Boolean);
  await post("/api/findings/review",{finding_id:findingId,action:$("reviewAction").value,final_classification:$("reviewClassification").value,final_severity:$("reviewSeverity").value,reason,reason_codes:reasonCodes,applicable_scope:$("reviewScope").value},result=>`人工结论已保存，长期误报率 ${percent(result.global_quality_metrics.false_positive_rate)}`);
  $("reviewReason").value="";$("reviewReasonCodes").value="";
});
$("reviewAction").addEventListener("change",event=>{
  const action=event.target.value;
  if(["accepted","adjusted"].includes(action))$("reviewClassification").value="vulnerability";
  else if(action==="refuted")$("reviewClassification").value="inconclusive";
  else if(action==="reclassified")$("reviewClassification").value="risk_lead";
  else if(action==="retest_requested")$("reviewClassification").value="inconclusive";
});
$("roleConfigBody").addEventListener("input",()=>{state.teamDirty=true});
$("rolePromptMember").addEventListener("change",event=>{state.promptMemberIndex=Number(event.target.value)||0;renderRolePromptEditor()});
$("rolePromptText").addEventListener("input",event=>{const member=state.teamConfig?.members?.[state.promptMemberIndex];if(!member)return;member.custom_prompt=event.target.value;state.teamDirty=true;$("rolePromptStatus").textContent=`当前编辑：${member.name}。已输入 ${event.target.value.length}/30000 字符；保存并应用后生效。`});
$("roleConfigBody").addEventListener("click",event=>{const button=event.target.closest(".role-remove");if(!button||!state.teamConfig?.members)return;const row=button.closest("tr");const index=Number(row.dataset.index);if(!Number.isInteger(index)||index<0||index>=state.teamConfig.members.length)return;state.teamConfig.members.splice(index,1);state.teamDirty=true;renderTeamEditor(state.teamConfig,true);state.teamDirty=true});
$("addRoleButton").addEventListener("click",()=>{if(!state.vendor||!state.teamConfig?.members)return showToast("请先创建并加载项目",true);state.teamConfig.members.push({name:`worker-${state.teamConfig.members.length+1}`,role:"executor",runtime_mode:"local-docker",custom_prompt:null,type:"codex",model:null,base_url:null,api_key_env:"OPENAI_API_KEY",auth_mode:"auto",sandbox:"workspace-write",max_running:1,priority:1,env:{},dangerously_bypass_sandbox:false});state.promptMemberIndex=state.teamConfig.members.length-1;state.teamDirty=true;renderTeamEditor(state.teamConfig,true);state.teamDirty=true});
$("saveTeamButton").addEventListener("click",async()=>{if(!state.vendor||!state.teamConfig)return showToast("请先创建并加载项目",true);const config=collectTeamConfig();const secrets=collectRuntimeSecrets();const result=await post("/api/config",{config,secrets},()=>"角色配置已保存，API Key 已安全写入系统钥匙串");state.secretStatus=result.secret_status||state.secretStatus;state.teamConfig=structuredClone(result.config||config);state.teamDirty=false;renderTeamEditor(state.teamConfig,true)});

$("target-setup").addEventListener("input",event=>{if(event.target.id!=="newProjectName")state.targetDirty=true});
$("targetProjectType").addEventListener("change",renderClientUpload);
$("clientArtifactFile").addEventListener("change",renderClientUpload);
$("uploadClientArtifactButton").addEventListener("click",async()=>{
  if(!state.vendor)return showToast("请先创建并选择客户端项目",true);
  const file=$("clientArtifactFile").files?.[0];if(!file)return showToast("请选择要上传的客户端文件",true);
  const button=$("uploadClientArtifactButton");button.disabled=true;$("clientUploadStatus").textContent=`正在上传 ${file.name}…`;
  try{
    const payload=await uploadClientFile(state.vendor,file,$("targetProjectType").value);
    state.targetDirty=false;state.targetConfig=structuredClone(payload.target);$("clientArtifactFile").value="";renderTargetEditor(payload.target,true);
    showToast(`客户端文件已上传：${payload.artifact.name}`);
  }catch(error){showToast(error.message,true);renderClientUpload()}
});
$("saveTargetButton").addEventListener("click",async()=>{if(!state.vendor)return showToast("请先创建项目",true);const target=collectTargetConfig();const result=await post("/api/target",{target},()=>"渗透目标已保存并同步到中央黑板上下文");state.targetDirty=false;renderTargetEditor(result.target,true)});
$("createProjectButton").addEventListener("click",async()=>{
  const vendor=$("newProjectName").value.trim();if(!vendor)return showToast("请填写新项目名称",true);
  const client=projectTypeOption($("targetProjectType").value)==="客户端";const file=$("clientArtifactFile").files?.[0];
  if(client&&!file)return showToast("客户端项目必须选择一个测试文件",true);
  $("createProjectButton").disabled=true;let createdVendor=null;
  try{
    const result=await api("/api/projects",{method:"POST",body:JSON.stringify({vendor,target:collectTargetConfig()})});
    createdVendor=result.vendor;
    if(client){$("clientUploadStatus").textContent=`项目已创建，正在上传 ${file.name}…`;await uploadClientFile(result.vendor,file,$("targetProjectType").value)}
    ++state.requestGeneration;state.newTaskMode=false;state.targetDirty=false;state.teamDirty=false;await loadProjects(result.vendor);$("newProjectName").value="";navigate("config",{replace:true});await refresh();showToast(`项目 ${result.vendor} 已创建，目标配置已生效`);
  }catch(error){showToast(error.message,true);if(createdVendor){await loadProjects(createdVendor);navigate("config",{replace:true});await refresh()}}finally{$("createProjectButton").disabled=false}
});

window.addEventListener("hashchange",async()=>{
  const route=routeFromLocation();const requestedVendor=new URLSearchParams(location.search).get("vendor");
  if(state.route==="config"&&route!=="config"&&!canLeaveConfiguration()){navigate("config",{replace:true});return}
  if(route==="config"&&!requestedVendor){prepareNewTask();applyRoute("config");return}
  if(route==="run"&&!requestedVendor){navigate("hub",{replace:true});return}
  if(requestedVendor!==state.vendor){
    if(!selectVendor(requestedVendor)){navigate("hub",{replace:true});return}
  }
  applyRoute(route);if(route!=="hub"&&state.vendor&&!state.teamConfig)await refresh();
});

async function boot(){
  try{
    const initialRoute=routeFromLocation();const requestedVendor=new URLSearchParams(location.search).get("vendor");await loadProjects();
    if(initialRoute==="config"&&!requestedVendor){prepareNewTask();navigate("config",{replace:true})}
    else if(initialRoute==="run"&&!requestedVendor){navigate("hub",{replace:true})}
    else if(initialRoute!=="hub"&&state.vendor){applyRoute(initialRoute);await refresh();navigate(initialRoute,{replace:true})}
    else{navigate("hub",{replace:true});if(!state.projects.length){renderEmptyWorkspace();renderProjectCards();applyRoute("hub");showToast("请先创建第一个审计任务")}}
    state.timer=setInterval(()=>{if(state.route==="run")refresh();else if(state.route==="hub")loadProjects(state.vendor).catch(error=>showToast(error.message,true))},5000);
  }catch(error){setConnectionStatus("连接异常",false);showToast(error.message,true)}
}
boot();
