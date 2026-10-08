// 独立 AI 研判配置与结果面板（实施方案 §11 倒数第二条 + §7A）。
// 显示 POC/目录/JS 三分析器的启用状态、模型、分析进度、版本、证据、
// 建议与重分析入口；不新增任何“剩余次数/Token 配额”界面。
import { state } from "./state.js";
import { $, el, cell, emptyRow, showToast } from "./dom.js";
import { api } from "./api.js";
import { chip } from "./ui.js";
import { formatEventTime } from "./format.js";

const ANALYZER_TITLES = { poc: "POC 研判", directory: "目录研判", js: "JS 研判" };

export function renderAnalysisPanel(panelData, onChanged) {
  const data = panelData || {};
  const analyzers = data.analyzers || [];
  const configWrap = $("analyzerConfigPanel");
  const note = $("analysisPanelNote");
  const recordsBody = $("analysisRecordsBody");

  configWrap.replaceChildren();
  if (note) note.textContent = `schema v${data.schema_version ?? "?"} · ${data.note || ""}`;

  if (!analyzers.length) {
    configWrap.append(el("div", "empty-state", "分析器注册表为空"));
  } else {
    analyzers.forEach(analyzer => {
      const card = el("div", `analyzer-card${analyzer.enabled_effective ? "" : " disabled"}`);
      const head = el("div", "analyzer-head");
      head.append(el("strong", "", ANALYZER_TITLES[analyzer.analyzer_kind] || analyzer.title));
      head.append(chip(
        analyzer.enabled_effective ? "启用" : "停用",
        analyzer.enabled_effective ? "ok" : "",
      ));
      card.append(head);
      card.append(el("p", "text-dim", analyzer.description || ""));
      const model = analyzer.model;
      card.append(el("div", "kv", ""));
      const modelRow = el("div", "kv");
      modelRow.append(el("span", "", "模型"));
      modelRow.append(el("b", "", model
        ? `${model.model}（${model.source || "analysis_config"}）`
        : "未配置（等待继承 planner/reviewer 模型）"));
      if (model?.api_key_env) modelRow.append(el("small", "text-dim", `密钥环境变量 ${model.api_key_env}`));
      card.append(modelRow);
      card.append(el("div", "kv", ""));
      const versionRow = el("div", "kv");
      versionRow.append(el("span", "", "版本"));
      versionRow.append(el("b", "", `prompt ${analyzer.prompt_version} · schema v${analyzer.schema_version}`));
      card.append(versionRow);
      if (analyzer.disabled_reason) {
        card.append(el("p", "text-dim", analyzer.disabled_reason));
      }
      // 启停开关（§7A.4 功能开关；不影响取消/恢复/证据校验）
      const toggle = el("button", `btn sm ${analyzer.enabled_effective ? "ghost" : "primary"}`,
        analyzer.enabled_effective ? "停用" : "启用");
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api("/api/analysis/config", {
            method: "POST",
            body: JSON.stringify({
              vendor: state.vendor,
              analyzers: { [analyzer.analyzer_kind]: { enabled: !analyzer.enabled_effective } },
            }),
          });
          showToast(`${ANALYZER_TITLES[analyzer.analyzer_kind] || analyzer.analyzer_kind} 已${!analyzer.enabled_effective ? "启用" : "停用"}`);
          if (onChanged) await onChanged();
        } catch (error) {
          showToast(error.message, true);
        } finally {
          toggle.disabled = false;
        }
      });
      card.append(toggle);
      configWrap.append(card);
    });
    const queued = data.queued_jobs || [];
    if (queued.length) {
      const queueNote = el("p", "text-dim",
        `待处理分析任务 ${queued.length} 个：${queued.map(job => `${job.analyzer_kind}(${job.status})`).join("、")}`);
      configWrap.append(queueNote);
    }
  }

  recordsBody.replaceChildren();
  const records = data.records || [];
  if (!records.length) {
    emptyRow(recordsBody, 6, "尚无研判记录（引擎结果落盘后自动入队）");
    return;
  }
  records.forEach(record => {
    const row = el("tr");
    row.append(cell(ANALYZER_TITLES[record.analyzer_kind] || record.analyzer_kind));
    row.append(cell(`v${record.version ?? "?"}`));
    const statusCell = cell(record.analysis_status || "—");
    statusCell.append(el("small", "text-dim", record.model_id ? ` ${record.model_id}` : ""));
    row.append(statusCell);
    const conclusion = (record.record || {}).conclusion || "";
    row.append(cell(String(conclusion).slice(0, 120) || "—"));
    const followups = ((record.record || {}).recommended_followups || []);
    row.append(cell(String(followups.length)));
    const actionCell = cell("");
    const button = el("button", "btn ghost sm", "重分析");
    button.type = "button";
    button.title = "以原记录输入生成新版本；旧记录保留";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api("/api/analysis/reanalyze", {
          method: "POST",
          body: JSON.stringify({
            vendor: state.vendor,
            analysis_id: record.analysis_id,
            reason: "web-console-reanalysis",
          }),
        });
        showToast(`已入队重分析（job ${result.analysis_job_id}）`);
        if (onChanged) await onChanged();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
    actionCell.append(button);
    row.append(actionCell);
    row.title = `${record.analysis_id} · prompt ${record.prompt_version} · ${formatEventTime(record.created_at)} · source_task ${record.source_task_id || "—"}`;
    recordsBody.append(row);
  });
}
