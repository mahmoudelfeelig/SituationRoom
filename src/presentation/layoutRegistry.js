import { DENSITIES, LAYOUT_PATTERN_BY_LENS, LENSES } from "./contracts.js";

const layoutDefinitions = Object.freeze({
  investigate: Object.freeze({
    lens: "investigate",
    pattern: "trace",
    label: "Investigation trace",
    description: "Places a cited source-to-outcome path on the dominant causal stage.",
    regions: Object.freeze(["primary", "secondary", "supporting"]),
  }),
  compare: Object.freeze({
    lens: "compare",
    pattern: "matrix",
    label: "Aligned comparison",
    description: "Aligns alternatives against the same canonical criteria.",
    regions: Object.freeze(["primary", "secondary", "supporting"]),
  }),
  simulate: Object.freeze({
    lens: "simulate",
    pattern: "fork",
    label: "Canonical and hypothetical fork",
    description: "Separates the immutable record from staged controls and outcomes.",
    regions: Object.freeze(["primary", "secondary", "supporting"]),
  }),
  brief: Object.freeze({
    lens: "brief",
    pattern: "council",
    label: "Decision council",
    description: "Converges stakeholder mandates into a protected recommendation.",
    regions: Object.freeze(["primary", "secondary", "supporting"]),
  }),
});

export function getLayoutDefinition(lens) {
  return layoutDefinitions[lens] ?? null;
}

export function validateLayout(lens, layout) {
  const errors = [];
  if (!LENSES.includes(lens)) {
    errors.push(`Unsupported lens: ${String(lens)}.`);
    return errors;
  }
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    errors.push("Recipe layout must be an object.");
    return errors;
  }
  const unknownKeys = Object.keys(layout).filter((key) => key !== "pattern" && key !== "density");
  if (unknownKeys.length) errors.push(`Unknown layout fields: ${unknownKeys.join(", ")}.`);
  if (layout.pattern !== LAYOUT_PATTERN_BY_LENS[lens]) {
    errors.push(`${lens} recipes must use the ${LAYOUT_PATTERN_BY_LENS[lens]} layout pattern.`);
  }
  if (!DENSITIES.includes(layout.density)) {
    errors.push(`Unsupported layout density: ${String(layout.density)}.`);
  }
  return errors;
}

export function listLayoutDefinitions() {
  return Object.values(layoutDefinitions);
}

