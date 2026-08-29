import { entityRefKey } from "./contracts.js";

function addIndexedItem(byRef, item, fallbackKind) {
  const kind = item.kind || fallbackKind;
  byRef.set(entityRefKey({ kind, id: item.id }), { ...item, kind });
}

export function createPresentationIndex(snapshot) {
  const byRef = new Map();
  const entitiesByKind = new Map();

  for (const entity of snapshot.entities ?? []) {
    addIndexedItem(byRef, entity, "entity");
    const entries = entitiesByKind.get(entity.kind) ?? [];
    entries.push(entity);
    entitiesByKind.set(entity.kind, entries);
  }
  for (const result of snapshot.results ?? []) addIndexedItem(byRef, result, "result");
  for (const source of snapshot.sources ?? []) addIndexedItem(byRef, source, "source");

  return {
    byRef,
    entitiesByKind,
    resultsById: new Map((snapshot.results ?? []).map((result) => [result.id, result])),
    relationsById: new Map((snapshot.relations ?? []).map((relation) => [relation.id, relation])),
    pathsById: new Map((snapshot.paths ?? []).map((path) => [path.id, path])),
    sourcesById: new Map((snapshot.sources ?? []).map((source) => [source.id, source])),
  };
}

export function resolveEntityRef(snapshotOrIndex, reference) {
  const index = snapshotOrIndex.byRef ? snapshotOrIndex : createPresentationIndex(snapshotOrIndex);
  return index.byRef.get(entityRefKey(reference)) ?? null;
}

export function getEntitiesByKind(snapshotOrIndex, ...kinds) {
  const index = snapshotOrIndex.entitiesByKind
    ? snapshotOrIndex
    : createPresentationIndex(snapshotOrIndex);
  return kinds.flatMap((kind) => index.entitiesByKind.get(kind) ?? []);
}

export function resolveInstrumentItems(snapshot, instrument) {
  const index = createPresentationIndex(snapshot);
  return (instrument.entityRefs ?? [])
    .map((reference) => ({ reference, item: resolveEntityRef(index, reference) }))
    .filter((entry) => entry.item);
}

export function normalizeStatus(status) {
  const value = String(status ?? "unknown").toLowerCase();
  if (["pass", "passed", "eligible", "verified", "ready", "approved", "supported"].includes(value)) {
    return "pass";
  }
  if (["fail", "failed", "blocked", "ineligible", "rejected", "missing", "error"].includes(value)) {
    return "fail";
  }
  if (["warning", "warn", "disputed", "unknown", "unresolved", "low-confidence", "stale"].includes(value)) {
    return "warning";
  }
  if (["hypothetical", "scenario", "staged"].includes(value)) return "hypothetical";
  return "neutral";
}

export function formatCanonicalValue(value, unit, locale = "en-GB") {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);

  if (typeof unit === "string" && /^[A-Z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: unit,
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      }).format(value);
    } catch {
      // Fall through to a plain number when the runtime does not know the unit.
    }
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value)}${unit ? ` ${unit}` : ""}`;
}

export function getPrimaryResult(snapshot, references = []) {
  const referencedIds = new Set(references.map((reference) => reference.id));
  return (
    (snapshot.results ?? []).find((result) => referencedIds.has(result.id)) ??
    (snapshot.results ?? []).find((result) => referencedIds.has(result.subjectId)) ??
    snapshot.results?.[0] ??
    null
  );
}

export function getResultFor(snapshot, subjectId, criterionId) {
  return (
    snapshot.results?.find(
      (result) => result.subjectId === subjectId && result.criterionId === criterionId,
    ) ?? null
  );
}

