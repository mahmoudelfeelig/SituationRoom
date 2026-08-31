import { sha256Hex } from "../kernel/canonicalize.js";

export const SEMANTIC_INTAKE_LIMITS = Object.freeze({
  maxDocuments: 64,
  maxBlocksPerDocument: 5_000,
  maxBlocks: 20_000,
  maxBlockTextLength: 20_000,
  maxSuggestions: 128,
  maxSuggestionBytes: 64 * 1024,
  maxSingleSuggestionBytes: 8 * 1024,
  maxSuggestionRefs: 16,
  maxStringLength: 500,
});

export const SEMANTIC_INTAKE_CONFIDENCE = Object.freeze({
  reviewReady: 0.8,
  exactIdentity: 0.98,
  inferredDocumentIdentity: 0.55,
  knownCriterion: 0.96,
  unknownCriterion: 0.76,
  aliasSimilarity: 0.82,
});

const IDENTITY_FIELDS = new Set([
  "alternative",
  "candidate",
  "choice",
  "company",
  "entity",
  "id",
  "identifier",
  "name",
  "option",
  "plan",
  "product",
  "provider",
  "supplier",
  "title",
  "vendor",
]);

const KNOWN_CRITERION_PATTERN = /(?:^|_)(?:availability|benefit|capacity|compliance|cost|coverage|deductible|distance|duration|emission|experience|latency|mandatory|network|performance|premium|price|quality|rating|required|residency|response|risk|score|security|skill|support|time|weight)(?:_|$)/;
const LEGAL_SUFFIX_PATTERN = /\b(?:ag|co|company|corp|corporation|gmbh|inc|incorporated|limited|llc|ltd|plc)\b$/;
const SUGGESTION_KINDS = new Set(["entity-resolution", "field-mapping"]);
const BASE_SUGGESTION_KEYS = new Set(["id", "kind", "confidence", "sourceRefs"]);
const ENTITY_SUGGESTION_KEYS = new Set([...BASE_SUGGESTION_KEYS, "aliases"]);
const FIELD_SUGGESTION_KEYS = new Set([...BASE_SUGGESTION_KEYS, "sourceField", "targetCriterion"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnostic(code, message, details = undefined, severity = "warning") {
  return {
    code,
    severity,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function boundedJsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizedWords(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedField(value) {
  return normalizedWords(value).replaceAll(" ", "_").slice(0, 120);
}

function normalizedEntity(value) {
  return normalizedWords(value).slice(0, 160);
}

function slug(value, fallback = "item") {
  return normalizedWords(value).replaceAll(" ", "-").slice(0, 100) || fallback;
}

function displayCriterion(field) {
  return field
    .split("_")
    .filter(Boolean)
    .map((word, index) => index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word)
    .join(" ");
}

function confidence(value, fallback = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function confidenceStatus(value) {
  return value >= SEMANTIC_INTAKE_CONFIDENCE.reviewReady ? "review-ready" : "proposed";
}

function cloneLocator(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 128 || depth > 6) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 1_000 ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (value.length > 32) return null;
    const entries = value.map((entry) => cloneLocator(entry, state, depth + 1));
    return entries.some((entry, index) => entry === null && value[index] !== null) ? null : entries;
  }
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) return null;
  const result = {};
  for (const [key, entry] of entries) {
    if (!key || key.length > 80 || ["__proto__", "constructor", "prototype"].includes(key)) return null;
    const cloned = cloneLocator(entry, state, depth + 1);
    if (cloned === null && entry !== null) return null;
    result[key] = cloned;
  }
  return result;
}

function anchorFor(document, block) {
  if (!document?.id || !block?.id || typeof block.text !== "string") return null;
  const locator = cloneLocator(block.locator);
  if (!locator) return null;
  return {
    documentId: document.id,
    fragmentId: block.id,
    locator,
    quoteHash: `sha256:${sha256Hex(block.text)}`,
  };
}

function dedupeAnchors(anchors) {
  const seen = new Set();
  return anchors.filter((anchor) => {
    if (!anchor) return false;
    const key = `${anchor.documentId}\u0000${anchor.fragmentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseValue(raw) {
  if (typeof raw === "boolean" || typeof raw === "number") return raw;
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^(?:yes|true|pass|passed|included|covered|eligible)$/i.test(value)) return true;
  if (/^(?:no|false|fail|failed|excluded|not covered|ineligible)$/i.test(value)) return false;
  const numeric = value
    .replace(/[€$£]/g, "")
    .replace(/\s?(?:eur|usd|gbp)$/i, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/%$/, "")
    .trim();
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) return Number(numeric);
  return value.slice(0, 1_000);
}

function valueKey(value) {
  if (typeof value === "string") return `string:${normalizedWords(value)}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function sourceFieldFromPointer(pointer) {
  const parts = String(pointer ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return parts.at(-1) ?? "";
}

function pointerParent(pointer) {
  const parts = String(pointer ?? "").split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "";
}

function relativePointerField(pointer, root) {
  const pointerParts = String(pointer ?? "").split("/").filter(Boolean);
  const rootParts = String(root ?? "").split("/").filter(Boolean);
  return pointerParts
    .slice(rootParts.length)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function identityFieldPriority(value) {
  const field = normalizedWords(value);
  if (["name", "title"].includes(field)) return 0;
  if (["vendor", "supplier", "candidate", "plan", "provider", "product", "option", "alternative", "choice"].includes(field)) return 1;
  if (["entity", "company"].includes(field)) return 2;
  return 3;
}

function isIdentityField(value) {
  return IDENTITY_FIELDS.has(normalizedWords(value));
}

function cellCoordinate(block) {
  if (Number.isInteger(block.locator?.row) && Number.isInteger(block.locator?.column)) {
    if (block.locator.row < 1 || block.locator.row > 1_048_576 || block.locator.column < 1 || block.locator.column > 16_384) return null;
    return { row: block.locator.row, column: block.locator.column };
  }
  const match = /^([A-Z]+)(\d+)$/i.exec(block.locator?.range ?? "");
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row < 1 || row > 1_048_576 || column < 1 || column > 16_384) return null;
  return { row, column };
}

function makeObservation({ document, block, sourceField, sourceFieldAnchor, anchor, recordId }) {
  const field = normalizedField(sourceField);
  const parsed = parseValue(block.text);
  if (!field || parsed === null) return null;
  return {
    id: `${recordId}:observation:${slug(field)}:${slug(block.id)}`,
    sourceField: String(sourceField).trim().slice(0, 160),
    normalizedField: field,
    value: parsed,
    confidence: confidence(block.confidence),
    sourceAnchor: anchor,
    sourceFieldAnchor: sourceFieldAnchor ?? anchor,
  };
}

function normalizeDocuments(input, diagnostics, unresolved) {
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("INVALID_DOCUMENT_COLLECTION", "Normalized documents must be supplied as an array.", undefined, "error"));
    return [];
  }
  if (input.length > SEMANTIC_INTAKE_LIMITS.maxDocuments) {
    diagnostics.push(diagnostic(
      "DOCUMENT_LIMIT_EXCEEDED",
      "The document collection exceeds the semantic intake safety limit and was not processed.",
      { received: input.length, limit: SEMANTIC_INTAKE_LIMITS.maxDocuments },
      "error",
    ));
    return [];
  }
  const documents = [];
  const documentIds = new Set();
  const fragmentIds = new Set();
  let blockCount = 0;
  for (const candidate of input) {
    if (!isPlainObject(candidate) || typeof candidate.id !== "string" || !candidate.id || !Array.isArray(candidate.blocks)) {
      diagnostics.push(diagnostic("INVALID_DOCUMENT_SCHEMA", "A normalized document was ignored because its ID or block collection is invalid."));
      continue;
    }
    if (documentIds.has(candidate.id)) {
      diagnostics.push(diagnostic("DUPLICATE_DOCUMENT_ID", "A normalized document with a duplicate ID was ignored.", { documentId: candidate.id }));
      continue;
    }
    if (candidate.blocks.length > SEMANTIC_INTAKE_LIMITS.maxBlocksPerDocument) {
      diagnostics.push(diagnostic(
        "DOCUMENT_BLOCK_LIMIT_EXCEEDED",
        "A document exceeded the per-document block safety limit and was ignored.",
        { documentId: candidate.id, received: candidate.blocks.length },
      ));
      continue;
    }
    if (blockCount + candidate.blocks.length > SEMANTIC_INTAKE_LIMITS.maxBlocks) {
      diagnostics.push(diagnostic("TOTAL_BLOCK_LIMIT_EXCEEDED", "The normalized block collection exceeds the semantic intake safety limit.", undefined, "error"));
      break;
    }
    documentIds.add(candidate.id);
    blockCount += candidate.blocks.length;
    const blocks = [];
    for (const block of candidate.blocks) {
      if (!isPlainObject(block) || typeof block.id !== "string" || !block.id || typeof block.text !== "string") {
        diagnostics.push(diagnostic("INVALID_BLOCK_SCHEMA", "A normalized block was ignored because its ID or text is invalid.", { documentId: candidate.id }));
        continue;
      }
      if (fragmentIds.has(block.id)) {
        diagnostics.push(diagnostic("DUPLICATE_FRAGMENT_ID", "A normalized block with a duplicate fragment ID was ignored.", { fragmentId: block.id }));
        continue;
      }
      fragmentIds.add(block.id);
      if (block.text.length > SEMANTIC_INTAKE_LIMITS.maxBlockTextLength) {
        unresolved.push({
          code: "BLOCK_TEXT_LIMIT_EXCEEDED",
          message: "This block is too large for semantic inference and requires separate review.",
          documentId: candidate.id,
          fragmentId: block.id,
          sourceAnchors: [],
        });
        continue;
      }
      const normalizedBlock = {
        id: block.id,
        documentId: candidate.id,
        text: block.text,
        kind: typeof block.kind === "string" ? block.kind : "paragraph",
        confidence: confidence(block.confidence),
        locator: cloneLocator(block.locator),
      };
      const sourceAnchor = anchorFor(candidate, normalizedBlock);
      if (!sourceAnchor && block.text.trim()) {
        unresolved.push({
          code: "MISSING_SOURCE_ANCHOR",
          message: "This extracted value has no exact source locator and was excluded from semantic mappings.",
          documentId: candidate.id,
          fragmentId: block.id,
          sourceAnchors: [],
        });
      }
      blocks.push({ ...normalizedBlock, sourceAnchor });
    }
    documents.push({
      id: candidate.id,
      name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 240) : candidate.id,
      blocks,
    });
  }
  return documents;
}

function extractTableRecords(document, consumed, unresolved) {
  const anchoredCells = document.blocks.filter((block) =>
    block.kind === "cell" &&
    block.sourceAnchor &&
    cellCoordinate(block),
  );
  if (!anchoredCells.length) return [];
  const tables = new Map();
  for (const block of anchoredCells) {
    consumed.add(block.id);
    const coordinate = cellCoordinate(block);
    const tableKey = String(block.locator?.sheet ?? block.locator?.sheetIndex ?? "Sheet 1");
    const table = tables.get(tableKey) ?? new Map();
    const row = table.get(coordinate.row) ?? new Map();
    row.set(coordinate.column, block);
    table.set(coordinate.row, row);
    tables.set(tableKey, table);
  }
  document.blocks
    .filter((block) => block.kind === "heading" && block.locator?.sheet && tables.has(String(block.locator.sheet)))
    .forEach((block) => consumed.add(block.id));
  const records = [];
  for (const [tableKey, rows] of tables) {
    const rowNumbers = [...rows.keys()].sort((left, right) => left - right);
    const headerRowNumber = rowNumbers[0];
    const headers = rows.get(headerRowNumber);
    for (const rowNumber of rowNumbers.slice(1)) {
      const row = rows.get(rowNumber);
      const identityColumn = [...headers.entries()].find(([, block]) => isIdentityField(block.text))?.[0];
      const identityBlock = identityColumn === undefined ? null : row.get(identityColumn);
      if (!identityBlock?.text.trim()) {
        unresolved.push({
          code: "ENTITY_LABEL_UNRESOLVED",
          message: "A table row has no recognized entity identifier and remains unmapped.",
          documentId: document.id,
          recordRef: `${tableKey}:${rowNumber}`,
          sourceAnchors: dedupeAnchors([...row.values()].map((block) => block.sourceAnchor)),
        });
        continue;
      }
      const recordId = `record:${slug(document.id)}:${slug(tableKey)}:${rowNumber}`;
      const observations = [];
      for (const [column, block] of row) {
        if (column === identityColumn || !block.text.trim()) continue;
        const header = headers.get(column);
        if (!header?.text.trim()) {
          unresolved.push({
            code: "FIELD_LABEL_UNRESOLVED",
            message: "A table value has no source column label and remains unmapped.",
            documentId: document.id,
            fragmentId: block.id,
            sourceAnchors: [block.sourceAnchor],
          });
          continue;
        }
        const observation = makeObservation({
          document,
          block,
          sourceField: header.text,
          sourceFieldAnchor: header.sourceAnchor,
          anchor: block.sourceAnchor,
          recordId,
        });
        if (observation) observations.push(observation);
      }
      records.push({
        id: recordId,
        documentId: document.id,
        label: identityBlock.text.trim().slice(0, 500),
        identityConfidence: identityBlock.confidence,
        identityAnchor: identityBlock.sourceAnchor,
        observations,
      });
    }
  }
  return records;
}

function extractPointerRecords(document, consumed) {
  const pointerBlocks = document.blocks.filter((block) =>
    block.sourceAnchor &&
    block.kind === "field" &&
    (typeof block.locator?.jsonPointer === "string" || typeof block.locator?.xpath === "string"),
  );
  if (!pointerBlocks.length) return [];
  const identities = pointerBlocks.filter((block) => {
    const pointer = block.locator.jsonPointer ?? block.locator.xpath;
    return isIdentityField(sourceFieldFromPointer(pointer));
  });
  const identityGroups = new Map();
  for (const identity of identities) {
    const pointer = identity.locator.jsonPointer ?? identity.locator.xpath;
    const root = pointerParent(pointer);
    const occurrence = identity.locator.xpath ? identity.locator.occurrence ?? 1 : null;
    const key = `${root}\u0000${occurrence ?? "json"}`;
    const group = identityGroups.get(key) ?? { root, occurrence, identities: [] };
    group.identities.push(identity);
    identityGroups.set(key, group);
  }
  const records = [];
  for (const group of identityGroups.values()) {
    const { root, occurrence } = group;
    const identity = [...group.identities].sort((left, right) => {
      const leftField = sourceFieldFromPointer(left.locator.jsonPointer ?? left.locator.xpath);
      const rightField = sourceFieldFromPointer(right.locator.jsonPointer ?? right.locator.xpath);
      return identityFieldPriority(leftField) - identityFieldPriority(rightField);
    })[0];
    const relevant = pointerBlocks.filter((block) => {
      const candidatePointer = block.locator.jsonPointer ?? block.locator.xpath;
      if (!(candidatePointer === root || candidatePointer.startsWith(`${root}/`))) return false;
      if (occurrence !== null && (block.locator.occurrence ?? 1) !== occurrence) return false;
      const nestedIdentity = [...identityGroups.values()].find((candidateGroup) => {
        if (candidateGroup === group) return false;
        return candidateGroup.root.length > root.length && candidatePointer.startsWith(`${candidateGroup.root}/`);
      });
      return !nestedIdentity;
    });
    relevant.forEach((block) => consumed.add(block.id));
    const recordId = `record:${slug(document.id)}:${slug(root || "root")}:${occurrence ?? "json"}`;
    const observations = relevant.flatMap((block) => {
      const candidatePointer = block.locator.jsonPointer ?? block.locator.xpath;
      const field = relativePointerField(candidatePointer, root);
      if (block.id === identity.id || isIdentityField(field)) return [];
      const observation = makeObservation({
        document,
        block,
        sourceField: field,
        sourceFieldAnchor: block.sourceAnchor,
        anchor: block.sourceAnchor,
        recordId,
      });
      return observation ? [observation] : [];
    });
    records.push({
      id: recordId,
      documentId: document.id,
      label: identity.text.trim().slice(0, 500),
      identityConfidence: identity.confidence,
      identityAnchor: identity.sourceAnchor,
      observations,
    });
  }
  return records;
}

function keyValueEntries(block) {
  return block.text
    .split(/[\n;]+/)
    .map((segment) => /^\s*([^:]{1,100}):\s*(.{1,1000})\s*$/.exec(segment))
    .filter(Boolean)
    .map((match) => ({ sourceField: match[1].trim(), value: match[2].trim(), block }));
}

function extractTextRecords(document, consumed, unresolved) {
  const available = document.blocks.filter((block) => block.sourceAnchor && !consumed.has(block.id) && block.text.trim());
  const entries = available.flatMap((block) => keyValueEntries(block));
  const identityEntries = entries.filter((entry) => isIdentityField(entry.sourceField));
  const identityKeys = [...new Set(identityEntries.map((entry) => normalizedEntity(entry.value)).filter(Boolean))];
  const records = [];
  const buildRecord = (label, identityBlock, selectedEntries, identityConfidence, suffix) => {
    const recordId = `record:${slug(document.id)}:text:${suffix}`;
    selectedEntries.forEach((entry) => consumed.add(entry.block.id));
    const observations = selectedEntries.flatMap((entry) => {
      if (isIdentityField(entry.sourceField)) return [];
      const observation = makeObservation({
        document,
        block: { ...entry.block, text: entry.value },
        sourceField: entry.sourceField,
        sourceFieldAnchor: entry.block.sourceAnchor,
        anchor: entry.block.sourceAnchor,
        recordId,
      });
      return observation ? [observation] : [];
    });
    records.push({
      id: recordId,
      documentId: document.id,
      label,
      identityConfidence,
      identityAnchor: identityBlock?.sourceAnchor ?? selectedEntries[0]?.block.sourceAnchor ?? null,
      observations,
    });
  };

  if (identityKeys.length === 1) {
    const identity = identityEntries[0];
    buildRecord(identity.value, identity.block, entries, identity.block.confidence, "document");
  } else if (identityKeys.length > 1) {
    for (const identityKey of identityKeys) {
      const matchingBlocks = new Set(identityEntries
        .filter((entry) => normalizedEntity(entry.value) === identityKey)
        .map((entry) => entry.block.id));
      const selected = entries.filter((entry) => matchingBlocks.has(entry.block.id));
      const identity = selected.find((entry) => isIdentityField(entry.sourceField));
      buildRecord(identity.value, identity.block, selected, identity.block.confidence, slug(identityKey));
    }
    const ambiguous = entries.filter((entry) => !consumed.has(entry.block.id));
    if (ambiguous.length) {
      unresolved.push({
        code: "AMBIGUOUS_TEXT_ENTITY",
        message: "Text fields could relate to more than one entity and remain unmapped.",
        documentId: document.id,
        sourceAnchors: dedupeAnchors(ambiguous.map((entry) => entry.block.sourceAnchor)),
      });
      ambiguous.forEach((entry) => consumed.add(entry.block.id));
    }
  } else if (entries.length) {
    const heading = available.find((block) => block.kind === "heading");
    const label = heading?.text.trim() || document.name.replace(/\.[^.]+$/, "");
    buildRecord(label, heading, entries, SEMANTIC_INTAKE_CONFIDENCE.inferredDocumentIdentity, "inferred-document");
    unresolved.push({
      code: "INFERRED_DOCUMENT_ENTITY",
      message: "No explicit entity field was found; the document label is only a proposed identity.",
      documentId: document.id,
      entityLabel: label,
      sourceAnchors: dedupeAnchors([heading?.sourceAnchor, entries[0]?.block.sourceAnchor]),
    });
  }

  for (const block of available) {
    if (consumed.has(block.id) || block.kind === "table") continue;
    const parsed = keyValueEntries(block);
    if (parsed.length) continue;
    unresolved.push({
      code: "UNSTRUCTURED_TEXT",
      message: "Narrative content was retained for review but not guessed into a field mapping.",
      documentId: document.id,
      fragmentId: block.id,
      sourceAnchors: [block.sourceAnchor],
    });
  }
  return records;
}

function extractRecords(documents, unresolved) {
  const records = [];
  for (const document of documents) {
    const consumed = new Set();
    records.push(...extractTableRecords(document, consumed, unresolved));
    records.push(...extractPointerRecords(document, consumed));
    records.push(...extractTextRecords(document, consumed, unresolved));
  }
  return records;
}

function mergeEntities(records, unresolved) {
  const grouped = new Map();
  for (const record of records) {
    const key = normalizedEntity(record.label);
    if (!key || !record.identityAnchor) {
      unresolved.push({
        code: "ENTITY_IDENTITY_UNRESOLVED",
        message: "A candidate entity has no reviewable identity and was not resolved.",
        documentId: record.documentId,
        recordRef: record.id,
        sourceAnchors: dedupeAnchors([record.identityAnchor]),
      });
      continue;
    }
    const bucket = grouped.get(key) ?? [];
    bucket.push(record);
    grouped.set(key, bucket);
  }
  const entities = [];
  for (const [key, entityRecords] of grouped) {
    const entityId = `entity:${slug(key)}`;
    const aliases = [];
    for (const record of entityRecords) {
      if (!aliases.includes(record.label)) aliases.push(record.label);
    }
    const facts = entityRecords.flatMap((record) => record.observations).map((observation, index) => ({
      id: `fact:${slug(entityId)}:${index + 1}`,
      entityId,
      sourceField: observation.sourceField,
      normalizedField: observation.normalizedField,
      value: observation.value,
      confidence: observation.confidence,
      status: confidenceStatus(observation.confidence),
      sourceAnchor: observation.sourceAnchor,
      sourceFieldAnchor: observation.sourceFieldAnchor,
    }));
    const byDocument = new Map();
    for (const record of entityRecords) {
      const collection = byDocument.get(record.documentId) ?? [];
      collection.push(record);
      byDocument.set(record.documentId, collection);
    }
    for (const [documentId, duplicateRecords] of byDocument) {
      if (duplicateRecords.length < 2) continue;
      unresolved.push({
        code: "DUPLICATE_ENTITY_RECORD",
        message: "Multiple records in one document resolve to the same entity and require confirmation.",
        documentId,
        entityId,
        sourceAnchors: dedupeAnchors(duplicateRecords.map((record) => record.identityAnchor)),
      });
    }
    const entityConfidence = Math.min(
      SEMANTIC_INTAKE_CONFIDENCE.exactIdentity,
      ...entityRecords.map((record) => record.identityConfidence),
    );
    entities.push({
      id: entityId,
      canonicalLabel: entityRecords[0].label,
      aliases,
      normalizedIdentity: key,
      confidence: entityConfidence,
      status: confidenceStatus(entityConfidence) === "review-ready" ? "resolved" : "proposed",
      documentIds: [...new Set(entityRecords.map((record) => record.documentId))],
      resolution: {
        basis: "exact-normalized-identity",
        crossDocument: new Set(entityRecords.map((record) => record.documentId)).size > 1,
        recordCount: entityRecords.length,
      },
      identitySources: dedupeAnchors(entityRecords.map((record) => record.identityAnchor)),
      facts,
    });
  }
  return entities;
}

function conflictsFor(entities) {
  const conflicts = [];
  for (const entity of entities) {
    const byField = new Map();
    for (const fact of entity.facts) {
      const facts = byField.get(fact.normalizedField) ?? [];
      facts.push(fact);
      byField.set(fact.normalizedField, facts);
    }
    for (const [field, facts] of byField) {
      const values = new Map();
      for (const fact of facts) {
        const key = valueKey(fact.value);
        const current = values.get(key) ?? { value: fact.value, sourceAnchors: [], confidence: fact.confidence };
        current.sourceAnchors.push(fact.sourceAnchor);
        current.confidence = Math.min(current.confidence, fact.confidence);
        values.set(key, current);
      }
      if (values.size < 2) continue;
      conflicts.push({
        id: `conflict:${slug(entity.id)}:${slug(field)}`,
        entityId: entity.id,
        normalizedField: field,
        status: "unresolved",
        values: [...values.values()].map((entry) => ({
          ...entry,
          sourceAnchors: dedupeAnchors(entry.sourceAnchors),
        })),
      });
    }
  }
  return conflicts;
}

function mappingsFor(entities, conflicts) {
  const byField = new Map();
  for (const entity of entities) {
    for (const fact of entity.facts) {
      const entry = byField.get(fact.normalizedField) ?? { facts: [], sourceFields: [], entityIds: [] };
      entry.facts.push(fact);
      if (!entry.sourceFields.includes(fact.sourceField)) entry.sourceFields.push(fact.sourceField);
      if (!entry.entityIds.includes(entity.id)) entry.entityIds.push(entity.id);
      byField.set(fact.normalizedField, entry);
    }
  }
  return [...byField.entries()].map(([field, entry]) => {
    const heuristicConfidence = KNOWN_CRITERION_PATTERN.test(field)
      ? SEMANTIC_INTAKE_CONFIDENCE.knownCriterion
      : SEMANTIC_INTAKE_CONFIDENCE.unknownCriterion;
    const mappingConfidence = Math.min(heuristicConfidence, ...entry.facts.map((fact) => fact.confidence));
    const conflicted = conflicts.some((conflict) => conflict.normalizedField === field);
    return {
      id: `mapping:${slug(field)}`,
      sourceFields: entry.sourceFields,
      normalizedField: field,
      targetCriterion: displayCriterion(field),
      basis: "deterministic-evidence",
      confidence: mappingConfidence,
      status: conflicted ? "conflicted" : confidenceStatus(mappingConfidence),
      entityIds: entry.entityIds,
      sourceAnchors: dedupeAnchors(entry.facts.map((fact) => fact.sourceAnchor)),
      sourceFieldAnchors: dedupeAnchors(entry.facts.map((fact) => fact.sourceFieldAnchor)),
    };
  });
}

function resolutionProposalsFor(entities) {
  const candidates = new Map();
  for (const entity of entities) {
    const base = entity.normalizedIdentity.replace(LEGAL_SUFFIX_PATTERN, "").trim();
    if (!base || base === entity.normalizedIdentity) continue;
    const group = candidates.get(base) ?? [];
    group.push(entity);
    candidates.set(base, group);
  }
  for (const entity of entities) {
    const exact = candidates.get(entity.normalizedIdentity);
    if (exact && !exact.includes(entity)) exact.push(entity);
  }
  return [...candidates.entries()].flatMap(([base, group]) => {
    const unique = [...new Map(group.map((entity) => [entity.id, entity])).values()];
    if (unique.length < 2) return [];
    return [{
      id: `resolution:${slug(base)}`,
      entityIds: unique.map((entity) => entity.id),
      aliases: unique.flatMap((entity) => entity.aliases),
      confidence: SEMANTIC_INTAKE_CONFIDENCE.aliasSimilarity,
      status: "proposed",
      basis: "deterministic-alias-similarity",
      sourceAnchors: dedupeAnchors(unique.flatMap((entity) => entity.identitySources)),
    }];
  });
}

function validateSourceRefs(sourceRefs, fragmentIndex) {
  if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > SEMANTIC_INTAKE_LIMITS.maxSuggestionRefs) {
    return { ok: false, message: "sourceRefs must contain one to sixteen canonical document and fragment references." };
  }
  const anchors = [];
  for (const reference of sourceRefs) {
    if (!isPlainObject(reference) || Object.keys(reference).some((key) => !["documentId", "fragmentId"].includes(key))) {
      return { ok: false, message: "Every source reference must contain only documentId and fragmentId." };
    }
    if (typeof reference.documentId !== "string" || typeof reference.fragmentId !== "string") {
      return { ok: false, message: "Every source reference must contain string documentId and fragmentId values." };
    }
    const anchor = fragmentIndex.get(`${reference.documentId}\u0000${reference.fragmentId}`);
    if (!anchor) return { ok: false, message: "A suggestion cites a source fragment that is absent or lacks an exact locator." };
    anchors.push(anchor);
  }
  return { ok: true, anchors: dedupeAnchors(anchors) };
}

function anchorIdentity(anchor) {
  return `${anchor?.documentId ?? ""}\u0000${anchor?.fragmentId ?? ""}`;
}

function sourceRefsSupportField(anchors, mapping) {
  const evidence = new Set([
    ...(mapping?.sourceAnchors ?? []),
    ...(mapping?.sourceFieldAnchors ?? []),
  ].map(anchorIdentity));
  return anchors.length > 0 && anchors.every((anchor) => evidence.has(anchorIdentity(anchor)));
}

function sourceRefsSupportEntities(anchors, entities) {
  const cited = new Set(anchors.map(anchorIdentity));
  const permitted = new Set(entities.flatMap((entity) => entity.identitySources ?? []).map(anchorIdentity));
  return anchors.length > 0
    && anchors.every((anchor) => permitted.has(anchorIdentity(anchor)))
    && entities.every((entity) => (entity.identitySources ?? []).some((anchor) => cited.has(anchorIdentity(anchor))));
}

function validSuggestionId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(value);
}

function rejectSuggestion(id, code, message) {
  return { id: typeof id === "string" ? id.slice(0, 100) : null, code, message };
}

function reviewAgentSuggestions(input, { entities, mappings, fragmentIndex }) {
  const review = { received: Array.isArray(input) ? input.length : input == null ? 0 : 1, proposed: [], rejected: [] };
  if (input == null) return review;
  if (!Array.isArray(input)) {
    review.rejected.push(rejectSuggestion(null, "INVALID_SUGGESTION_SCHEMA", "Agent suggestions must be an array."));
    return review;
  }
  if (input.length > SEMANTIC_INTAKE_LIMITS.maxSuggestions) {
    review.rejected.push(rejectSuggestion(null, "AGENT_SUGGESTIONS_TOO_LARGE", "The agent suggestion count exceeds the safety limit."));
    return review;
  }
  if (boundedJsonBytes(input) > SEMANTIC_INTAKE_LIMITS.maxSuggestionBytes) {
    review.rejected.push(rejectSuggestion(null, "AGENT_SUGGESTIONS_TOO_LARGE", "The agent suggestion payload exceeds the safety limit."));
    return review;
  }
  const usedIds = new Set();
  for (const suggestion of input) {
    if (!isPlainObject(suggestion) || boundedJsonBytes(suggestion) > SEMANTIC_INTAKE_LIMITS.maxSingleSuggestionBytes) {
      review.rejected.push(rejectSuggestion(suggestion?.id, "INVALID_SUGGESTION_SCHEMA", "The suggestion is not a bounded object."));
      continue;
    }
    const allowedKeys = suggestion.kind === "entity-resolution" ? ENTITY_SUGGESTION_KEYS : FIELD_SUGGESTION_KEYS;
    if (
      !validSuggestionId(suggestion.id) ||
      usedIds.has(suggestion.id) ||
      !SUGGESTION_KINDS.has(suggestion.kind) ||
      Object.keys(suggestion).some((key) => !allowedKeys.has(key)) ||
      typeof suggestion.confidence !== "number" ||
      !Number.isFinite(suggestion.confidence) ||
      suggestion.confidence < 0 ||
      suggestion.confidence > 1
    ) {
      review.rejected.push(rejectSuggestion(suggestion.id, "INVALID_SUGGESTION_SCHEMA", "The suggestion has unknown fields, an invalid ID, kind, or confidence."));
      continue;
    }
    usedIds.add(suggestion.id);
    const refs = validateSourceRefs(suggestion.sourceRefs, fragmentIndex);
    if (!refs.ok) {
      review.rejected.push(rejectSuggestion(suggestion.id, "UNRESOLVED_SUGGESTION_ANCHOR", refs.message));
      continue;
    }
    if (suggestion.kind === "entity-resolution") {
      if (
        !Array.isArray(suggestion.aliases) ||
        suggestion.aliases.length < 2 ||
        suggestion.aliases.length > 8 ||
        suggestion.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 160)
      ) {
        review.rejected.push(rejectSuggestion(suggestion.id, "INVALID_SUGGESTION_SCHEMA", "Entity suggestions require two to eight bounded aliases."));
        continue;
      }
      const aliasKeys = [...new Set(suggestion.aliases.map(normalizedEntity))];
      const matchedEntities = entities.filter((entity) => aliasKeys.includes(entity.normalizedIdentity));
      if (matchedEntities.length < 2) {
        review.rejected.push(rejectSuggestion(suggestion.id, "SUGGESTION_ENTITY_NOT_FOUND", "The proposed aliases do not identify at least two unresolved entities."));
        continue;
      }
      if (!sourceRefsSupportEntities(refs.anchors, matchedEntities)) {
        review.rejected.push(rejectSuggestion(suggestion.id, "SUGGESTION_EVIDENCE_MISMATCH", "Entity-resolution references must cite the identity evidence for every proposed entity."));
        continue;
      }
      review.proposed.push({
        id: suggestion.id,
        kind: suggestion.kind,
        status: "proposed",
        basis: "untrusted-agent-suggestion",
        confidence: suggestion.confidence,
        aliases: suggestion.aliases.map((alias) => alias.trim()),
        entityIds: matchedEntities.map((entity) => entity.id),
        sourceAnchors: refs.anchors,
      });
      continue;
    }
    if (
      typeof suggestion.sourceField !== "string" ||
      !suggestion.sourceField.trim() ||
      suggestion.sourceField.length > 160 ||
      typeof suggestion.targetCriterion !== "string" ||
      !suggestion.targetCriterion.trim() ||
      suggestion.targetCriterion.length > 160
    ) {
      review.rejected.push(rejectSuggestion(suggestion.id, "INVALID_SUGGESTION_SCHEMA", "Field suggestions require bounded source and target labels."));
      continue;
    }
    const field = normalizedField(suggestion.sourceField);
    const current = mappings.find((mapping) =>
      mapping.normalizedField === field || mapping.sourceFields.some((source) => normalizedField(source) === field),
    );
    if (!current) {
      review.rejected.push(rejectSuggestion(suggestion.id, "SUGGESTION_SOURCE_FIELD_NOT_FOUND", "The suggested source field is not present in deterministic evidence."));
      continue;
    }
    if (!sourceRefsSupportField(refs.anchors, current)) {
      review.rejected.push(rejectSuggestion(suggestion.id, "SUGGESTION_EVIDENCE_MISMATCH", "Field-mapping references must cite evidence cells or fragments for that exact source field."));
      continue;
    }
    review.proposed.push({
      id: suggestion.id,
      kind: suggestion.kind,
      status: "proposed",
      basis: "untrusted-agent-suggestion",
      confidence: suggestion.confidence,
      sourceField: suggestion.sourceField.trim(),
      normalizedField: current.normalizedField,
      currentTargetCriterion: current.targetCriterion,
      targetCriterion: suggestion.targetCriterion.trim(),
      wouldOverride: normalizedField(suggestion.targetCriterion) !== normalizedField(current.targetCriterion),
      sourceAnchors: refs.anchors,
    });
  }
  return review;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Builds a deterministic, review-only semantic proposal from normalized import artifacts.
 * Agent suggestions are validated into a separate proposal collection and never mutate the
 * evidence-derived entities, mappings, facts, conflicts, or confidence values.
 */
export function proposeSemanticIntake({ documents: inputDocuments = [], agentSuggestions = [] } = {}) {
  const diagnostics = [];
  const unresolved = [];
  const documents = normalizeDocuments(inputDocuments, diagnostics, unresolved);
  const records = extractRecords(documents, unresolved);
  const entities = mergeEntities(records, unresolved);
  const conflicts = conflictsFor(entities);
  const mappings = mappingsFor(entities, conflicts);
  const resolutionProposals = resolutionProposalsFor(entities);
  const fragmentIndex = new Map();
  for (const document of documents) {
    for (const block of document.blocks) {
      if (block.sourceAnchor) fragmentIndex.set(`${document.id}\u0000${block.id}`, block.sourceAnchor);
    }
  }
  const agentSuggestionReview = reviewAgentSuggestions(agentSuggestions, { entities, mappings, fragmentIndex });
  const entityConfidence = average(entities.map((entity) => entity.confidence));
  const mappingConfidence = average(mappings.map((mapping) => mapping.confidence));
  const confidenceValues = [...entities.map((entity) => entity.confidence), ...mappings.map((mapping) => mapping.confidence)];
  const overallConfidence = average(confidenceValues);
  return {
    schemaVersion: "semantic-intake/v1",
    status: "review-required",
    requiresHumanReview: true,
    entities,
    mappings,
    conflicts,
    resolutionProposals,
    agentSuggestionReview,
    unresolved,
    diagnostics,
    confidence: {
      overall: overallConfidence,
      entities: entityConfidence,
      mappings: mappingConfidence,
      minimum: confidenceValues.length ? Math.min(...confidenceValues) : 0,
    },
    summary: {
      documentsReceived: Array.isArray(inputDocuments) ? inputDocuments.length : 0,
      documentsProcessed: documents.length,
      entities: entities.length,
      mappings: mappings.length,
      conflicts: conflicts.length,
      unresolved: unresolved.length,
      agentProposals: agentSuggestionReview.proposed.length,
      rejectedAgentSuggestions: agentSuggestionReview.rejected.length,
    },
  };
}
