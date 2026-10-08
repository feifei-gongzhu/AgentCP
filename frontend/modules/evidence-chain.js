// 发现详情证据链（实施方案 §11）：请求/响应 → 引擎原始命中 → 独立研判 →
// review → Guardian → 人工结论。每段都标注可用性；缺失段如实显示缺失。
import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";

const STAGE_ICONS = {
  request_response: "请求/响应",
  engine_hits: "引擎命中",
  independent_analysis: "独立研判",
  reviewer: "review",
  guardian: "Guardian",
  human_verdict: "人工结论",
};

const HUMAN_ACTIONS = {
  accepted: "已认可", adjusted: "已调级", same_root: "同源", refuted: "已驳斥",
  reclassified: "已降级", retest_requested: "要求复验",
};

export function buildEvidenceChainSection() {
  const section = el("details", "collapse evidence-chain");
  const summary = el("summary", "", "证据链 ");
  summary.append(el("span", "text-dim", "请求/响应 → 引擎命中 → 独立研判 → review → Guardian → 人工"));
  section.append(summary);
  const body = el("div", "collapse-body chain-body");
  body.append(el("div", "text-dim", "加载证据链…"));
  section.append(body);
  return section;
}

export async function loadEvidenceChain(factId, section, handlers = {}) {
  const body = section.querySelector(".chain-body");
  if (!body || !factId) return;
  try {
    const params = new URLSearchParams({ vendor: state.vendor || "", finding_id: factId });
    const result = await api(`/api/findings/chain?${params.toString()}`);
    renderChain(body, result.chain || [], handlers);
  } catch (error) {
    body.replaceChildren(el("div", "alert-error", `证据链加载失败：${error.message}`));
  }
}

// 链内联读取证据文件：点击请求/响应后在原地展开内容（不跳离发现页）。
async function inlineEvidenceFile(path, container) {
  const existing = container.querySelector(".chain-evidence-inline");
  if (existing) {
    existing.remove();
    return;
  }
  const pre = el("pre", "code-block chain-evidence-inline", "正在读取证据…");
  container.append(pre);
  try {
    const params = new URLSearchParams({ vendor: state.vendor || "", path });
    const result = await api(`/api/evidence/content?${params.toString()}`);
    pre.textContent = `${result.path}${result.truncated ? "（仅显示前 64 KiB）" : ""}\n\n${result.content}`;
  } catch (error) {
    pre.textContent = `读取失败：${error.message}`;
  }
}

function chainStep(index, stage, handlers) {
  const node = el("div", `chain-step${stage.available ? "" : " missing"}`);
  const head = el("div", "chain-step-head");
  head.append(el("span", "chain-index", String(index + 1)));
  head.append(el("strong", "", STAGE_ICONS[stage.stage] || stage.stage));
  head.append(chip(stage.available ? "有记录" : "缺失", stage.available ? "ok" : ""));
  node.append(head);

  const detail = stage.detail || {};
  if (stage.stage === "request_response") {
    const refs = detail.proof_refs || {};
    ["raw_request", "raw_response"].forEach(key => {
      const files = refs[key] || [];
      files.forEach(path => {
        const button = el("button", "detail-link", `${key === "raw_request" ? "请求" : "响应"} · ${path}`);
        button.type = "button";
        button.addEventListener("click", () => inlineEvidenceFile(path, node));
        node.append(button);
      });
    });
    if (detail.evidence_path) {
      const note = el("small", "text-dim", `主证据 ${detail.evidence_path}`);
      node.append(note);
    }
    if (!stage.available) node.append(el("small", "text-dim", "未声明请求/响应证据文件"));
  } else if (stage.stage === "engine_hits") {
    (detail.tool_calls || []).forEach(call => {
      const line = el("div", "chain-call");
      line.append(chip(call.status === "ok" ? call.tool_id : `${call.tool_id} ${call.status}`,
        call.status === "ok" ? "info" : "danger"));
      line.append(el("small", "text-dim mono", String(call.output_summary || "").slice(0, 140)));
      node.append(line);
    });
    if (!stage.available) {
      node.append(el("small", "text-dim",
        detail.direction_id ? "该方向无工具调用记录" : "该发现未关联验证方向（intent_id）"));
    }
  } else if (stage.stage === "independent_analysis") {
    (detail.records || []).forEach(record => {
      const line = el("div", "chain-analysis");
      line.append(el("strong", "", `${record.analyzer_kind} v${record.version} · ${record.analysis_status}`));
      if (record.conclusion) line.append(el("small", "", String(record.conclusion).slice(0, 160)));
      const followups = record.recommended_followups || [];
      if (followups.length) {
        line.append(el("small", "text-dim",
          `建议 ${followups.length} 项${followups.filter(item => item.adopted).length ? `（已采纳 ${followups.filter(item => item.adopted).length}）` : ""}`));
      }
      if (record.model_id) line.append(el("small", "text-dim mono", record.model_id));
      node.append(line);
    });
    if (!stage.available) {
      node.append(el("small", "text-dim", "无独立研判记录（触发工具结果未入队或分析器停用）"));
    }
  } else if (stage.stage === "reviewer") {
    (detail.reviews || []).forEach(review => {
      const line = el("div", "chain-review");
      line.append(el("strong", "", `${review.evidence_sufficiency || "?"} · ${review.recommendation || "?"}`));
      if ((review.missing_items || []).length) {
        line.append(el("small", "text-dim", `补证据：${review.missing_items.join("、")}`));
      }
      node.append(line);
    });
    (detail.flags || []).forEach(flag => {
      node.append(el("small", "text-dim mono", `回流标记 ${JSON.stringify(flag).slice(0, 120)}`));
    });
    if (!stage.available) node.append(el("small", "text-dim", "reviewer 尚未复核该候选"));
  } else if (stage.stage === "guardian") {
    node.append(el("div", "kv", ""));
    const row = el("div", "kv");
    row.append(el("span", "", "判定"));
    row.append(el("b", "", detail.certified ? "证据链完整（certified）" : "未认证（只降不升）"));
    node.append(row);
    (detail.quality_notes || []).forEach(note => node.append(el("small", "text-dim", `· ${note}`)));
    (detail.reasons || []).forEach(note => node.append(el("small", "text-dim", `· ${note}`)));
    node.append(el("small", "text-dim", `结果：status=${detail.status_after || "?"} / classification=${detail.classification_after || "?"}`));
  } else if (stage.stage === "human_verdict") {
    if (detail) {
      const action = HUMAN_ACTIONS[detail.action] || detail.action || "—";
      const line = el("div", "kv");
      line.append(el("span", "", "结论"));
      line.append(el("b", "", `${action} · ${detail.final_classification || "?"} · ${detail.final_severity || "?"}`));
      node.append(line);
      if (detail.reason) node.append(el("small", "", `理由：${detail.reason}`));
    } else {
      node.append(el("small", "text-dim", "待人工复核"));
    }
  }
  return node;
}

export function renderChain(body, chain, handlers = {}) {
  body.replaceChildren();
  if (!chain.length) {
    body.append(el("div", "empty-state", "无证据链数据"));
    return;
  }
  const wrap = el("div", "chain-steps");
  chain.forEach((stage, index) => wrap.append(chainStep(index, stage, handlers)));
  body.append(wrap);
}
