import { sha256Hex } from "../kernel/index.js";
import {
  CANDIDATE_PROHIBITED_FIELDS,
  classifyCandidateCriterion,
  isCandidateProtectedField,
} from "../domain-packs/candidateReview.js";
import {
  HEALTH_PLAN_PROHIBITED_FIELDS,
  classifyHealthPlanCriterion,
  containsHealthPlanContext,
  containsHealthPlanProhibitedPurpose,
  isHealthPlanAlternativeLabel,
} from "../domain-packs/healthPlan.js";

const INSTRUCTION_PATTERN = /ignore (?:all|any|the|previous)|system prompt|developer message|tool call|change (?:policy|permissions)|approve (?:this|the) decision/i;
const NAME_HEADERS = /^(?:name|option|alternative|vendor|candidate|plan|provider|product|choice|title|id)$/i;
const MINIMIZE_HEADERS = /price|cost|premium|deductible|out[- ]?of[- ]?pocket|weight|latency|response time|risk|duration|distance|emission/i;
const GATE_HEADERS = /required|mandatory|must|compliant|compliance|eligible|network|formulary|residency|certified|work authorization/i;
const CURRENCY_HEADERS = /price|cost|premium|deductible|budget|fee|salary|out[- ]?of[- ]?pocket|tco/i;
export const INFERRED_CLAIM_ACCEPTANCE_CONFIDENCE = 0.8;

function slug(value, fallback = "item") {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function uniqueId(base, used) {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) candidate = `${base}-${index++}`;
  used.add(candidate);
  return candidate;
}

function columnIndex(range = "") {
  const match = /^([A-Z]+)(\d+)$/i.exec(range);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return { column: column - 1, row: Number(match[2]) - 1 };
}

function matrixColumnLabel(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function mappedColumnDefinition(mapping, header, column) {
  if (!mapping?.columns) return null;
  const entries = Object.entries(mapping.columns);
  const direct = mapping.columns[header] ?? mapping.columns[matrixColumnLabel(column)] ?? mapping.columns[String(column + 1)];
  if (direct) return direct;
  const normalizedHeader = String(header).trim().toLocaleLowerCase();
  return entries.find(([source]) => source.trim().toLocaleLowerCase() === normalizedHeader)?.[1] ?? null;
}

function recordsFromMatrix(document, matrix, sourceForCell, mapping = null) {
  if (!matrix.length) return [];
  const headerIndex = mapping ? Math.max(0, (mapping.headerRow ?? 1) - 1) : 0;
  const headers = (matrix[headerIndex] ?? []).map((value, index) => String(value || `Column ${index + 1}`).trim());
  const definitions = headers.map((header, column) => mappedColumnDefinition(mapping, header, column));
  const mappedLabelIndex = definitions.findIndex((definition) => ["identifier", "label"].includes(definition?.semanticType));
  const nameIndex = mappedLabelIndex >= 0 ? mappedLabelIndex : Math.max(0, headers.findIndex((header) => NAME_HEADERS.test(header)));
  return matrix.slice(headerIndex + 1).filter((row) => row.some((value) => String(value ?? "").trim())).map((row, rowIndex) => {
    const actualRow = headerIndex + 1 + rowIndex;
    if (!mapping?.columns) {
      return {
        label: String(row[nameIndex] ?? `Option ${rowIndex + 1}`).trim() || `Option ${rowIndex + 1}`,
        labelField: headers[nameIndex],
        values: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""])),
        sources: Object.fromEntries(headers.map((header, column) => [header, sourceForCell(actualRow, column)])),
        semanticTypes: {},
      };
    }
    const mappedEntries = definitions.flatMap((definition, column) => {
      if (!definition || ["identifier", "label", "source_ref"].includes(definition.semanticType)) return [];
      return [[definition.targetField, column, definition.semanticType]];
    });
    return {
      label: String(row[nameIndex] ?? `Option ${rowIndex + 1}`).trim() || `Option ${rowIndex + 1}`,
      labelField: headers[nameIndex],
      values: Object.fromEntries(mappedEntries.map(([targetField, column]) => [targetField, row[column] ?? ""])),
      sources: Object.fromEntries(mappedEntries.map(([targetField, column]) => [targetField, sourceForCell(actualRow, column)])),
      semanticTypes: Object.fromEntries(mappedEntries.map(([targetField, _column, semanticType]) => [targetField, semanticType])),
    };
  });
}

function recordsFromStructured(document) {
  const data = document.metadata?.structuredData;
  if (!data) return [];
  const escapePointer = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  const findRecordCollection = (value, pointer = "") => {
    if (Array.isArray(value)) {
      if (value.every((entry) => Array.isArray(entry)) || value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
        return { records: value, pointer, indexed: true };
      }
      for (const [index, child] of value.entries()) {
        const nested = findRecordCollection(child, `${pointer}/${index}`);
        if (nested) return nested;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const nested = findRecordCollection(child, `${pointer}/${escapePointer(key)}`);
        if (nested) return nested;
      }
    }
    return null;
  };
  const collection = findRecordCollection(data) ?? (
    data && typeof data === "object" && !Array.isArray(data)
      ? { records: [data], pointer: "", indexed: false }
      : null
  );
  const records = collection?.records ?? [];
  if (!Array.isArray(records) || !records.length) return [];
  if (records.every((row) => Array.isArray(row))) {
    return recordsFromMatrix(document, records, (rowIndex, columnIndexValue) =>
      document.blocks.find((block) => block.locator?.row === rowIndex + 1 && block.locator?.column === columnIndexValue + 1),
    );
  }
  if (records.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    const keys = [...new Set(records.flatMap((row) => Object.keys(row)))];
    const nameKey = keys.find((key) => NAME_HEADERS.test(key)) ?? keys[0];
    return records.map((record, index) => ({
      label: String(record[nameKey] ?? `Option ${index + 1}`),
      labelField: nameKey,
      values: Object.fromEntries(keys.map((key) => [key, record[key] ?? ""])),
      sources: Object.fromEntries(keys.map((key) => [
        key,
        document.blocks.find((block) => block.locator?.jsonPointer === `${collection.pointer}${collection.indexed ? `/${index}` : ""}/${escapePointer(key)}`),
      ])),
    }));
  }
  return [];
}

function recordsFromSpreadsheet(document) {
  const matrices = new Map();
  const sourceMaps = new Map();
  for (const block of document.blocks) {
    if (block.kind !== "cell") continue;
    const sheet = block.locator?.sheet ?? "Sheet 1";
    const coordinate = columnIndex(block.locator?.range);
    if (!coordinate) continue;
    const matrix = matrices.get(sheet) ?? [];
    matrix[coordinate.row] ??= [];
    matrix[coordinate.row][coordinate.column] = block.text;
    matrices.set(sheet, matrix);
    const sourceMap = sourceMaps.get(sheet) ?? new Map();
    sourceMap.set(`${coordinate.row}:${coordinate.column}`, block);
    sourceMaps.set(sheet, sourceMap);
  }
  return [...matrices.entries()].flatMap(([sheet, matrix]) =>
    recordsFromMatrix(
      document,
      matrix,
      (row, column) => sourceMaps.get(sheet)?.get(`${row}:${column}`),
      !document.metadata?.tableMapping?.sheetName || document.metadata.tableMapping.sheetName === sheet
        ? document.metadata?.tableMapping
        : null,
    ),
  );
}

function recordsFromText(document) {
  const values = {};
  const sources = {};
  for (const block of document.blocks) {
    if (INSTRUCTION_PATTERN.test(block.text)) continue;
    const segments = block.text.split(/[\n;]+/);
    for (const segment of segments) {
      const match = /^\s*([^:]{2,80}):\s*(.{1,240})\s*$/.exec(segment);
      if (!match) continue;
      const key = match[1].trim();
      if (NAME_HEADERS.test(key) || INSTRUCTION_PATTERN.test(key)) continue;
      values[key] = match[2].trim();
      sources[key] = block;
    }
  }
  if (!Object.keys(values).length) {
    values["Evidence supplied"] = document.blocks.some((block) => block.text.trim()) ? "yes" : "no";
    sources["Evidence supplied"] = document.blocks.find((block) => block.text.trim()) ?? document.blocks[0];
  }
  return [{
    label: document.name.replace(/\.[^.]+$/, ""),
    labelField: document.name,
    values,
    sources,
  }];
}

function recordsFromDocuments(documents) {
  const explicitlyMapped = documents
    .filter((document) => document.metadata?.tableMapping)
    .flatMap((document) => recordsFromSpreadsheet(document));
  if (explicitlyMapped.length) return explicitlyMapped;
  const structured = documents.flatMap((document) => recordsFromStructured(document));
  if (structured.length >= 2) return structured;
  const spreadsheets = documents.flatMap((document) => recordsFromSpreadsheet(document));
  if (spreadsheets.length >= 2) return spreadsheets;
  return documents.flatMap((document) => recordsFromText(document));
}

function parseValue(raw) {
  if (typeof raw === "boolean" || typeof raw === "number") return raw;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (/^(?:yes|true|pass|passed|included|covered|eligible)$/i.test(value)) return true;
  if (/^(?:no|false|fail|failed|excluded|not covered|ineligible)$/i.test(value)) return false;
  const normalized = value
    .replace(/[€$£]/g, "")
    .replace(/\s?(?:eur|usd|gbp)$/i, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/%$/, "")
    .trim();
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return value.slice(0, 500);
}

function parseMappedValue(raw, semanticType) {
  if (["text", "category", "date"].includes(semanticType)) {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    return value ? value.slice(0, 500) : null;
  }
  return parseValue(raw);
}

function valueTypeFor(values, header) {
  const known = values.filter((value) => value !== null);
  if (!known.length) return "string";
  if (known.every((value) => typeof value === "boolean")) return "boolean";
  if (known.every((value) => typeof value === "number")) return CURRENCY_HEADERS.test(header) ? "currency" : "number";
  return "string";
}

function mappedValueType(records, header) {
  const semanticType = records.find((record) => record.semanticTypes?.[header])?.semanticTypes?.[header];
  if (semanticType === "number" || semanticType === "currency" || semanticType === "boolean" || semanticType === "date") {
    return semanticType;
  }
  if (semanticType === "text" || semanticType === "category") return "string";
  return null;
}

function authorityFor(domainId) {
  if (domainId === "candidate-review") {
    return {
      mode: "decision-support-only",
      humanConfirmationRequired: true,
      allowAutomatedRanking: false,
      humanOnlyActions: ["activate_contract", "accept_import"],
      prohibitedFields: [...CANDIDATE_PROHIBITED_FIELDS],
    };
  }
  if (domainId === "health-plan") {
    return {
      mode: "consumer-decision-support",
      humanConfirmationRequired: true,
      allowAutomatedRanking: true,
      humanOnlyActions: ["activate_contract", "accept_import", "approve_decision"],
      prohibitedFields: [...HEALTH_PLAN_PROHIBITED_FIELDS],
    };
  }
  return {
    mode: "assistive",
    humanConfirmationRequired: true,
    allowAutomatedRanking: true,
    humanOnlyActions: ["activate_contract", "accept_import", "approve_decision"],
    prohibitedFields: [],
  };
}

function stakeholderFor(domainId) {
  if (domainId === "candidate-review") return { id: "human-panel", label: "Human review panel", mandate: "Apply declared job-related criteria consistently and record the final decision independently." };
  if (domainId === "health-plan") return { id: "consumer", label: "Consumer", mandate: "Verify live directories, formularies, exclusions, and enrollment terms before choosing." };
  if (domainId === "procurement") return { id: "decision-owner", label: "Decision owner", mandate: "Verify mandatory gates and commit the award independently." };
  return { id: "decision-owner", label: "Decision owner", mandate: "Confirm the criteria, evidence, and final choice." };
}

export function proposeCaseFromDocuments({ caseId, title, objective, domainId = "generic", documents }) {
  const records = recordsFromDocuments(documents).slice(0, 250);
  const usedAlternativeIds = new Set();
  const alternatives = records.map((record, index) => {
    const label = record.label.slice(0, 200);
    const planIdentifiedByLabel = domainId === "health-plan" && isHealthPlanAlternativeLabel(label);
    const planIdentifiedBySource = domainId === "health-plan" && isHealthPlanAlternativeLabel(record.labelField);
    return {
      id: uniqueId(`alternative:${slug(record.label, `option-${index + 1}`)}`, usedAlternativeIds),
      label,
      description: domainId === "health-plan"
        ? "Imported insurance-plan alternative awaiting human-confirmed interpretation"
        : domainId === "candidate-review"
          ? "Blinded application"
          : "Imported alternative awaiting human-confirmed interpretation",
      ...(domainId === "health-plan" ? {
        entityType: planIdentifiedByLabel || planIdentifiedBySource ? "insurance-plan" : "unclassified",
        planIdentityEvidence: planIdentifiedByLabel ? "label" : planIdentifiedBySource ? "source-field" : "unverified",
        ...(planIdentifiedBySource ? { planIdentitySource: String(record.labelField).slice(0, 120) } : {}),
      } : {}),
    };
  });
  const headers = [...new Set(records.flatMap((record) => Object.keys(record.values)))].filter(
    (header) =>
      !NAME_HEADERS.test(header) &&
      !INSTRUCTION_PATTERN.test(header) &&
      !/^\[protected field redacted\]$/i.test(header) &&
      (domainId !== "candidate-review" || (
        !isCandidateProtectedField(header) && Boolean(classifyCandidateCriterion(header))
      )) &&
      (domainId !== "health-plan" || (
        !HEALTH_PLAN_PROHIBITED_FIELDS.some((field) => field.toLowerCase() === header.replace(/[^a-z0-9]/gi, "").toLowerCase()) &&
        !containsHealthPlanProhibitedPurpose(header) &&
        Boolean(classifyHealthPlanCriterion(header))
      )),
  ).slice(0, 40);
  const parsedByHeader = new Map(headers.map((header) => [
    header,
    records.map((record) => parseMappedValue(record.values[header], record.semanticTypes?.[header])),
  ]));
  const scoringHeaders = headers.filter((header) =>
    ["boolean", "number", "currency"].includes(
      mappedValueType(records, header) ?? valueTypeFor(parsedByHeader.get(header), header),
    ),
  );
  const weight = scoringHeaders.length ? Math.round((100 / scoringHeaders.length) * 100) / 100 : 0;
  const usedCriterionIds = new Set();
  const criteria = headers.map((header) => {
    const values = parsedByHeader.get(header);
    const valueType = mappedValueType(records, header) ?? valueTypeFor(values, header);
    const gate = valueType === "boolean" && GATE_HEADERS.test(header);
    const numeric = valueType === "number" || valueType === "currency";
    const numbers = values.filter((value) => typeof value === "number");
    const minimum = numbers.length ? Math.min(...numbers) : 0;
    const maximum = numbers.length ? Math.max(...numbers) : 1;
    const padding = minimum === maximum ? Math.max(1, Math.abs(minimum) * 0.1) : 0;
    return {
      id: uniqueId(`criterion:${slug(header)}`, usedCriterionIds),
      label: header.slice(0, 200),
      description: "Inferred from imported field labels; confirm before relying on it.",
      kind: gate ? "gate" : valueType === "string" ? "informational" : "score",
      valueType,
      ...(domainId === "candidate-review" ? { candidateAspect: classifyCandidateCriterion(header) } : {}),
      ...(domainId === "health-plan" ? { planAspect: classifyHealthPlanCriterion(header) } : {}),
      ...(valueType === "currency" ? { unit: "currency" } : {}),
      ...(!gate && valueType !== "string" ? { weight } : {}),
      ...(numeric ? {
        scoring: {
          kind: "linear",
          min: minimum - padding,
          max: maximum + padding,
          direction: MINIMIZE_HEADERS.test(header) ? "minimize" : "maximize",
        },
      } : {}),
      ...(!gate && valueType === "boolean" ? { scoring: { kind: "boolean", preferred: true } } : {}),
    };
  });
  const constraints = criteria.filter((criterion) => criterion.kind === "gate").map((criterion) => ({
    id: `constraint:${criterion.id.slice("criterion:".length)}`,
    label: criterion.label,
    criterionId: criterion.id,
    operator: "eq",
    expected: true,
    severity: "mandatory",
  }));
  const criterionByLabel = new Map(criteria.map((criterion) => [criterion.label, criterion]));
  const claims = [];
  records.forEach((record, recordIndex) => {
    headers.forEach((header) => {
      const value = parsedByHeader.get(header)[recordIndex];
      if (value === null) return;
      const criterion = criterionByLabel.get(header);
      const source = record.sources[header];
      if (!source?.id || !source?.documentId) return;
      const confidence = Number.isFinite(source.confidence) ? source.confidence : 0.9;
      claims.push({
        id: `claim:${alternatives[recordIndex].id.slice("alternative:".length)}:${criterion.id.slice("criterion:".length)}`,
        subjectId: alternatives[recordIndex].id,
        criterionId: criterion.id,
        value,
        status: confidence >= INFERRED_CLAIM_ACCEPTANCE_CONFIDENCE ? "accepted" : "proposed",
        confidence,
        origin: "inferred_import",
        sourceRefs: [{
          documentId: source.documentId,
          fragmentId: source.id,
          locator: source.locator,
          quoteHash: `sha256:${sha256Hex(source.text ?? String(record.values[header]))}`,
        }],
      });
    });
  });
  const stakeholder = stakeholderFor(domainId);
  const requestedObjective = objective.trim();
  const healthQuestion = containsHealthPlanContext(requestedObjective)
    ? requestedObjective
    : `Which health insurance plan best fits the reviewed coverage and cost terms${requestedObjective ? ` for this stated goal: ${requestedObjective}` : ""}?`;
  const healthObjective = containsHealthPlanContext(requestedObjective)
    ? requestedObjective
    : `Compare health insurance plan coverage, benefits, networks, formularies, and transparent cost scenarios${requestedObjective ? ` while preserving this stated goal: ${requestedObjective}` : ""}.`;
  const warnings = [];
  if (!alternatives.length) warnings.push("No alternatives could be inferred. Add alternatives before accepting the contract.");
  if (!criteria.length) warnings.push("No typed criteria could be inferred. The documents can still be accepted as source material.");
  if (criteria.some((criterion) => criterion.kind === "informational")) warnings.push("Text fields remain informational until the decision owner defines an explicit rule.");
  const proposedClaims = claims.filter((claim) => claim.status === "proposed").length;
  if (proposedClaims) warnings.push(`${proposedClaims} low-confidence extracted value${proposedClaims === 1 ? " is" : "s are"} staged as proposed evidence. Proposed values remain unknown to scoring and gates until a person verifies or rejects them in the model editor.`);

  return {
    caseInput: {
      id: caseId,
      title: title.trim() || "Imported decision",
      subtitle: `${documents.length} imported source${documents.length === 1 ? "" : "s"} · contract awaiting confirmation`,
      domain: { packId: domainId, packVersion: "1.0.0" },
      currency: headers.some((header) => CURRENCY_HEADERS.test(header)) ? "EUR" : null,
      owner: ACTOR_ID,
      contract: {
        status: "draft",
        question: domainId === "health-plan"
          ? healthQuestion
          : requestedObjective || "Which alternative best satisfies the confirmed constraints and objectives?",
        objective: domainId === "health-plan"
          ? healthObjective
          : requestedObjective || "Compare imported alternatives using explicit, reviewed evidence.",
        alternativeIds: alternatives.map((alternative) => alternative.id),
        criterionIds: criteria.map((criterion) => criterion.id),
        constraintIds: constraints.map((constraint) => constraint.id),
        stakeholderIds: [stakeholder.id],
        authority: authorityFor(domainId),
      },
      alternatives,
      criteria,
      constraints,
      stakeholders: [stakeholder],
      documents: [],
      fragments: [],
      claims: [],
      audit: [],
    },
    claims,
    summary: {
      alternatives: alternatives.length,
      criteria: criteria.length,
      constraints: constraints.length,
      claims: claims.length,
      documents: documents.length,
    },
    warnings,
  };
}

const ACTOR_ID = "Local decision owner";
