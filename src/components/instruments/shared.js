import { createPresentationIndex, resolveEntityRef } from "../../presentation/presentationSelectors.js";

export function referencedItems(snapshot, instrument, kinds = null) {
  const index = createPresentationIndex(snapshot);
  const kindSet = kinds ? new Set(kinds) : null;
  return (instrument.entityRefs ?? [])
    .map((reference) => ({ reference, item: resolveEntityRef(index, reference) }))
    .filter(({ item }) => item && (!kindSet || kindSet.has(item.kind)));
}

export function itemsByKinds(snapshot, kinds, limit = 100) {
  const kindSet = new Set(kinds);
  return (snapshot.entities ?? []).filter((item) => kindSet.has(item.kind)).slice(0, limit);
}

export function firstNonEmpty(...collections) {
  return collections.find((collection) => collection?.length) ?? [];
}

export function getLimit(instrument, fallback = 12) {
  const limit = instrument.options?.limit;
  return Number.isInteger(limit) ? limit : fallback;
}

export function citationFor(item) {
  return item?.attributes?.citation || item?.citation || item?.location || null;
}

export function confidenceFor(item) {
  const value = item?.attributes?.confidence ?? item?.confidence;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

export function titleFor(item, fallback = "Untitled canonical item") {
  return item?.label || item?.title || item?.name || fallback;
}

export function summaryFor(item) {
  return item?.summary || item?.text || item?.reason || "No explanatory text was provided.";
}

export function sortCanonical(items, sort = "canonical") {
  const copy = [...items];
  if (sort === "label") return copy.sort((left, right) => titleFor(left).localeCompare(titleFor(right)));
  if (sort === "status") return copy.sort((left, right) => String(left.status).localeCompare(String(right.status)));
  if (sort === "value-asc") return copy.sort((left, right) => Number(left.value ?? 0) - Number(right.value ?? 0));
  if (sort === "value-desc") return copy.sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0));
  return copy;
}

