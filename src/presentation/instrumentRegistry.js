import { isPlainRecord, LENSES, REGIONS } from "./contracts.js";

const OPTION_RULES = Object.freeze({
  density: { type: "enum", values: ["compact", "standard", "expanded"] },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  sort: { type: "enum", values: ["canonical", "status", "label", "value-asc", "value-desc"] },
  showCitations: { type: "boolean" },
  showConfidence: { type: "boolean" },
  orientation: { type: "enum", values: ["horizontal", "vertical"] },
  transpose: { type: "boolean" },
  stickyHeaders: { type: "boolean" },
  scale: { type: "enum", values: ["auto", "days", "weeks", "months", "years"] },
  mode: { type: "enum", values: ["cumulative", "stacked", "range", "ranked"] },
  showBaseline: { type: "boolean" },
  compact: { type: "boolean" },
});

function definition({
  type,
  label,
  description,
  lenses = LENSES,
  domains = ["*"],
  variants = ["default"],
  options = ["density", "limit"],
  maxEntityRefs = 100,
  emptyState = "No canonical data is available for this instrument.",
  protectedType = false,
}) {
  return Object.freeze({
    type,
    label,
    description,
    lenses: Object.freeze([...lenses]),
    domains: Object.freeze([...domains]),
    variants: Object.freeze([...variants]),
    optionKeys: Object.freeze([...options]),
    maxEntityRefs,
    emptyState,
    protectedType,
  });
}

const definitions = [
  definition({
    type: "protected-invariants",
    label: "Required checks",
    description: "Shows protected constraints, blockers, authority, and prohibited inputs.",
    options: ["density", "limit"],
    protectedType: true,
  }),
  definition({
    type: "pinned-context",
    label: "Human-pinned context",
    description: "Keeps human-pinned evidence or policy visible across compositions.",
    options: ["density", "limit", "showCitations"],
    protectedType: true,
  }),
  definition({
    type: "evidence-excerpt",
    label: "Evidence excerpt",
    description: "Displays exact canonical evidence with source location and confidence.",
    lenses: ["investigate", "compare", "brief"],
    options: ["density", "limit", "showCitations", "showConfidence"],
  }),
  definition({
    type: "source-preview",
    label: "Source preview",
    description: "Shows source identity, parse state, and exact locations without executing source content.",
    lenses: ["investigate", "brief"],
    options: ["density", "limit", "showCitations"],
  }),
  definition({
    type: "claim-interpretation",
    label: "Claim interpretation",
    description: "Displays a normalized claim and its governed interpretation.",
    lenses: ["investigate"],
    options: ["density", "limit", "showConfidence"],
  }),
  definition({
    type: "constraint-gate",
    label: "Constraint gate",
    description: "Evaluates referenced alternatives against canonical constraints.",
    lenses: ["investigate", "compare", "simulate"],
    options: ["density", "limit", "sort"],
  }),
  definition({
    type: "outcome-seal",
    label: "Outcome seal",
    description: "Displays a canonical or explicitly hypothetical outcome.",
    options: ["density", "limit", "showCitations"],
    variants: ["default", "canonical", "hypothetical"],
  }),
  definition({
    type: "causal-trace",
    label: "Causal trace",
    description: "Renders one existing graph path in source-to-outcome order.",
    lenses: ["investigate"],
    options: ["density", "showCitations", "showConfidence", "orientation"],
    maxEntityRefs: 24,
  }),
  definition({
    type: "contradiction-docket",
    label: "Conflicting evidence",
    description: "Pairs supporting and opposing canonical claims without resolving them silently.",
    lenses: ["investigate", "compare", "brief"],
    options: ["density", "limit", "showCitations", "showConfidence"],
  }),
  definition({
    type: "missing-evidence",
    label: "Missing evidence",
    description: "Lists unresolved, low-confidence, unreadable, or absent evidence.",
    options: ["density", "limit", "sort", "showConfidence"],
  }),
  definition({
    type: "comparison-matrix",
    label: "Comparison matrix",
    description: "Aligns alternatives and results against shared criteria.",
    lenses: ["compare"],
    options: ["density", "limit", "sort", "transpose", "stickyHeaders"],
  }),
  definition({
    type: "score-breakdown",
    label: "Score breakdown",
    description: "Explains canonical component results without calculating new scores.",
    lenses: ["compare", "brief"],
    options: ["density", "limit", "sort", "showCitations"],
  }),
  definition({
    type: "metric-waterfall",
    label: "Metric waterfall",
    description: "Displays canonical metric components without combining unlike units or subjects.",
    lenses: ["compare", "simulate", "brief"],
    options: ["density", "limit", "sort", "mode", "showBaseline"],
  }),
  definition({
    type: "scenario-controls",
    label: "Scenario controls",
    description: "Presents trusted control definitions for hypothetical evaluation.",
    lenses: ["simulate"],
    options: ["density", "limit", "showBaseline"],
  }),
  definition({
    type: "sensitivity-plot",
    label: "Sensitivity plot",
    description: "Displays canonical sensitivity samples and thresholds.",
    lenses: ["simulate", "compare"],
    options: ["density", "limit", "orientation", "showBaseline"],
  }),
  definition({
    type: "timeline",
    label: "Timeline",
    description: "Places dated canonical events on a legible sequence.",
    lenses: ["investigate", "compare", "brief"],
    options: ["density", "limit", "sort", "scale"],
  }),
  definition({
    type: "risk-frontier",
    label: "Risk frontier",
    description: "Compares canonical risk and benefit values without inventing axes.",
    lenses: ["compare", "brief"],
    options: ["density", "limit", "sort", "showConfidence"],
  }),
  definition({
    type: "stakeholder-mandate",
    label: "Stakeholder mandate",
    description: "Shows affected people, accountable reviewers, and their declared mandates.",
    lenses: ["brief"],
    options: ["density", "limit", "sort"],
  }),
  definition({
    type: "decision-brief",
    label: "Decision brief",
    description: "Converges canonical outcomes, caveats, and human authority.",
    lenses: ["brief"],
    options: ["density", "limit", "showCitations", "showConfidence"],
  }),
  definition({
    type: "data-quality-docket",
    label: "Data quality issues",
    description: "Summarizes parse quality, missing fields, conflicts, and stale data.",
    options: ["density", "limit", "sort", "showConfidence"],
  }),
  definition({
    type: "vendor-lanes",
    label: "Vendor lanes",
    description: "Procurement alternatives aligned by canonical requirements.",
    lenses: ["compare"],
    domains: ["procurement"],
    options: ["density", "limit", "sort", "stickyHeaders"],
  }),
  definition({
    type: "compliance-gate-wall",
    label: "Compliance gate wall",
    description: "Procurement mandatory and optional gates with cited results.",
    lenses: ["investigate", "compare", "brief"],
    domains: ["procurement"],
    options: ["density", "limit", "sort", "showCitations"],
  }),
  definition({
    type: "tco-waterfall",
    label: "Total-cost waterfall",
    description: "Procurement cost components from canonical commercial results.",
    lenses: ["compare", "simulate", "brief"],
    domains: ["procurement"],
    options: ["density", "limit", "sort", "mode", "showBaseline"],
  }),
  definition({
    type: "concession-set",
    label: "Concession set",
    description: "Procurement changes required by a hypothetical scenario.",
    lenses: ["simulate"],
    domains: ["procurement"],
    options: ["density", "limit", "showBaseline"],
  }),
  definition({
    type: "candidate-requirement-coverage",
    label: "Candidate requirement coverage",
    description: "Verified candidate evidence against declared job requirements.",
    lenses: ["compare", "brief"],
    domains: ["candidate"],
    options: ["density", "limit", "sort", "stickyHeaders", "showCitations"],
  }),
  definition({
    type: "verified-experience-timeline",
    label: "Verified experience timeline",
    description: "Candidate experience supported by explicit source evidence.",
    lenses: ["investigate", "compare", "brief"],
    domains: ["candidate"],
    options: ["density", "limit", "sort", "scale", "showCitations"],
  }),
  definition({
    type: "missing-verification-docket",
    label: "Missing verification",
    description: "Candidate claims that require verification or human follow-up.",
    lenses: ["investigate", "compare", "brief"],
    domains: ["candidate"],
    options: ["density", "limit", "sort", "showConfidence"],
  }),
  definition({
    type: "bias-shield",
    label: "Bias and authority shield",
    description: "Shows prohibited attributes and the human-only decision boundary.",
    domains: ["candidate"],
    options: ["density", "limit"],
    protectedType: true,
  }),
  definition({
    type: "plan-cost-waterfall",
    label: "Health-plan cost waterfall",
    description: "Premium, deductible, copay, coinsurance, and out-of-pocket values from canonical plan data.",
    lenses: ["compare", "simulate", "brief"],
    domains: ["health-plan"],
    options: ["density", "limit", "sort", "mode", "showBaseline"],
  }),
  definition({
    type: "provider-network-check",
    label: "Provider network check",
    description: "Shows explicit in-network, out-of-network, and unresolved provider evidence.",
    lenses: ["investigate", "compare", "brief"],
    domains: ["health-plan"],
    options: ["density", "limit", "sort", "showCitations", "showConfidence"],
  }),
  definition({
    type: "formulary-coverage-table",
    label: "Formulary coverage table",
    description: "Shows cited drug tier and restriction data without medical inference.",
    lenses: ["investigate", "compare", "brief"],
    domains: ["health-plan"],
    options: ["density", "limit", "sort", "stickyHeaders", "showCitations"],
  }),
  definition({
    type: "utilization-scenario",
    label: "Utilization scenario",
    description: "Applies trusted hypothetical utilization controls to plan rules.",
    lenses: ["simulate"],
    domains: ["health-plan"],
    options: ["density", "limit", "showBaseline"],
  }),
  definition({
    type: "weighted-criteria",
    label: "Weighted criteria",
    description: "Generic declared criteria and canonical weights.",
    lenses: ["compare", "brief"],
    domains: ["generic"],
    options: ["density", "limit", "sort", "showConfidence"],
  }),
  definition({
    type: "pareto-frontier",
    label: "Pareto frontier",
    description: "Generic canonical trade-off values and non-dominated alternatives.",
    lenses: ["compare", "brief"],
    domains: ["generic"],
    options: ["density", "limit", "sort", "showConfidence"],
  }),
];

const registry = new Map(definitions.map((item) => [item.type, item]));

export const TRUSTED_INSTRUMENT_TYPES = Object.freeze(definitions.map((item) => item.type));

export function getInstrumentDefinition(type) {
  return registry.get(type) ?? null;
}

export function listInstrumentDefinitions({ domain, lens } = {}) {
  return definitions.filter((item) => {
    const domainAllowed = !domain || item.domains.includes("*") || item.domains.includes(domain);
    const lensAllowed = !lens || item.lenses.includes(lens);
    return domainAllowed && lensAllowed;
  });
}

function validateRule(key, value, rule) {
  if (rule.type === "boolean" && typeof value !== "boolean") return `${key} must be a boolean.`;
  if (rule.type === "integer") {
    if (!Number.isInteger(value)) return `${key} must be an integer.`;
    if (value < rule.minimum || value > rule.maximum) {
      return `${key} must be between ${rule.minimum} and ${rule.maximum}.`;
    }
  }
  if (rule.type === "enum" && !rule.values.includes(value)) {
    return `${key} must be one of: ${rule.values.join(", ")}.`;
  }
  return null;
}

export function validateInstrumentOptions(definitionValue, options) {
  const errors = [];
  if (!isPlainRecord(options)) return ["Instrument options must be an object."];
  const unknownKeys = Object.keys(options).filter((key) => !definitionValue.optionKeys.includes(key));
  if (unknownKeys.length) errors.push(`Unsupported options: ${unknownKeys.join(", ")}.`);
  for (const key of definitionValue.optionKeys) {
    if (!(key in options)) continue;
    const error = validateRule(key, options[key], OPTION_RULES[key]);
    if (error) errors.push(error);
  }
  return errors;
}

export function validateInstrumentPlacement(instrument, { domain, lens }) {
  const errors = [];
  const definitionValue = getInstrumentDefinition(instrument?.type);
  if (!definitionValue) return [`Unsupported instrument type: ${String(instrument?.type)}.`];
  if (!definitionValue.lenses.includes(lens)) {
    errors.push(`${instrument.type} is not available in the ${lens} lens.`);
  }
  if (!definitionValue.domains.includes("*") && !definitionValue.domains.includes(domain)) {
    errors.push(`${instrument.type} is not available for the ${domain} domain.`);
  }
  if (!REGIONS.includes(instrument.region)) {
    errors.push(`Unsupported instrument region: ${String(instrument.region)}.`);
  }
  if (instrument.variant !== undefined && !definitionValue.variants.includes(instrument.variant)) {
    errors.push(`Unsupported ${instrument.type} variant: ${String(instrument.variant)}.`);
  }
  if (Array.isArray(instrument.entityRefs) && instrument.entityRefs.length > definitionValue.maxEntityRefs) {
    errors.push(`${instrument.type} supports at most ${definitionValue.maxEntityRefs} entity references.`);
  }
  errors.push(...validateInstrumentOptions(definitionValue, instrument.options ?? {}));
  return errors;
}
