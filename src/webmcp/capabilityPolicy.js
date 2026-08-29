import { supportsPortMethod } from "./ports.js";

export const PROHIBITED_TOOL_NAMES = Object.freeze([
  "approve_decision",
  "commit_approval",
  "reject_candidate",
  "rank_candidate_protected_traits",
  "set_insurance_premium",
  "underwrite_policy",
  "adjudicate_claim",
  "delete_case",
  "submit_external_action",
]);

const PROHIBITED_PATTERN = /(approve|commit_approval|reject_candidate|underwrite|adjudicate_claim|set_.*premium|delete_case|submit_external)/i;

function permissionMatches(granted, required) {
  if (granted === "*" || granted === required) return true;
  if (granted.endsWith(":*") && required.startsWith(granted.slice(0, -1))) return true;
  return false;
}

export function hasPermission(context, required) {
  if (!required) return true;
  return context.permissions.some((granted) => permissionMatches(granted, required));
}

function phaseMatches(spec, context) {
  if (!spec.phases?.length) return true;
  return spec.phases.includes(context.phase);
}

function lensMatches(spec, context) {
  if (!spec.lenses?.length) return true;
  const lens = context.presentation?.lens ?? context.workspace?.lens ?? "investigate";
  return spec.lenses.includes(lens);
}

export function evaluateCapability(spec, context, ports) {
  if (!spec || PROHIBITED_PATTERN.test(spec.name) || PROHIBITED_TOOL_NAMES.includes(spec.name)) {
    return { allowed: false, reason: "prohibited_action" };
  }
  const requirements = Array.isArray(spec.requiredPort) ? spec.requiredPort : [spec.requiredPort];
  if (requirements.some((requirement) => requirement && !supportsPortMethod(ports, requirement))) {
    return { allowed: false, reason: "unsupported_port" };
  }
  if (spec.requiresCase && !context.activeCaseId) {
    return { allowed: false, reason: "no_active_case" };
  }
  if (!phaseMatches(spec, context)) return { allowed: false, reason: "wrong_phase" };
  if (!lensMatches(spec, context)) return { allowed: false, reason: "wrong_lens" };
  if (typeof spec.when === "function" && !spec.when(context)) {
    return { allowed: false, reason: "state_precondition" };
  }
  if (!hasPermission(context, spec.permission)) return { allowed: false, reason: "permission_missing" };
  if (context.frozen && spec.mutating && !spec.allowedWhenFrozen) {
    return { allowed: false, reason: "room_frozen" };
  }
  if (context.pendingHumanCheckpoint && spec.mutating) {
    return { allowed: false, reason: "human_checkpoint_pending" };
  }
  if (context.domainRisk === "regulated" && spec.prohibitedInRegulated) {
    return { allowed: false, reason: "regulated_domain_policy" };
  }
  return { allowed: true, reason: null };
}

export function selectCapabilities(catalog, context, ports) {
  return catalog
    .map((spec) => ({ spec, decision: evaluateCapability(spec, context, ports) }))
    .filter(({ decision }) => decision.allowed)
    .map(({ spec }) => spec);
}

export function describeCapabilities(catalog, context, ports) {
  return catalog.map((spec) => {
    const decision = evaluateCapability(spec, context, ports);
    return {
      name: spec.name,
      family: spec.family,
      availableNow: decision.allowed,
      unavailableReason: decision.reason,
      mutating: Boolean(spec.mutating),
      humanCheckpoint: Boolean(spec.humanCheckpoint),
      lenses: spec.lenses ?? [],
      phases: spec.phases ?? [],
    };
  });
}
