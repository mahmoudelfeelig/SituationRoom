import { createDecisionCase } from "../kernel/model.js";
import { makeEvidenceBundle, sourceReference, defaultMapImportedDocuments } from "./shared.js";

export const CANDIDATE_REVIEW_PACK_ID = "candidate-review";

const PROHIBITED_FIELDS = Object.freeze([
  "age",
  "birthdate",
  "dateofbirth",
  "dob",
  "gender",
  "genderidentity",
  "sex",
  "sexualorientation",
  "race",
  "ethnicity",
  "religion",
  "nationality",
  "nationalorigin",
  "citizenship",
  "maritalstatus",
  "familystatus",
  "disability",
  "medicalhistory",
  "healthstatus",
  "geneticinformation",
  "photo",
  "pregnancy",
  "veteranstatus",
  "politicalopinion",
]);
export const CANDIDATE_PROHIBITED_FIELDS = PROHIBITED_FIELDS;
const PROTECTED_FIELDS = new Set(PROHIBITED_FIELDS);
const ALLOWED_JOB_FIELDS = new Set([
  "candidate",
  "candidateid",
  "applicationid",
  "requirement",
  "requirementmet",
  "requiredweb",
  "typescriptyears",
  "experienceyears",
  "yearsofexperience",
  "verifiedexperience",
  "accessibilityevidence",
  "accessibilityexperience",
  "portfolioevidence",
  "worksample",
  "worksamples",
  "technicalassessment",
  "structuredinterview",
  "interviewevidence",
  "certification",
  "certifications",
  "workauthorization",
  "availability",
]);
export const CANDIDATE_JOB_ASPECTS = Object.freeze([
  "required-experience",
  "technical-experience",
  "accessibility-evidence",
  "work-sample",
  "structured-assessment",
  "certification",
  "work-authorization",
  "availability",
]);
const CANDIDATE_CRITERION_PATTERNS = Object.freeze([
  ["required-experience", /\brequired.{0,40}(?:experience|requirement|qualification|web)|(?:experience|requirement).{0,40}required\b/i],
  ["technical-experience", /\b(?:typescript|javascript|frontend|web|technical).{0,32}(?:experience|years?|evidence|assessment)\b|\b(?:experience|years?|evidence).{0,32}(?:typescript|javascript|frontend|web|technical)\b/i],
  ["accessibility-evidence", /\baccessibility.{0,32}(?:evidence|experience|delivery|assessment)\b/i],
  ["work-sample", /\b(?:portfolio|work sample|relevant work|code sample)\b/i],
  ["structured-assessment", /\b(?:structured interview|technical assessment|interview evidence|assessment evidence)\b/i],
  ["certification", /\bcertification\b/i],
  ["work-authorization", /\bwork authorization\b/i],
  ["availability", /\bavailability\b/i],
]);
const SEPARATOR = "[\\s_.-]*";
const PROTECTED_LABEL_PATTERN = new RegExp(
  `\\b(?:age|birth${SEPARATOR}date|date${SEPARATOR}of${SEPARATOR}birth|d${SEPARATOR}o${SEPARATOR}b|gender(?:${SEPARATOR}identity)?|sex(?:ual${SEPARATOR}orientation)?|race|ethnicity|religion|nationality|national${SEPARATOR}origin|citizenship|marital${SEPARATOR}status|family${SEPARATOR}status|disability|medical${SEPARATOR}history|health${SEPARATOR}status|genetic${SEPARATOR}information|photo|pregnancy|veteran${SEPARATOR}status|political${SEPARATOR}opinion)\\s*[:=]\\s*[^;\\n,.]*`,
  "gi",
);
const PROTECTED_TERM_PATTERN = new RegExp(
  `\\b(?:age|birth${SEPARATOR}date|date${SEPARATOR}of${SEPARATOR}birth|d${SEPARATOR}o${SEPARATOR}b|gender(?:${SEPARATOR}identity)?|sex(?:ual${SEPARATOR}orientation)?|race|ethnicity|religion|nationality|national${SEPARATOR}origin|citizenship|marital${SEPARATOR}status|family${SEPARATOR}status|disability|medical${SEPARATOR}history|health${SEPARATOR}status|genetic${SEPARATOR}information|photo|pregnancy|veteran${SEPARATOR}status|political${SEPARATOR}opinion)\\b`,
  "i",
);

function normalizeFieldName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isCandidateProtectedField(value) {
  return PROTECTED_FIELDS.has(normalizeFieldName(value));
}

export function isCandidateAllowedJobField(value) {
  return ALLOWED_JOB_FIELDS.has(normalizeFieldName(value));
}

function isCandidateIdentifierField(value) {
  return ["candidate", "candidateid", "applicationid"].includes(normalizeFieldName(value));
}

export function isOpaqueCandidateIdentifier(value) {
  const text = String(value ?? "").trim();
  return /^(?:candidate|applicant|application)\s*[-#:]?\s*[a-z0-9-]{1,24}$/i.test(text) ||
    /^[a-z]{1,6}[-_:]?\d{2,}$/i.test(text) ||
    /^\d{3,}$/.test(text);
}

export function classifyCandidateCriterion(value) {
  if (typeof value !== "string") return null;
  return CANDIDATE_CRITERION_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}

function blindedCandidateIdentifier(value, position) {
  return isOpaqueCandidateIdentifier(value) ? String(value).trim() : `Candidate ${position}`;
}

export function containsCandidateProtectedText(value) {
  return typeof value === "string" && PROTECTED_TERM_PATTERN.test(value);
}

function pointerIsProtected(locator) {
  const pointer = locator?.jsonPointer;
  if (typeof pointer !== "string") return false;
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .some(isCandidateProtectedField);
}

function redactStructuredData(value, state, position = 1) {
  if (Array.isArray(value) && value.length && value.every((row) => Array.isArray(row))) {
    const protectedIndexes = new Set();
    const allowedIndexes = new Set();
    for (const [index, header] of value[0].entries()) {
      if (isCandidateProtectedField(header)) protectedIndexes.add(index);
      else if (isCandidateAllowedJobField(header)) allowedIndexes.add(index);
    }
    const candidateIndexes = new Set(value[0].map((header, index) => isCandidateIdentifierField(header) ? index : -1).filter((index) => index >= 0));
    return value.map((row, rowIndex) => row.map((cell, index) => {
      if (protectedIndexes.has(index)) {
        state.count += 1;
        return "[protected field redacted]";
      }
      if (!allowedIndexes.has(index)) {
        state.withheld = (state.withheld ?? 0) + 1;
        return "[non-job field withheld]";
      }
      if (candidateIndexes.has(index) && rowIndex > 0) {
        const blinded = blindedCandidateIdentifier(cell, rowIndex);
        if (blinded !== cell) state.blinded = (state.blinded ?? 0) + 1;
        return blinded;
      }
      return redactProtectedMetadata(cell, state);
    }));
  }
  if (Array.isArray(value)) return value.map((entry, index) => redactStructuredData(entry, state, index + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (isCandidateProtectedField(key)) {
        state.count += 1;
        result[key] = "[protected field redacted]";
      } else if (isCandidateAllowedJobField(key)) {
        if (isCandidateIdentifierField(key) && (!child || typeof child !== "object")) {
          const blinded = blindedCandidateIdentifier(child, position);
          if (blinded !== child) state.blinded = (state.blinded ?? 0) + 1;
          result[key] = blinded;
        } else {
          result[key] = child && typeof child === "object"
            ? redactStructuredData(child, state, position)
            : child;
        }
      } else {
        state.withheld = (state.withheld ?? 0) + 1;
        result[key] = "[non-job field withheld]";
      }
    }
    return result;
  }
  return value;
}

function redactProtectedMetadata(value, state, visited = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactProtectedMetadata(entry, state, visited));
    visited.delete(value);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "structuredData") {
      result[key] = redactStructuredData(child, state);
      continue;
    }
    if (isCandidateProtectedField(key)) {
      state.count += 1;
      continue;
    }
    if (key === "header" && isCandidateProtectedField(child)) {
      state.count += 1;
      continue;
    }
    if (key === "headers" && Array.isArray(child)) {
      const sanitizedHeaders = child.map((header) => {
        if (!isCandidateProtectedField(header)) return header;
        state.count += 1;
        return "[protected field redacted]";
      });
      result[key] = sanitizedHeaders;
      continue;
    }
    const sanitized = redactProtectedMetadata(child, state, visited);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  visited.delete(value);
  return result;
}

function inspectProtectedKeys(value, path, diagnostics, visited = new WeakSet()) {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isCandidateProtectedField(key)) {
      diagnostics.push({
        code: "UNREDACTED_PROTECTED_ATTRIBUTE",
        path: `${path}.${key}`,
        severity: "error",
        message: `Candidate-review state contains prohibited field '${key}'.`,
      });
    }
    inspectProtectedKeys(child, `${path}.${key}`, diagnostics, visited);
  }
}

function cellColumnKey(documentId, locator) {
  const sheet = String(locator?.sheet ?? "Sheet 1").toLocaleLowerCase();
  const column = Number.isInteger(locator?.column)
    ? String(locator.column)
    : /^([A-Z]+)\d+$/i.exec(locator?.range ?? "")?.[1]?.toUpperCase();
  return column ? `${documentId}:${sheet}:${column}` : null;
}

function protectedTabularColumns(documents) {
  const keys = new Set();
  for (const document of documents) {
    for (const block of document.blocks ?? []) {
      if (block.kind !== "cell") continue;
      const row = block.locator?.row ?? Number(/^\D+(\d+)$/i.exec(block.locator?.range ?? "")?.[1] ?? 0);
      if (isCandidateProtectedField(block.metadata?.header) || (row === 1 && isCandidateProtectedField(block.text))) {
        const key = cellColumnKey(document.id, block.locator);
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function sanitizeTableMapping(mapping, state) {
  if (!mapping || typeof mapping !== "object") return null;
  if (mapping.columns && typeof mapping.columns === "object") {
    const columns = {};
    for (const [sourceColumn, definition] of Object.entries(mapping.columns)) {
      if (
        isCandidateProtectedField(sourceColumn) ||
        isCandidateProtectedField(definition?.targetField) ||
        !isCandidateAllowedJobField(sourceColumn) ||
        !isCandidateAllowedJobField(definition?.targetField)
      ) {
        state.count += 1;
        continue;
      }
      columns[sourceColumn] = definition;
    }
    return { ...mapping, columns };
  }
  const result = {};
  for (const [sourceColumn, target] of Object.entries(mapping)) {
    const targetField = String(target).split(":")[0];
    if (
      isCandidateProtectedField(sourceColumn) ||
      isCandidateProtectedField(targetField) ||
      !isCandidateAllowedJobField(sourceColumn) ||
      !isCandidateAllowedJobField(targetField)
    ) {
      state.count += 1;
      continue;
    }
    result[sourceColumn] = target;
  }
  return result;
}

const SAFE_CANDIDATE_DOCUMENT_METADATA = new Set([
  "structuredData",
  "pageCount",
  "language",
  "meanConfidence",
  "rotationRadians",
  "tableMappingHash",
]);

function sanitizeDocumentMetadata(metadata, state) {
  const sanitized = redactProtectedMetadata(metadata, state) ?? {};
  return Object.fromEntries(
    Object.entries(sanitized).filter(([key]) => SAFE_CANDIDATE_DOCUMENT_METADATA.has(key)),
  );
}

function inspectProtectedTextField(value, path, diagnostics) {
  if (!containsCandidateProtectedText(value)) return;
  diagnostics.push({
    code: "PROTECTED_ATTRIBUTE_TEXT",
    path,
    severity: "error",
    message: "Candidate-review labels and descriptions cannot contain protected-trait language.",
  });
}

export function redactCandidateSourceDocuments(documents) {
  const protectedColumns = protectedTabularColumns(documents);
  let redacted = 0;
  let withheld = 0;
  let unstructuredWithheld = 0;
  const allowedColumns = new Set();
  const columnFields = new Map();
  for (const document of documents) {
    for (const block of document.blocks ?? []) {
      if (block.kind !== "cell") continue;
      const row = block.locator?.row ?? Number(/^\D+(\d+)$/i.exec(block.locator?.range ?? "")?.[1] ?? 0);
      if (row === 1 && isCandidateAllowedJobField(block.text)) {
        const key = cellColumnKey(document.id, block.locator);
        if (key) {
          allowedColumns.add(key);
          columnFields.set(key, block.text);
        }
      }
      if (isCandidateAllowedJobField(block.metadata?.header)) {
        const key = cellColumnKey(document.id, block.locator);
        if (key) {
          allowedColumns.add(key);
          columnFields.set(key, block.metadata.header);
        }
      }
    }
  }
  const sanitizedDocuments = documents.map((document, documentIndex) => {
    const documentState = { count: 0, withheld: 0, blinded: 0 };
    const documentMetadata = sanitizeDocumentMetadata(document.metadata, documentState);
    redacted += documentState.count;
    withheld += documentState.withheld;
    const mappingState = { count: 0 };
    const tableMapping = sanitizeTableMapping(document.metadata?.tableMapping, mappingState);
    redacted += mappingState.count;
    const blocks = (document.blocks ?? []).map((block) => {
      const metadataState = { count: 0 };
      const metadata = redactProtectedMetadata(block.metadata, metadataState) ?? {};
      redacted += metadataState.count;
      const tabularColumnProtected = protectedColumns.has(cellColumnKey(document.id, block.locator));
      const protectedBlock = pointerIsProtected(block.locator) || isCandidateProtectedField(block.metadata?.header) || tabularColumnProtected;
      if (protectedBlock) {
        redacted += 1;
        return {
          ...block,
          text: "[protected field redacted]",
          locator: pointerIsProtected(block.locator)
            ? { ...block.locator, jsonPointer: "/[protected-field]" }
            : block.locator,
          metadata: {
            protectedFieldRedacted: true,
            ...(metadata?.valueType ? { valueType: metadata.valueType } : {}),
          },
        };
      }
      const pointerField = typeof block.locator?.jsonPointer === "string"
        ? block.locator.jsonPointer.split("/").at(-1)?.replaceAll("~1", "/").replaceAll("~0", "~")
        : null;
      const pointerPosition = typeof block.locator?.jsonPointer === "string"
        ? Number(block.locator.jsonPointer.split("/").find((segment) => /^\d+$/.test(segment))) + 1
        : 1;
      const safeStructuredBlock =
        (block.kind === "cell" && allowedColumns.has(cellColumnKey(document.id, block.locator))) ||
        (pointerField && isCandidateAllowedJobField(pointerField));
      if (safeStructuredBlock) {
        const columnKey = cellColumnKey(document.id, block.locator);
        const row = block.locator?.row ?? Number(/^\D+(\d+)$/i.exec(block.locator?.range ?? "")?.[1] ?? 0);
        const candidateIdentifier =
          (columnKey && isCandidateIdentifierField(columnFields.get(columnKey))) ||
          (pointerField && isCandidateIdentifierField(pointerField));
        const text = candidateIdentifier && row !== 1
          ? blindedCandidateIdentifier(block.text, row > 1 ? row - 1 : Number.isFinite(pointerPosition) ? pointerPosition : 1)
          : block.text;
        if (text !== block.text) documentState.blinded += 1;
        return {
          ...block,
          text,
          metadata: {
            ...metadata,
            candidateJobRelatedExtract: true,
            ...(text !== block.text ? { candidateIdentifierBlinded: true } : {}),
          },
        };
      }
      withheld += 1;
      const structuralTableSummary = block.kind === "table" && (
        Number.isInteger(block.locator?.rows) || Number.isInteger(block.locator?.columns)
      );
      if (block.kind !== "cell" && !pointerField && !structuralTableSummary) unstructuredWithheld += 1;
      return {
        ...block,
        text: "[candidate source withheld pending blinded job-related extraction]",
        metadata: { candidateSourceWithheld: true },
      };
    });
    return {
      ...document,
      name: `Candidate source ${documentIndex + 1}.${String(document.format ?? "data").replace(/[^a-z0-9]+/gi, "").slice(0, 12) || "data"}`,
      metadata: tableMapping ? { ...documentMetadata, tableMapping } : documentMetadata,
      diagnostics: (document.diagnostics ?? []).map((diagnostic) => {
        const diagnosticState = { count: 0 };
        const sanitized = redactProtectedMetadata(diagnostic, diagnosticState);
        redacted += diagnosticState.count;
        return sanitized;
      }),
      blocks,
    };
  });
  return { documents: sanitizedDocuments, redactedCount: redacted, withheldCount: withheld, unstructuredWithheldCount: unstructuredWithheld };
}

function mapCandidateDocuments(documents) {
  const sanitized = redactCandidateSourceDocuments(documents);
  const mapped = defaultMapImportedDocuments(sanitized.documents);
  const redacted = sanitized.redactedCount;
  if (redacted) {
    mapped.diagnostics.push({
      code: "PROTECTED_ATTRIBUTES_REDACTED",
      severity: "warning",
      message: "Protected attributes were removed from the canonical review evidence.",
      details: { count: redacted },
    });
  }
  if (sanitized.unstructuredWithheldCount) {
    mapped.diagnostics.push({
      code: "CANDIDATE_UNSTRUCTURED_REDACTION_REQUIRED",
      severity: "error",
      message: "Unstructured candidate prose, images, and OCR text stay withheld until a person provides a blinded, allowlisted job-related extraction.",
      details: { count: sanitized.unstructuredWithheldCount, action: "provide_blinded_structured_extract" },
    });
  } else if (sanitized.withheldCount) {
    mapped.diagnostics.push({
      code: "CANDIDATE_NON_JOB_FIELDS_WITHHELD",
      severity: "warning",
      message: "Structured fields outside the narrow job-related allowlist were withheld from review and canonical evidence.",
      details: { count: sanitized.withheldCount },
    });
  }
  return mapped;
}

export function createCandidateReviewFixture() {
  const caseId = "candidate-review-demo";
  const candidates = [
    { id: "candidate-a17", label: "Candidate A17", description: "Blinded application", values: [true, 6, true, true, "strong"] },
    { id: "candidate-b04", label: "Candidate B04", description: "Blinded application", values: [true, 4, false, true, "strong"] },
    { id: "candidate-c22", label: "Candidate C22", description: "Blinded application", values: [false, 8, true, true, "moderate"] },
  ];
  const criteria = [
    { id: "required-web", label: "Required production web experience", candidateAspect: "required-experience", kind: "gate", valueType: "boolean" },
    {
      id: "typescript-years",
      label: "Verified TypeScript experience",
      candidateAspect: "technical-experience",
      kind: "score",
      valueType: "number",
      unit: "years",
      weight: 35,
      scoring: { kind: "linear", min: 0, max: 8, direction: "maximize" },
    },
    {
      id: "accessibility-evidence",
      label: "Accessibility delivery evidence",
      candidateAspect: "accessibility-evidence",
      kind: "score",
      valueType: "boolean",
      weight: 25,
      scoring: { kind: "boolean", preferred: true },
    },
    {
      id: "portfolio-evidence",
      label: "Relevant work samples",
      candidateAspect: "work-sample",
      kind: "score",
      valueType: "boolean",
      weight: 20,
      scoring: { kind: "boolean", preferred: true },
    },
    {
      id: "structured-communication",
      label: "Structured interview evidence",
      candidateAspect: "structured-assessment",
      kind: "score",
      valueType: "enum",
      weight: 20,
      scoring: { kind: "lookup", values: { weak: 0, moderate: 0.5, strong: 1 } },
    },
  ];
  const constraints = [
    {
      id: "candidate-constraint:required-web",
      criterionId: "required-web",
      operator: "eq",
      expected: true,
      severity: "mandatory",
    },
  ];
  const evidenceEntries = candidates.flatMap((candidate) =>
    criteria.map((criterion, index) => ({
      key: `${candidate.id}:${criterion.id}`,
      document: `${candidate.label} reviewed evidence`,
      text: `${criterion.label}: ${String(candidate.values[index])}. Recorded from the reviewed application packet.`,
      locator: { section: criterion.id },
    })),
  );
  const bundle = makeEvidenceBundle(caseId, evidenceEntries);
  const claims = candidates.flatMap((candidate) =>
    criteria.map((criterion, index) => ({
      id: `${caseId}:claim:${candidate.id}:${criterion.id}`,
      subjectId: candidate.id,
      criterionId: criterion.id,
      value: candidate.values[index],
      status: "accepted",
      confidence: 1,
      sourceRefs: sourceReference(bundle.refs, `${candidate.id}:${criterion.id}`),
    })),
  );
  return createDecisionCase({
    id: caseId,
    title: "Senior Frontend Engineer Evidence Review",
    subtitle: "Blinded, job-related decision support",
    domain: { packId: CANDIDATE_REVIEW_PACK_ID, packVersion: "1.0.0" },
    contract: {
      question: "What job-related evidence should the interview panel review?",
      objective: "Organize verified evidence consistently without autonomously ranking or rejecting people.",
      alternativeIds: candidates.map((entry) => entry.id),
      criterionIds: criteria.map((entry) => entry.id),
      constraintIds: constraints.map((entry) => entry.id),
      stakeholderIds: ["hiring-panel"],
      authority: {
        mode: "decision-support-only",
        humanConfirmationRequired: true,
        allowAutomatedRanking: false,
        humanOnlyActions: ["activate_contract", "accept_import"],
        prohibitedFields: PROHIBITED_FIELDS,
      },
    },
    alternatives: candidates.map(({ values: _values, ...candidate }) => candidate),
    criteria,
    constraints,
    stakeholders: [
      {
        id: "hiring-panel",
        label: "Hiring panel",
        mandate: "Review only declared, job-related evidence and record the human decision independently.",
      },
    ],
    documents: bundle.documents,
    fragments: bundle.fragments,
    claims,
    scenarios: [
      {
        id: "candidate-scenario:verified-experience",
        candidateScenarioType: "job-evidence-verification",
        label: "Additional job-related evidence verified",
        description:
          "Hypothetical review branch that records additional verified TypeScript experience without introducing protected attributes or an automated outcome.",
        claimOverrides: {
          [`${caseId}:claim:candidate-b04:typescript-years`]: 6,
        },
      },
    ],
    audit: [
      {
        id: `${caseId}:audit:seed`,
        caseId,
        revision: 1,
        at: "2026-08-28T10:00:00.000Z",
        actor: { type: "system", id: "fixture" },
        action: "Created a synthetic blinded candidate-review demonstration.",
      },
    ],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

export const candidateReviewPack = Object.freeze({
  id: CANDIDATE_REVIEW_PACK_ID,
  version: "1.0.0",
  label: "Candidate evidence review",
  description: "Blinded, job-related evidence organization with protected-field enforcement and no autonomous ranking.",
  riskClass: "high-impact-support-only",
  instrumentHints: ["blinded-evidence-lanes", "requirement-coverage", "missing-proof-docket", "panel-review"],
  createFixture: createCandidateReviewFixture,
  mapImportedDocuments: mapCandidateDocuments,
  evaluate(decisionCase, baseEvaluate) {
    const evaluation = baseEvaluate(decisionCase);
    return {
      ...evaluation,
      results: evaluation.results.map((result) => {
        const { eligible: _eligible, score: _score, ...requirementOnly } = result;
        return {
          ...requirementOnly,
          blockers: [],
          criteria: result.criteria.map((entry) => {
            const { normalizedScore: _normalizedScore, weightedScore: _weightedScore, ...criterionEvidence } = entry;
            return criterionEvidence;
          }),
        };
      }),
      ranking: null,
      recommendation: null,
      blockerCount: 0,
    };
  },
  validateCase(decisionCase) {
    const diagnostics = decisionCase.contract.authority.allowAutomatedRanking
      ? [
          {
            code: "AUTOMATED_RANKING_PROHIBITED",
            path: "$.contract.authority.allowAutomatedRanking",
            severity: "error",
            message: "Candidate-review cases cannot enable automated ranking.",
          },
        ]
      : [];
    inspectProtectedTextField(decisionCase.contract?.question, "$.contract.question", diagnostics);
    inspectProtectedTextField(decisionCase.contract?.objective, "$.contract.objective", diagnostics);
    const importedDocumentIds = new Set(decisionCase.documents.filter((document) => document.importId).map((document) => document.id));
    decisionCase.fragments.forEach((fragment, index) => {
      const explicitlyRedacted = fragment.metadata?.protectedFieldRedacted === true;
      PROTECTED_LABEL_PATTERN.lastIndex = 0;
      if ((!explicitlyRedacted && pointerIsProtected(fragment.locator)) || PROTECTED_LABEL_PATTERN.test(fragment.text)) {
        diagnostics.push({
          code: "UNREDACTED_PROTECTED_ATTRIBUTE",
          path: `$.fragments[${index}]`,
          severity: "error",
          message: "Candidate-review evidence contains an unredacted protected attribute.",
        });
      }
      if (
        importedDocumentIds.has(fragment.documentId) &&
        fragment.metadata?.candidateJobRelatedExtract !== true &&
        fragment.metadata?.protectedFieldRedacted !== true &&
        fragment.metadata?.candidateSourceWithheld !== true
      ) {
        diagnostics.push({
          code: "CANDIDATE_SOURCE_NOT_BLINDED",
          path: `$.fragments[${index}]`,
          severity: "error",
          message: "Imported candidate evidence must be a blinded, allowlisted job-related extract.",
        });
      }
    });
    inspectProtectedKeys(decisionCase.documents, "$.documents", diagnostics);
    inspectProtectedKeys(decisionCase.fragments, "$.fragments", diagnostics);
    inspectProtectedKeys(decisionCase.scenarios, "$.scenarios", diagnostics);
    decisionCase.alternatives.forEach((alternative, index) => {
      inspectProtectedTextField(alternative.label, `$.alternatives[${index}].label`, diagnostics);
      inspectProtectedTextField(alternative.description, `$.alternatives[${index}].description`, diagnostics);
      if (!isOpaqueCandidateIdentifier(alternative.label)) {
        diagnostics.push({
          code: "CANDIDATE_IDENTIFIER_NOT_BLINDED",
          path: `$.alternatives[${index}].label`,
          severity: "error",
          message: "Candidate alternatives must use opaque candidate or application identifiers, never names or demographic prose.",
        });
      }
      if (alternative.description && !/^(?:blinded|pseudonymized|opaque) (?:application|candidate|review record)$/i.test(alternative.description)) {
        diagnostics.push({
          code: "CANDIDATE_DESCRIPTION_NOT_BLINDED",
          path: `$.alternatives[${index}].description`,
          severity: "error",
          message: "Candidate descriptions are limited to a blinded record marker; narrative candidate prose belongs outside the decision model.",
        });
      }
    });
    decisionCase.criteria.forEach((criterion, index) => {
      inspectProtectedTextField(criterion.label, `$.criteria[${index}].label`, diagnostics);
      inspectProtectedTextField(criterion.description, `$.criteria[${index}].description`, diagnostics);
      const classified = classifyCandidateCriterion(`${criterion.label ?? ""} ${criterion.description ?? ""}`);
      if (!classified || criterion.candidateAspect !== classified) {
        diagnostics.push({
          code: "CANDIDATE_CRITERION_NOT_JOB_RELATED",
          path: `$.criteria[${index}]`,
          severity: "error",
          message: "Candidate criteria must be positively typed as a narrow job-related requirement, evidence, assessment, certification, authorization, or availability field.",
        });
      }
    });
    decisionCase.claims.forEach((claim, index) => {
      for (const field of ["label", "description", "summary", "note", "rationale", "value"]) {
        inspectProtectedTextField(claim[field], `$.claims[${index}].${field}`, diagnostics);
      }
      const criterion = decisionCase.criteria.find((entry) => entry.id === claim.criterionId);
      if (typeof claim.value === "string") {
        const allowed = criterion?.valueType === "enum"
          ? (criterion.allowedValues ?? Object.keys(criterion.scoring?.values ?? {}))
          : [];
        if (!allowed.includes(claim.value)) {
          diagnostics.push({
            code: "CANDIDATE_FREE_TEXT_VALUE_PROHIBITED",
            path: `$.claims[${index}].value`,
            severity: "error",
            message: "Candidate claim text must be a declared enum value; free-text candidate narratives cannot enter evaluation.",
          });
        }
      }
    });
    decisionCase.scenarios.forEach((scenario, index) => {
      inspectProtectedTextField(scenario.label, `$.scenarios[${index}].label`, diagnostics);
      inspectProtectedTextField(scenario.description, `$.scenarios[${index}].description`, diagnostics);
      if (scenario.candidateScenarioType !== "job-evidence-verification") {
        diagnostics.push({
          code: "CANDIDATE_SCENARIO_PROHIBITED",
          path: `$.scenarios[${index}]`,
          severity: "error",
          message: "Candidate scenarios are limited to predefined job-evidence verification branches.",
        });
      }
    });
    return diagnostics;
  },
  canExecute({ command }) {
    if (["approve_decision", "merge_scenario"].includes(command.type)) {
      return {
        allowed: false,
        reason: "Candidate outcomes must be recorded through an independent human-controlled process.",
      };
    }
    return { allowed: true };
  },
});
