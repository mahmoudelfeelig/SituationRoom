export const PRESENTATION_SCHEMA_VERSION = "1.0";

export const LENSES = Object.freeze(["investigate", "compare", "simulate", "brief"]);

export const LAYOUT_PATTERN_BY_LENS = Object.freeze({
  investigate: "trace",
  compare: "matrix",
  simulate: "fork",
  brief: "council",
});

export const DENSITIES = Object.freeze(["focused", "balanced", "dense"]);
export const REGIONS = Object.freeze(["primary", "secondary", "supporting"]);

export const SNAPSHOT_ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "caseId",
  "decisionRevision",
  "decisionHash",
  "viewRevision",
  "frozen",
  "domain",
  "contract",
  "entities",
  "results",
  "relations",
  "paths",
  "sources",
  "pins",
  "protected",
  "policy",
  "permissions",
  "metadata",
  "domainData",
]);

/**
 * Adapter-friendly normalized snapshot contract.
 *
 * Domain adapters contribute generic entities, results, relations, causal paths,
 * and sources. Presentation code never imports a domain model directly. Optional
 * domain-specific data belongs in `domainData`; it cannot define markup, style,
 * formulas, statuses, permissions, or actions.
 *
 * @typedef {Object} PresentationSnapshot
 * @property {"1.0"} schemaVersion
 * @property {string} caseId
 * @property {number} decisionRevision
 * @property {string} decisionHash
 * @property {number} viewRevision
 * @property {boolean} frozen
 * @property {{id:string, kind:string, label:string, riskLevel?:string}} domain
 * @property {{title:string, question:string, status?:string, authority?:string}} contract
 * @property {Array<PresentationEntity>} entities
 * @property {Array<Object>} results
 * @property {Array<Object>} relations
 * @property {Array<Object>} paths
 * @property {Array<Object>} sources
 * @property {Array<EntityRef>} pins
 * @property {Object} protected
 * @property {Object} policy
 * @property {Object} permissions
 */

/**
 * Source location locators may be a bounded display string or a structured,
 * JSON-safe native locator such as `{page: 4}` or `{sheet: "Costs", range:
 * "B2:E12"}`. The renderer only displays the trusted `label`; adapters retain
 * the structured locator for governed source-opening actions.
 *
 * @typedef {Object} PresentationSourceLocation
 * @property {string} label
 * @property {string|Object} locator
 */

/**
 * @typedef {Object} EntityRef
 * @property {string} kind
 * @property {string} id
 */

/**
 * @typedef {Object} PresentationEntity
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {string=} summary
 * @property {string=} status
 * @property {Object=} attributes
 */

export function entityRefKey(reference) {
  return `${reference?.kind ?? ""}:${reference?.id ?? ""}`;
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isEntityRef(value) {
  return (
    isPlainRecord(value) &&
    typeof value.kind === "string" &&
    value.kind.length >= 1 &&
    value.kind.length <= 80 &&
    typeof value.id === "string" &&
    value.id.length >= 1 &&
    value.id.length <= 160 &&
    Object.keys(value).every((key) => key === "kind" || key === "id")
  );
}

export function getDomainKind(snapshot) {
  return snapshot?.domain?.kind || snapshot?.domain?.id || "generic";
}
