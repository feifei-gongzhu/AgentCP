export const ROUTES = new Set(["hub", "config", "run"]);

export function routeFromHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (ROUTES.has(raw)) return raw;
  if (["target-setup", "project-configuration", "project-blackboard"].includes(raw)) {
    return "config";
  }
  if (["overview", "automation", "intelligence", "control"].includes(raw)) {
    return "run";
  }
  return "hub";
}
