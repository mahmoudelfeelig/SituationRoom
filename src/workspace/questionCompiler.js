import { LENS_CONFIG } from "./domainConfig.js";
import { getInstrumentDefinition } from "../presentation/instrumentRegistry.js";

const DOMAIN_INSTRUMENTS = Object.freeze({
  procurement: Object.freeze({
    investigate: ["causal-trace", "evidence-excerpt", "claim-interpretation", "compliance-gate-wall", "outcome-seal"],
    compare: ["vendor-lanes", "compliance-gate-wall", "tco-waterfall", "score-breakdown"],
    simulate: ["concession-set", "tco-waterfall", "constraint-gate", "outcome-seal"],
    brief: ["stakeholder-mandate", "compliance-gate-wall", "tco-waterfall", "decision-brief"],
  }),
  candidate: Object.freeze({
    investigate: ["evidence-excerpt", "claim-interpretation", "verified-experience-timeline", "missing-verification-docket", "missing-evidence"],
    compare: ["candidate-requirement-coverage", "verified-experience-timeline", "missing-verification-docket", "evidence-excerpt"],
    simulate: ["scenario-controls", "missing-evidence", "constraint-gate", "missing-verification-docket"],
    brief: ["stakeholder-mandate", "candidate-requirement-coverage", "missing-verification-docket", "evidence-excerpt"],
  }),
  "health-plan": Object.freeze({
    investigate: ["evidence-excerpt", "provider-network-check", "formulary-coverage-table", "missing-evidence", "outcome-seal"],
    compare: ["comparison-matrix", "plan-cost-waterfall", "provider-network-check", "formulary-coverage-table"],
    simulate: ["utilization-scenario", "plan-cost-waterfall", "sensitivity-plot", "outcome-seal"],
    brief: ["stakeholder-mandate", "plan-cost-waterfall", "provider-network-check", "decision-brief"],
  }),
  generic: Object.freeze({
    investigate: ["causal-trace", "evidence-excerpt", "claim-interpretation", "data-quality-docket", "outcome-seal"],
    compare: ["comparison-matrix", "weighted-criteria", "pareto-frontier", "score-breakdown"],
    simulate: ["scenario-controls", "sensitivity-plot", "missing-evidence", "metric-waterfall", "outcome-seal"],
    brief: ["stakeholder-mandate", "weighted-criteria", "pareto-frontier", "decision-brief"],
  }),
});

const SOURCE_TYPES = new Set([
  "evidence-excerpt",
  "source-preview",
  "provider-network-check",
  "formulary-coverage-table",
]);

const RESULT_TYPES = new Set([
  "constraint-gate",
  "outcome-seal",
  "contradiction-docket",
  "missing-evidence",
  "comparison-matrix",
  "score-breakdown",
  "metric-waterfall",
  "sensitivity-plot",
  "risk-frontier",
  "decision-brief",
  "data-quality-docket",
  "vendor-lanes",
  "compliance-gate-wall",
  "tco-waterfall",
  "concession-set",
  "candidate-requirement-coverage",
  "missing-verification-docket",
  "plan-cost-waterfall",
  "utilization-scenario",
  "weighted-criteria",
  "pareto-frontier",
]);

function normalizeQuestion(question) {
  const value = String(question ?? "").trim().replace(/\s+/g, " ");
  if (value.length >= 4) return value.slice(0, 240);
  return "Explain this decision.";
}

export function classifyDecisionQuestion(question, requestedLens) {
  if (requestedLens && LENS_CONFIG[requestedLens]) {
    return { lens: requestedLens, intent: requestedLens === "investigate" ? "explain" : requestedLens };
  }
  const text = normalizeQuestion(question).toLowerCase();
  if (/brief|memo|committee|stakeholder|executive|summari[sz]e|recommendation packet/.test(text)) {
    return { lens: "brief", intent: "brief" };
  }
  if (/what[- ]?if|scenario|simulate|double|change|concession|threshold|sensitivity|minimum change/.test(text)) {
    return { lens: "simulate", intent: "simulate" };
  }
  if (/compare|versus| vs\.? |rank|matrix|all (vendors|candidates|plans|options)|pareto|which/.test(` ${text} `)) {
    return { lens: "compare", intent: "compare" };
  }
  if (/challenge|contradiction|opposing|reverse|against|audit/.test(text)) {
    return { lens: "investigate", intent: text.includes("audit") ? "audit" : "challenge" };
  }
  return { lens: "investigate", intent: "explain" };
}

function referenceLists(snapshot) {
  const entityRefs = (snapshot.entities ?? []).map((entity) => ({ kind: entity.kind, id: entity.id }));
  const byKind = new Map();
  for (const reference of entityRefs) {
    const entries = byKind.get(reference.kind) ?? [];
    entries.push(reference);
    byKind.set(reference.kind, entries);
  }
  return {
    allEntities: entityRefs,
    alternatives: byKind.get("alternative") ?? [],
    criteria: byKind.get("criterion") ?? [],
    controls: [...(byKind.get("control") ?? []), ...(byKind.get("scenario-control") ?? [])],
    claims: byKind.get("claim") ?? [],
    constraints: byKind.get("constraint") ?? [],
    stakeholders: byKind.get("stakeholder") ?? [],
    sources: (snapshot.sources ?? []).map((source) => ({ kind: source.kind ?? "source", id: source.id })),
    results: (snapshot.results ?? []).map((result) => ({ kind: result.kind ?? "result", id: result.id })),
  };
}

function refsForInstrument(type, refs, activePath) {
  if (type === "causal-trace" && activePath) return activePath.entityRefs.slice(0, 24);
  if (SOURCE_TYPES.has(type)) return [...refs.sources, ...refs.claims].slice(0, 24);
  if (type === "claim-interpretation") return refs.claims.slice(0, 24);
  if (type === "timeline" || type === "verified-experience-timeline") {
    return [...refs.alternatives, ...refs.claims, ...refs.sources].slice(0, 40);
  }
  if (type === "stakeholder-mandate") return refs.stakeholders.slice(0, 24);
  if (type === "scenario-controls") return refs.controls.slice(0, 20);
  if (RESULT_TYPES.has(type)) {
    return [...refs.alternatives, ...refs.criteria, ...refs.results].slice(0, 72);
  }
  return [...refs.alternatives, ...refs.criteria, ...refs.results].slice(0, 48);
}

function optionsForInstrument(type) {
  const options = { density: "standard", limit: 18 };
  if (["evidence-excerpt", "source-preview", "causal-trace", "decision-brief"].includes(type)) {
    options.showCitations = true;
  }
  if (["evidence-excerpt", "causal-trace", "missing-evidence", "contradiction-docket"].includes(type)) {
    options.showConfidence = true;
  }
  if (["comparison-matrix", "vendor-lanes", "candidate-requirement-coverage", "formulary-coverage-table"].includes(type)) {
    options.stickyHeaders = true;
  }
  if (["metric-waterfall", "tco-waterfall", "plan-cost-waterfall"].includes(type)) {
    options.mode = "cumulative";
    options.showBaseline = true;
  }
  if (["scenario-controls", "sensitivity-plot", "concession-set", "utilization-scenario"].includes(type)) {
    options.showBaseline = true;
  }
  if (["timeline", "verified-experience-timeline"].includes(type)) options.scale = "years";
  const allowedKeys = new Set(getInstrumentDefinition(type)?.optionKeys ?? []);
  return Object.fromEntries(Object.entries(options).filter(([key]) => allowedKeys.has(key)));
}

function contextualTypes(domain, lens, question) {
  const base = [...(DOMAIN_INSTRUMENTS[domain]?.[lens] ?? DOMAIN_INSTRUMENTS.generic[lens])];
  const text = question.toLowerCase();
  const insert = (type, index = 1) => {
    if (!base.includes(type)) base.splice(Math.min(index, base.length), 0, type);
  };
  if (lens !== "simulate" && /contradiction|opposing|reverse|challenge|inconsistent/.test(text)) {
    insert("contradiction-docket");
  }
  if (/missing|weak|unknown|unverified|data quality|unreadable/.test(text)) insert("missing-evidence");
  if (lens !== "simulate" && /timeline|date|overlap|experience/.test(text)) insert("timeline");
  if (lens !== "investigate" && /cost|price|premium|deductible|budget|afford/.test(text) && domain === "generic") {
    insert("metric-waterfall");
  }
  if (/source|citation|evidence|proof/.test(text) && lens !== "simulate") insert("evidence-excerpt");
  return base.slice(0, 8);
}

export function createPresentationRecipe(snapshot, question, options = {}) {
  const normalizedQuestion = normalizeQuestion(question || snapshot.contract.question);
  const classification = classifyDecisionQuestion(normalizedQuestion, options.lens);
  const lensConfig = LENS_CONFIG[classification.lens];
  const domain = snapshot.domain?.kind ?? "generic";
  const refs = referenceLists(snapshot);
  const activePath = options.pathId
    ? snapshot.paths.find((path) => path.id === options.pathId)
    : snapshot.paths[0];
  const types = contextualTypes(domain, classification.lens, normalizedQuestion);
  const instruments = types.map((type, index) => ({
    id: `instrument:${classification.lens}:${index + 1}:${type}`,
    type,
    region: index === 0 ? "primary" : index < 4 ? "secondary" : "supporting",
    priority: 100 - index * 10,
    entityRefs: refsForInstrument(type, refs, activePath),
    ...(type === "causal-trace" && activePath ? { pathId: activePath.id } : {}),
    ...(type === "outcome-seal" && classification.lens === "simulate" ? { variant: "hypothetical" } : {}),
    options: optionsForInstrument(type),
  }));
  const focusReference = options.focusRef ?? activePath?.entityRefs?.at(-1) ?? refs.alternatives[0];
  const framing = options.framing ?? (
    classification.intent === "challenge"
      ? "The room foregrounds evidence capable of changing the current conclusion."
      : `The room is compiled around a ${lensConfig.longLabel.toLowerCase()} without changing the decision record.`
  );

  return {
    schemaVersion: "1.0",
    recipeId: `recipe:${snapshot.caseId}:${snapshot.viewRevision}:${classification.lens}`,
    intent: classification.intent,
    lens: classification.lens,
    question: normalizedQuestion,
    framing: framing.slice(0, 180),
    layout: {
      pattern: lensConfig.pattern,
      density: options.density ?? lensConfig.density,
    },
    instruments,
    ...(focusReference || activePath
      ? {
          focus: {
            ...(focusReference ? { entityRef: focusReference } : {}),
            ...(activePath ? { pathId: activePath.id } : {}),
          },
        }
      : {}),
    expectedDecisionRevision: snapshot.decisionRevision,
    expectedViewRevision: snapshot.viewRevision,
  };
}
