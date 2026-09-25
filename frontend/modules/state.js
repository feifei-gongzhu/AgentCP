export const state = {
  vendor: null, projects: [], route: "projects", newTaskMode: false,
  runId: null, runStatus: null, timer: null,
  teamConfig: null, teamDirty: false, configVendor: null,
  teamPresets: [], defaultTeamPresetId: null, selectedTeamPresetId: null,
  teamPresetApiAvailable: true,
  targetConfig: null, targetDirty: false, targetConfigVendor: null,
  secretStatus: {}, requestGeneration: 0,
  gateContext: null, gateSubmitting: false,
  projectData: null, qualitySummary: null,
  assetInventory: null, assetOffset: 0, assetPageSize: 100,
  derived: null, automationCache: null, auditCache: null, promptCache: null,
  metricsCache: null,
};

// UI-only state survives polling redraws.
export const ui = {
  tab: "vulns", diag: "jobs", memberIndex: 0,
  selected: { vulns: null, leads: null, directions: null, surface: null },
  findingFilters: {
    vulns: { q: "", severity: "", status: "", type: "" },
    leads: { q: "", severity: "", status: "", type: "" },
    surface: { q: "", severity: "", status: "", type: "" },
  },
  // 证据阅读器：当前发现、选中文件、所在标签；内容按路径缓存（跨轮询稳定）。
  evidenceReader: { factId: null, path: null, tab: "files" },
  evidenceCache: new Map(),
  readerWrap: true, readerExpanded: false,
  jobStatusFilter: "",
  // 人工裁决：草稿按 finding ID 隔离；表单展开状态跟随对应记录
  reviewDrafts: {}, reviewFormOpenFor: null,
  findingSort: {
    vulns: { key: null, dir: 1 },
    leads: { key: null, dir: 1 },
    surface: { key: null, dir: 1 },
  },
  expandedTechnologyHosts: new Set(),
};

export function captureRequestContext() {
  return { vendor: state.vendor, generation: state.requestGeneration };
}

export function isCurrentRequest(context) {
  return context.generation === state.requestGeneration && context.vendor === state.vendor;
}
