import {
  CASE_INFO,
  DEFAULT_QUESTION,
  EVIDENCE,
  REQUIREMENTS,
  STAKEHOLDERS,
  VENDORS,
} from "./data/caseData.js";

const ALLOWED_LENSES = new Set(["investigate", "compare", "simulate", "brief"]);
const ALLOWED_MODULES = new Set([
  "source-trace",
  "requirement-gates",
  "vendor-comparison",
  "counterfactual-controls",
  "decision-council",
  "decision-impact",
]);

export function formatCurrency(value) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function getVendor(vendorId) {
  return VENDORS.find((vendor) => vendor.id === vendorId) ?? null;
}

export function getRequirement(requirementId) {
  return REQUIREMENTS.find((requirement) => requirement.id === requirementId) ?? null;
}

export function getEvidence(evidenceId) {
  return EVIDENCE.find((evidence) => evidence.id === evidenceId) ?? null;
}

function resolveVendor(vendor, overrides = {}) {
  const commercial = {
    ...vendor.commercial,
    ...(overrides.commercial ?? {}),
  };
  const operations = {
    ...vendor.operations,
    ...(overrides.operations ?? {}),
  };
  const totalCost =
    overrides.totalCost ??
    commercial.baseCost + commercial.recurringFees + commercial.requiredOptions;

  return { ...vendor, commercial, operations, totalCost };
}

export function evaluateVendor(vendorId, overrides = {}) {
  const vendor = getVendor(vendorId);
  if (!vendor) {
    throw new Error(`Unknown vendor: ${vendorId}`);
  }

  const resolved = resolveVendor(vendor, overrides);
  const { operations, totalCost } = resolved;
  const gates = [
    {
      requirementId: "r1",
      status:
        operations.coverage === "24/7" &&
        operations.namedEngineer &&
        operations.acknowledgementMinutes <= 15 &&
        operations.continuousEngagement
          ? "pass"
          : "fail",
      reason:
        operations.coverage !== "24/7"
          ? "Human incident response is limited to business hours."
          : !operations.namedEngineer
            ? "No named response engineer is committed."
            : operations.acknowledgementMinutes > 15
              ? `Acknowledgement is ${operations.acknowledgementMinutes} minutes, above the 15-minute limit.`
              : !operations.continuousEngagement
                ? "Continuous engagement until resolution is not committed."
                : "Continuous 24/7 response is contractually committed.",
      evidenceIds: vendorId === "vendor-b" ? ["b-monitoring", "b-response"] : [`${vendor.code.toLowerCase()}-response`],
    },
    {
      requirementId: "r2",
      status: operations.euResidency ? "pass" : "fail",
      reason: operations.euResidency
        ? "All customer data and operational telemetry remain in the EU."
        : "The proposal does not guarantee EU-only data residency.",
      evidenceIds: [`${vendor.code.toLowerCase()}-residency`],
    },
    {
      requirementId: "r3",
      status: operations.deploymentWeeks <= 12 ? "pass" : "fail",
      reason:
        operations.deploymentWeeks <= 12
          ? `Deployment completes in ${operations.deploymentWeeks} weeks.`
          : `Deployment requires ${operations.deploymentWeeks} weeks, above the 12-week limit.`,
      evidenceIds: [`${vendor.code.toLowerCase()}-deployment`],
    },
    {
      requirementId: "r4",
      status: totalCost <= 300000 ? "pass" : "fail",
      reason:
        totalCost <= 300000
          ? `${formatCurrency(totalCost)} stays within the three-year cap.`
          : `${formatCurrency(totalCost)} exceeds the cap by ${formatCurrency(totalCost - 300000)}.`,
      evidenceIds: [`${vendor.code.toLowerCase()}-cost`],
    },
  ];

  const failures = gates.filter((gate) => gate.status !== "pass");
  const eligible = failures.length === 0;
  const costScore = Math.max(0, Math.min(30, ((320000 - totalCost) / 70000) * 30));
  const responseScore =
    operations.coverage === "24/7"
      ? Math.max(0, 30 - Math.max(0, operations.acknowledgementMinutes - 15) * 0.8)
      : 8;
  const deploymentScore = Math.max(0, Math.min(20, (14 - operations.deploymentWeeks) * 4));
  const residencyScore = operations.euResidency ? 20 : 0;
  const score = Math.round(costScore + responseScore + deploymentScore + residencyScore);

  return {
    vendorId,
    vendor: resolved,
    gates,
    failures,
    eligible,
    score,
    totalCost,
  };
}

export function evaluateCase(overridesByVendor = {}) {
  const evaluations = VENDORS.map((vendor) =>
    evaluateVendor(vendor.id, overridesByVendor[vendor.id] ?? {}),
  );
  const ranking = [...evaluations].sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (right.score !== left.score) return right.score - left.score;
    return left.totalCost - right.totalCost;
  });

  return {
    evaluations,
    ranking,
    recommendation: ranking.find((entry) => entry.eligible) ?? ranking[0],
  };
}

export function getCausalPaths(vendorId, overrides = {}) {
  const evaluation = evaluateVendor(vendorId, overrides);
  return evaluation.gates.map((gate) => {
    const requirement = getRequirement(gate.requirementId);
    const evidence = gate.evidenceIds.map(getEvidence).filter(Boolean);
    return {
      id: `${vendorId}-${gate.requirementId}`,
      vendorId,
      requirement,
      evidence,
      status: gate.status,
      reason: gate.reason,
      outcome: gate.status === "pass" ? "Requirement verified" : "Mandatory blocker",
    };
  });
}

export function runScenario(vendorId, scenario) {
  const current = evaluateVendor(vendorId);
  const staged = evaluateVendor(vendorId, scenario);
  const changedGates = staged.gates.filter((gate) => {
    const previous = current.gates.find((item) => item.requirementId === gate.requirementId);
    return previous?.status !== gate.status || previous?.reason !== gate.reason;
  });

  return {
    current,
    staged,
    changedGates,
    viable: staged.eligible,
    originalDecisionUnchanged: true,
  };
}

export function classifyQuestion(question = "") {
  const normalized = question.toLowerCase();
  const mentionsWhy = /why|explain|evidence|exactly|ineligible|failed/.test(normalized);
  const mentionsCompare = /compare|versus|vs\.?|difference|which vendor/.test(normalized);
  const mentionsBrief = /brief|committee|council|finance|security reviewer|clinical operations|stakeholder/.test(
    normalized,
  );
  const mentionsScenario = /what (?:must|would)|change to win|scenario|simulate|threshold|concession|if we/.test(
    normalized,
  );

  if (mentionsWhy) return "investigate";
  if (mentionsCompare) return "compare";
  if (mentionsBrief) return "brief";
  if (mentionsScenario) return "simulate";
  return "investigate";
}

function inferVendorIds(question = "") {
  const normalized = question.toLowerCase();
  const matches = VENDORS.filter(
    (vendor) =>
      normalized.includes(vendor.name.toLowerCase()) ||
      normalized.includes(`vendor ${vendor.code.toLowerCase()}`),
  ).map((vendor) => vendor.id);

  if (matches.length) return matches;
  if (/current (?:winner|recommendation)|recommended vendor/.test(normalized)) {
    return [evaluateCase().recommendation.vendorId];
  }
  return classifyQuestion(question) === "compare"
    ? VENDORS.map((vendor) => vendor.id)
    : ["vendor-b"];
}

export function createViewRecipe(
  question = DEFAULT_QUESTION,
  expectedViewRevision = 1,
  expectedDecisionRevision = CASE_INFO.canonicalRevision,
) {
  const lens = classifyQuestion(question);
  const vendorIds = inferVendorIds(question);
  const modulesByLens = {
    investigate: ["source-trace", "requirement-gates", "decision-impact"],
    compare: ["vendor-comparison", "requirement-gates", "decision-impact"],
    simulate: ["source-trace", "counterfactual-controls", "decision-impact"],
    brief: ["decision-council", "source-trace", "decision-impact"],
  };

  return {
    intent: lens === "brief" ? "brief" : lens === "simulate" ? "simulate" : lens === "compare" ? "compare" : "explain",
    lens,
    question: question.trim() || DEFAULT_QUESTION,
    vendorIds,
    requirementIds: REQUIREMENTS.map((requirement) => requirement.id),
    stakeholderIds: lens === "brief" ? STAKEHOLDERS.map((stakeholder) => stakeholder.id) : [],
    modules: modulesByLens[lens],
    density: "focused",
    expectedDecisionRevision,
    expectedViewRevision,
  };
}

export function validateViewRecipe(
  recipe,
  currentViewRevision,
  currentDecisionRevision = CASE_INFO.canonicalRevision,
) {
  const allowedKeys = new Set([
    "intent",
    "lens",
    "question",
    "vendorIds",
    "requirementIds",
    "stakeholderIds",
    "modules",
    "density",
    "expectedDecisionRevision",
    "expectedViewRevision",
    "framing",
  ]);
  const unknownKeys = Object.keys(recipe).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    return { ok: false, error: `Unknown recipe fields: ${unknownKeys.join(", ")}` };
  }
  if (!ALLOWED_LENSES.has(recipe.lens)) {
    return { ok: false, error: "Unsupported view lens." };
  }
  if (recipe.expectedDecisionRevision !== currentDecisionRevision) {
    return { ok: false, error: "The recipe targets a stale decision revision." };
  }
  if (recipe.expectedViewRevision !== currentViewRevision) {
    return { ok: false, error: "The room changed before this recipe could be applied." };
  }
  if (!Array.isArray(recipe.modules) || recipe.modules.length > 4) {
    return { ok: false, error: "A view may contain at most four composed modules." };
  }
  if (recipe.modules.some((module) => !ALLOWED_MODULES.has(module))) {
    return { ok: false, error: "The recipe contains an unsupported module." };
  }
  if (
    !Array.isArray(recipe.vendorIds) ||
    recipe.vendorIds.some((id) => !VENDORS.some((vendor) => vendor.id === id))
  ) {
    return { ok: false, error: "The recipe references an unknown vendor." };
  }
  if (
    !Array.isArray(recipe.requirementIds) ||
    recipe.requirementIds.some(
      (id) => !REQUIREMENTS.some((requirement) => requirement.id === id),
    )
  ) {
    return { ok: false, error: "The recipe references an unknown requirement." };
  }
  if (recipe.question?.length > 240 || recipe.framing?.length > 180) {
    return { ok: false, error: "Agent-authored view text exceeds the safe limit." };
  }

  return { ok: true };
}

export function queryDecisionGraph({ vendorIds = [], requirementIds = [], statuses = [] } = {}) {
  const selectedVendors = vendorIds.length
    ? VENDORS.filter((vendor) => vendorIds.includes(vendor.id))
    : VENDORS;
  const selectedRequirements = requirementIds.length
    ? REQUIREMENTS.filter((requirement) => requirementIds.includes(requirement.id))
    : REQUIREMENTS;
  const paths = selectedVendors.flatMap((vendor) =>
    getCausalPaths(vendor.id).filter(
      (path) =>
        selectedRequirements.some((requirement) => requirement.id === path.requirement.id) &&
        (!statuses.length || statuses.includes(path.status)),
    ),
  );

  return {
    caseId: CASE_INFO.id,
    canonicalRevision: CASE_INFO.canonicalRevision,
    vendors: selectedVendors,
    requirements: selectedRequirements,
    paths,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value) {
  const input = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sr-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function getDecisionHash() {
  return hashValue({ case: CASE_INFO, vendors: VENDORS, requirements: REQUIREMENTS, evidence: EVIDENCE });
}
