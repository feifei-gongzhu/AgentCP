export const ROUTES = new Set([
  "projects", "overview", "findings", "directions", "assets", "runs", "settings",
]);

const LEGACY = {
  hub: "projects",
  "target-setup": "settings",
  "project-configuration": "settings",
  "project-blackboard": "settings",
  config: "settings",
  overview: "overview",
  automation: "runs",
  intelligence: "findings",
  control: "runs",
  run: "overview",
};

export function routeFromHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const route = ROUTES.has(raw) ? raw : LEGACY[raw];
  return route || "projects";
}
