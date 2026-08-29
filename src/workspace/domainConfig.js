export const DOMAIN_CONFIG = Object.freeze({
  procurement: Object.freeze({
    id: "procurement",
    label: "Procurement",
    shortLabel: "Vendor award",
    authorityLabel: "Decision owner approves award",
    riskLevel: "governed",
    accent: "oxide",
    defaultQuestion: "Which vendor satisfies every mandatory gate, and what could reverse the recommendation?",
    prompts: Object.freeze([
      "Compare every vendor against the mandatory gates.",
      "What minimum concession makes the cheapest vendor eligible?",
      "Show contradictions that could reverse the recommendation.",
      "Brief Finance, Operations, and Information Security.",
    ]),
  }),
  "candidate-review": Object.freeze({
    id: "candidate-review",
    label: "Candidate review",
    shortLabel: "Evidence-led shortlist",
    authorityLabel: "Human panel retains employment authority",
    riskLevel: "high",
    accent: "ink",
    defaultQuestion: "Who has verified evidence for every required capability, and where is proof still missing?",
    prompts: Object.freeze([
      "Compare only verified job-related requirements.",
      "Show the experience timeline and overlapping dates.",
      "Hide identity fields and surface missing verification.",
      "Challenge the current shortlist for inconsistent evidence standards.",
    ]),
  }),
  "health-plan": Object.freeze({
    id: "health-plan",
    label: "Consumer health plans",
    shortLabel: "Coverage choice",
    authorityLabel: "Consumer decides; no underwriting or claims action",
    riskLevel: "sensitive",
    accent: "teal",
    defaultQuestion: "Which plan best fits this household, and how does the answer change if specialist use doubles?",
    prompts: Object.freeze([
      "Compare premium, deductible, and out-of-pocket exposure.",
      "Show provider, formulary, and exclusion evidence only.",
      "Simulate a year with double specialist use.",
      "Find missing evidence that could reverse the recommendation.",
    ]),
  }),
  generic: Object.freeze({
    id: "generic",
    label: "General decision",
    shortLabel: "Typed comparison",
    authorityLabel: "Named human decision owner",
    riskLevel: "standard",
    accent: "umber",
    defaultQuestion: "Compare the feasible options and show which assumptions matter most.",
    prompts: Object.freeze([
      "Compare all alternatives against the same criteria.",
      "Show the Pareto frontier and dominated options.",
      "Run a sensitivity analysis on the two highest weights.",
      "Build a concise decision brief with unresolved evidence.",
    ]),
  }),
});

export const LENS_CONFIG = Object.freeze({
  investigate: Object.freeze({
    id: "investigate",
    label: "Trace",
    longLabel: "Causal trace",
    pattern: "trace",
    density: "focused",
  }),
  compare: Object.freeze({
    id: "compare",
    label: "Compare",
    longLabel: "Aligned comparison",
    pattern: "matrix",
    density: "dense",
  }),
  simulate: Object.freeze({
    id: "simulate",
    label: "Simulate",
    longLabel: "Scenario fork",
    pattern: "fork",
    density: "balanced",
  }),
  brief: Object.freeze({
    id: "brief",
    label: "Brief",
    longLabel: "Decision council",
    pattern: "council",
    density: "balanced",
  }),
});

export function getDomainConfig(packId) {
  return DOMAIN_CONFIG[packId] ?? DOMAIN_CONFIG.generic;
}

