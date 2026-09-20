export const state = {
  vendor: null, projects: [], route: "hub", newTaskMode: false,
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
};

// UI-only state survives polling redraws.
export const ui = {
  tab: "vulns", diag: "jobs", memberIndex: 0,
  selected: { vulns: null, leads: null, directions: null, surface: null },
  expandedTechnologyHosts: new Set(),
};

export function captureRequestContext() {
  return { vendor: state.vendor, generation: state.requestGeneration };
}

export function isCurrentRequest(context) {
  return context.generation === state.requestGeneration && context.vendor === state.vendor;
}
