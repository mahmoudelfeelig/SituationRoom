import { createDecisionCase } from "../kernel/model.js";
import { sha256Hex } from "../kernel/canonicalize.js";
import { makeEvidenceBundle, sourceReference, defaultMapImportedDocuments } from "./shared.js";

export const HEALTH_PLAN_PACK_ID = "health-plan";
export const HEALTH_PLAN_PROHIBITED_FIELDS = Object.freeze([
  "geneticRisk",
  "predictedDiagnosis",
  "insurerRiskScore",
  "medicalHistory",
  "healthStatus",
]);

const HEALTH_SOURCE_REDACTION = "[health-sensitive field redacted]";
const HEALTH_SOURCE_WITHHELD = "[personal clinical source withheld pending plan-term-only extraction]";
const HEALTH_SOURCE_SENSITIVE_FIELDS = new Set([
  ...HEALTH_PLAN_PROHIBITED_FIELDS,
  "age",
  "birthdate",
  "dateofbirth",
  "dob",
  "sex",
  "gender",
  "genderidentity",
  "patient",
  "patientid",
  "patientname",
  "memberid",
  "membername",
  "subscriberid",
  "subscribername",
  "personname",
  "fullname",
  "firstname",
  "lastname",
  "socialsecuritynumber",
  "ssn",
  "nationalid",
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "streetaddress",
  "homeaddress",
  "diagnosis",
  "diagnoses",
  "diagnosishistory",
  "patientdiagnosis",
  "medicalcondition",
  "medicalconditions",
  "healthcondition",
  "healthconditions",
  "symptom",
  "symptoms",
  "pregnancy",
  "disability",
  "currentmedication",
  "currentmedications",
  "medicationhistory",
  "prescriptionhistory",
  "currenttreatment",
  "treatmenthistory",
  "labresult",
  "labresults",
  "bloodpressure",
  "bloodglucose",
  "hba1c",
  "a1c",
  "claimhistory",
  "personalclaimhistory",
].map((field) => String(field).toLowerCase().replace(/[^a-z0-9]/g, "")));
const PERSONAL_CLINICAL_ASSIGNMENT_PATTERN = new RegExp(
  "\\b(?:patient[\\s_.-]*(?:name|id)|member[\\s_.-]*(?:name|id)|subscriber[\\s_.-]*(?:name|id)|date[\\s_.-]*of[\\s_.-]*birth|birth[\\s_.-]*date|d[\\s_.-]*o[\\s_.-]*b|medical[\\s_.-]*(?:history|condition)|health[\\s_.-]*(?:status|condition)|diagnos(?:is|es)|current[\\s_.-]*medications?|medication[\\s_.-]*history|treatment[\\s_.-]*history|genetic[\\s_.-]*risk|predicted[\\s_.-]*diagnosis|insurer[\\s_.-]*risk[\\s_.-]*score|lab[\\s_.-]*results?|blood[\\s_.-]*(?:pressure|glucose)|hba?1c|pregnancy|disability)\\s*[:=]\\s*\\S",
  "i",
);
const PERSONAL_CLINICAL_PROSE_PATTERN = /\b(?:i|the patient|patient|the subscriber|subscriber)\s+(?:(?:am|is|was)\s+diagnosed|(?:have|has|had)\s+(?:a\s+|an\s+)?(?:medical history|diagnosis|condition|disease|disability)|(?:take|takes|taking|use|uses)\s+(?:a\s+)?(?:medication|prescription drug|insulin))\b/i;
const PERSONAL_CLINICAL_DOCUMENT_PATTERN = /\b(?:(?:personal|patient)[\s_.-]*(?:medical|health|clinical)?[\s_.-]*(?:record|history|profile|chart)|(?:medical|clinical)[\s_.-]*(?:record|history|profile|chart)|lab[\s_.-]*(?:result|report)|discharge[\s_.-]*summary)\b/i;

const PROHIBITED_PURPOSE_PATTERN = /(?:\bdiagnos(?:e|is|tic)\b|\bunderwrit(?:e|ing)\b|\badjudicat(?:e|ion)\b|\b(?:deny|denial|reject)\b.{0,40}\b(?:claim|coverage|enrollment)\b|\b(?:set|calculate|personalize|determine)\b.{0,40}\b(?:premium|insurer[\s._-]*risk|risk[\s._-]*score)\b|\b(?:genetic[\s._-]*risk|predicted[\s._-]*diagnosis|insurer[\s._-]*risk[\s._-]*score|medical[\s._-]*history|health[\s._-]*status)\b|\b(?:start|stop|change|choose|select|recommend)\b.{0,40}\b(?:treatment|therapy|medication|drug|surgery|chemotherapy)\b|\b(?:treatment|therapy|medication|drug|surgery|chemotherapy)\b.{0,24}\b(?:selection|recommendation|choice)\b)/i;
const CLINICAL_ALTERNATIVE_PATTERN = /\b(?:chemotherapy|radiation(?:\s+therapy)?|surgery|treatment|therapy|medication|prescription|drug|dosage|dose|procedure)\b/i;
const PLAN_CONTEXT_PATTERN = /\b(?:health[ -]?plan|plan|insurance|coverage|policy|benefit|premium|deductible|out[- ]?of[- ]?pocket|provider[ -]?network|formulary|hmo|ppo|epo|pos|hdhp)\b/i;
const PLAN_ALTERNATIVE_PATTERN = /\b(?:plan|insurance|coverage|policy|benefit package|hmo|ppo|epo|pos|hdhp|catastrophic)\b/i;
const CLINICAL_OUTCOME_PATTERN = /\b(?:hba1c|a1c|blood glucose|blood sugar|blood pressure|biomarker|lab(?:oratory)? value|clinical outcome|efficacy|therapeutic effect|treatment response|remission|survival|mortality|symptom reduction|pain reduction|tumou?r response|disease progression|weight loss)\b/i;

export const HEALTH_PLAN_TYPES = Object.freeze(["HMO", "PPO", "EPO", "POS", "HDHP", "indemnity", "other"]);

export const HEALTH_PLAN_CRITERION_ASPECTS = Object.freeze([
  "premium",
  "deductible",
  "cost-sharing",
  "provider-network",
  "formulary-coverage",
  "benefits-coverage",
  "utilization-cost",
  "plan-quality",
  "enrollment-terms",
  "member-service",
]);

const CRITERION_ASPECT_PATTERNS = Object.freeze([
  ["premium", /\bpremium\b/i],
  ["deductible", /\bdeductible\b/i],
  ["cost-sharing", /\b(?:out[- ]?of[- ]?pocket|co[- ]?pay|copay|co[- ]?insurance|coinsurance|cost[- ]?sharing)\b/i],
  ["provider-network", /\b(?:provider|doctor|hospital|facility|network|in[- ]?network|out[- ]?of[- ]?network)\b/i],
  ["formulary-coverage", /\b(?:formulary|prescription coverage|drug coverage|medicine(?:s)? covered|medication coverage)\b/i],
  ["utilization-cost", /\b(?:(?:estimated|annual|total|scenario|utilization).{0,24}cost|cost.{0,24}(?:estimate|scenario|utilization|annual|total))\b/i],
  ["enrollment-terms", /\b(?:enrollment|eligibility period|waiting period|effective date|renewal|termination terms)\b/i],
  ["member-service", /\b(?:member service|customer service|support|appeal process|digital service)\b/i],
  ["plan-quality", /\b(?:plan quality|quality rating|member rating|accreditation)\b/i],
  ["benefits-coverage", /\b(?:benefit|coverage|covered service|exclusion|visit limit|service limit|rehabilitation|mental health coverage|maternity coverage|dental coverage|vision coverage)\b/i],
]);

export function containsHealthPlanProhibitedPurpose(value) {
  return typeof value === "string" && PROHIBITED_PURPOSE_PATTERN.test(value);
}

export function containsHealthPlanContext(value) {
  return typeof value === "string" && PLAN_CONTEXT_PATTERN.test(value);
}

export function isHealthPlanAlternativeLabel(value) {
  return typeof value === "string" && PLAN_ALTERNATIVE_PATTERN.test(value);
}

export function classifyHealthPlanCriterion(value) {
  if (typeof value !== "string") return null;
  return CRITERION_ASPECT_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}

function normalizeHealthSourceField(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isHealthSourceSensitiveField(value) {
  return HEALTH_SOURCE_SENSITIVE_FIELDS.has(normalizeHealthSourceField(value));
}

function healthPointerSegments(locator) {
  if (typeof locator?.jsonPointer === "string") {
    return locator.jsonPointer
      .split("/")
      .slice(1)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  if (typeof locator?.xpath === "string") {
    return locator.xpath.split("/").filter(Boolean).map((segment) => segment.replace(/\[.*$/, ""));
  }
  return [];
}

function healthPointerIsSensitive(locator) {
  return healthPointerSegments(locator).some(isHealthSourceSensitiveField);
}

function healthCellColumnKey(documentId, locator) {
  const sheet = String(locator?.sheet ?? "Sheet 1").toLocaleLowerCase();
  const column = Number.isInteger(locator?.column)
    ? String(locator.column)
    : /^([A-Z]+)\d+$/i.exec(locator?.range ?? "")?.[1]?.toUpperCase();
  return column ? `${documentId}:${sheet}:${column}` : null;
}

function healthSensitiveTabularColumns(documents) {
  const columns = new Set();
  for (const document of documents) {
    const mapping = document.metadata?.tableMapping;
    const mappedColumns = mapping?.columns && typeof mapping.columns === "object"
      ? mapping.columns
      : null;
    const mappedHeaderRow = Number.isInteger(mapping?.headerRow) ? mapping.headerRow : 1;
    const mappedSheet = mapping?.sheetName ? String(mapping.sheetName).toLocaleLowerCase() : null;
    for (const block of document.blocks ?? []) {
      if (block.kind !== "cell") continue;
      const row = block.locator?.row ?? Number(/^\D+(\d+)$/i.exec(block.locator?.range ?? "")?.[1] ?? 0);
      const blockSheet = String(block.locator?.sheet ?? "Sheet 1").toLocaleLowerCase();
      const mappedDefinition = row === mappedHeaderRow && (!mappedSheet || mappedSheet === blockSheet)
        ? mappedColumns?.[block.text]
        : null;
      if (
        isHealthSourceSensitiveField(block.metadata?.header) ||
        (row === 1 && isHealthSourceSensitiveField(block.text)) ||
        (mappedDefinition && (
          isHealthSourceSensitiveField(block.text) || isHealthSourceSensitiveField(mappedDefinition.targetField)
        ))
      ) {
        const key = healthCellColumnKey(document.id, block.locator);
        if (key) columns.add(key);
      }
    }
  }
  return columns;
}

function redactHealthStructuredData(value, state) {
  if (Array.isArray(value) && value.length && value.every((row) => Array.isArray(row))) {
    const sensitiveIndexes = new Set();
    value[0].forEach((header, index) => {
      if (isHealthSourceSensitiveField(header)) sensitiveIndexes.add(index);
    });
    return value.map((row) => row.map((cell, index) => {
      if (sensitiveIndexes.has(index)) {
        state.count += 1;
        return HEALTH_SOURCE_REDACTION;
      }
      return redactHealthStructuredData(cell, state);
    }));
  }
  if (Array.isArray(value)) return value.map((entry) => redactHealthStructuredData(entry, state));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isHealthSourceSensitiveField(key)) {
      state.count += 1;
      result[key] = HEALTH_SOURCE_REDACTION;
    } else {
      result[key] = redactHealthStructuredData(child, state);
    }
  }
  return result;
}

function redactHealthMetadata(value, state, visited = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactHealthMetadata(entry, state, visited));
    visited.delete(value);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "structuredData") {
      result[key] = redactHealthStructuredData(child, state);
      continue;
    }
    if (isHealthSourceSensitiveField(key)) {
      state.count += 1;
      continue;
    }
    if (key === "header" && isHealthSourceSensitiveField(child)) {
      state.count += 1;
      result[key] = HEALTH_SOURCE_REDACTION;
      continue;
    }
    if (key === "headers" && Array.isArray(child)) {
      result[key] = child.map((header) => {
        if (!isHealthSourceSensitiveField(header)) return header;
        state.count += 1;
        return HEALTH_SOURCE_REDACTION;
      });
      continue;
    }
    const sanitized = redactHealthMetadata(child, state, visited);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  visited.delete(value);
  return result;
}

function sanitizeHealthTableMapping(mapping, state) {
  if (!mapping || typeof mapping !== "object") return null;
  if (mapping.columns && typeof mapping.columns === "object") {
    const columns = {};
    for (const [sourceColumn, definition] of Object.entries(mapping.columns)) {
      if (isHealthSourceSensitiveField(sourceColumn) || isHealthSourceSensitiveField(definition?.targetField)) {
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
    if (isHealthSourceSensitiveField(sourceColumn) || isHealthSourceSensitiveField(targetField)) {
      state.count += 1;
      continue;
    }
    result[sourceColumn] = target;
  }
  return result;
}

function containsPersonalClinicalSourceText(value) {
  return typeof value === "string" && (
    PERSONAL_CLINICAL_ASSIGNMENT_PATTERN.test(value) || PERSONAL_CLINICAL_PROSE_PATTERN.test(value)
  );
}

function redactedHealthLocator(locator) {
  if (typeof locator?.jsonPointer === "string") return { ...locator, jsonPointer: "/[health-sensitive-field]" };
  if (typeof locator?.xpath === "string") return { ...locator, xpath: "/[health-sensitive-field]" };
  return locator;
}

export function redactHealthPlanSourceDocuments(documents) {
  const sensitiveColumns = healthSensitiveTabularColumns(documents);
  let redactedCount = 0;
  let unstructuredWithheldCount = 0;
  const sanitizedDocuments = documents.map((document, documentIndex) => {
    const documentState = { count: 0 };
    const sensitiveDocumentName = PERSONAL_CLINICAL_DOCUMENT_PATTERN.test(String(document.name ?? ""));
    const sanitizedMetadata = redactHealthMetadata(document.metadata, documentState) ?? {};
    const mappingState = { count: 0 };
    const tableMapping = sanitizeHealthTableMapping(document.metadata?.tableMapping, mappingState);
    documentState.count += mappingState.count;
    const blocks = (document.blocks ?? []).map((block) => {
      const metadataState = { count: 0 };
      const metadata = redactHealthMetadata(block.metadata, metadataState) ?? {};
      documentState.count += metadataState.count;
      const structured = block.kind === "cell" || healthPointerSegments(block.locator).length > 0;
      const sensitiveStructuredBlock =
        healthPointerIsSensitive(block.locator) ||
        isHealthSourceSensitiveField(block.metadata?.header) ||
        sensitiveColumns.has(healthCellColumnKey(document.id, block.locator));
      if (sensitiveStructuredBlock) {
        documentState.count += 1;
        return {
          ...block,
          text: HEALTH_SOURCE_REDACTION,
          locator: redactedHealthLocator(block.locator),
          metadata: {
            protectedFieldRedacted: true,
            healthSensitiveFieldRedacted: true,
            ...(metadata?.valueType ? { valueType: metadata.valueType } : {}),
          },
        };
      }
      if (!structured && (sensitiveDocumentName || containsPersonalClinicalSourceText(block.text))) {
        unstructuredWithheldCount += 1;
        return {
          ...block,
          text: HEALTH_SOURCE_WITHHELD,
          metadata: { healthSourceWithheld: true },
        };
      }
      return { ...block, metadata };
    });
    redactedCount += documentState.count;
    const containsSensitiveMaterial = sensitiveDocumentName || documentState.count > 0 || blocks.some((block) => block.metadata?.healthSourceWithheld);
    return {
      ...document,
      name: containsSensitiveMaterial
        ? `Health source ${documentIndex + 1}.${String(document.format ?? "data").replace(/[^a-z0-9]+/gi, "").slice(0, 12) || "data"}`
        : document.name,
      metadata: tableMapping ? { ...sanitizedMetadata, tableMapping } : sanitizedMetadata,
      diagnostics: containsSensitiveMaterial
        ? (document.diagnostics ?? []).map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: "Health-source diagnostic retained without personal or clinical source content.",
          }))
        : (document.diagnostics ?? []).map((diagnostic) => redactHealthMetadata(diagnostic, { count: 0 }) ?? {}),
      blocks,
    };
  });
  return { documents: sanitizedDocuments, redactedCount, unstructuredWithheldCount };
}

function mapHealthPlanDocuments(documents) {
  const sanitized = redactHealthPlanSourceDocuments(documents);
  const mapped = defaultMapImportedDocuments(sanitized.documents);
  if (sanitized.redactedCount) {
    mapped.diagnostics.push({
      code: "HEALTH_SENSITIVE_SOURCE_FIELDS_REDACTED",
      severity: "warning",
      message: "Personal, demographic, and clinical fields were removed before health-plan evidence could become canonical.",
      details: { count: sanitized.redactedCount },
    });
  }
  if (sanitized.unstructuredWithheldCount) {
    mapped.diagnostics.push({
      code: "HEALTH_UNSTRUCTURED_PERSONAL_SOURCE_REQUIRES_EXTRACTION",
      severity: "error",
      message: "Unstructured personal or clinical material stays withheld until a person supplies a plan-term-only extract.",
      details: {
        count: sanitized.unstructuredWithheldCount,
        action: "provide_plan_term_only_extract",
      },
    });
  }
  return mapped;
}

function validateHealthPurpose(decisionCase) {
  const diagnostics = [];
  const inspect = (value, path) => {
    if (containsHealthPlanProhibitedPurpose(value)) {
      diagnostics.push({
        code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
        path,
        severity: "error",
        message: "Health-plan mode may compare declared plan terms and cost scenarios, but cannot diagnose, choose treatment, underwrite, price a person, or adjudicate coverage or claims.",
      });
    }
    if (typeof value === "string" && CLINICAL_OUTCOME_PATTERN.test(value)) {
      diagnostics.push({
        code: "CLINICAL_OUTCOME_CRITERION_PROHIBITED",
        path,
        severity: "error",
        message: "Health-plan mode can compare coverage for care, but cannot optimize clinical efficacy, biomarkers, symptoms, survival, or treatment outcomes.",
      });
    }
  };
  inspect(decisionCase.contract?.question, "$.contract.question");
  inspect(decisionCase.contract?.objective, "$.contract.objective");
  for (const [field, value] of [["question", decisionCase.contract?.question], ["objective", decisionCase.contract?.objective]]) {
    if (!containsHealthPlanContext(value)) {
      diagnostics.push({
        code: "HEALTH_PLAN_CONTEXT_REQUIRED",
        path: `$.contract.${field}`,
        severity: "error",
        message: "Health-plan mode requires an explicit insurance-plan, coverage, benefit, network, formulary, or cost-comparison purpose.",
      });
    }
  }
  for (const [collection, fields] of [
    ["alternatives", ["label", "description"]],
    ["criteria", ["label", "description"]],
    ["constraints", ["label", "description"]],
    ["claims", ["label", "description", "summary", "note", "rationale", "value"]],
    ["scenarios", ["label", "description"]],
  ]) {
    decisionCase[collection]?.forEach((entry, index) => fields.forEach((field) => inspect(entry?.[field], `$.${collection}[${index}].${field}`)));
  }
  decisionCase.alternatives?.forEach((alternative, index) => {
    if (CLINICAL_ALTERNATIVE_PATTERN.test(alternative.label ?? "") && !PLAN_ALTERNATIVE_PATTERN.test(alternative.label ?? "")) {
      diagnostics.push({
        code: "CLINICAL_ALTERNATIVE_PROHIBITED",
        path: `$.alternatives[${index}].label`,
        severity: "error",
        message: "Health-plan alternatives must be coverage plans, not treatments, procedures, or medication regimens.",
      });
    }
    const identity = alternative.planIdentity;
    const identityRef = identity?.sourceRefs?.[0];
    const identityFragment = identityRef
      ? decisionCase.fragments?.find((fragment) => fragment.id === identityRef.fragmentId && fragment.documentId === identityRef.documentId)
      : null;
    const identityText = String(identityFragment?.text ?? "").toLocaleLowerCase();
    const issuer = String(identity?.issuer ?? "").trim();
    const planId = String(identity?.planId ?? "").trim();
    const label = String(alternative.label ?? "");
    const identityComplete =
      alternative.entityType === "insurance-plan" &&
      issuer.length >= 2 &&
      /^[a-z0-9][a-z0-9._:/-]{2,79}$/i.test(planId) &&
      HEALTH_PLAN_TYPES.includes(identity?.planType) &&
      identityFragment &&
      identityRef.quoteHash === `sha256:${sha256Hex(identityFragment.text)}` &&
      identityText.includes(issuer.toLocaleLowerCase()) &&
      identityText.includes(planId.toLocaleLowerCase()) &&
      containsHealthPlanContext(identityFragment.text) &&
      (label.toLocaleLowerCase().includes(issuer.toLocaleLowerCase()) || label.toLocaleLowerCase().includes(planId.toLocaleLowerCase()));
    if (!identityComplete) {
      diagnostics.push({
        code: decisionCase.contract?.status === "draft" ? "INSURANCE_PLAN_IDENTITY_UNVERIFIED" : "INSURANCE_PLAN_IDENTITY_REQUIRED",
        path: `$.alternatives[${index}]`,
        severity: decisionCase.contract?.status === "draft" ? "warning" : "error",
        message: "Each active health alternative needs an insurer, policy or plan ID, plan type, matching display label, and exact corroborating source anchor.",
      });
    }
  });
  decisionCase.criteria?.forEach((criterion, index) => {
    const classifiedAspect = classifyHealthPlanCriterion(`${criterion.label ?? ""} ${criterion.description ?? ""}`);
    if (!classifiedAspect || criterion.planAspect !== classifiedAspect) {
      diagnostics.push({
        code: "HEALTH_PLAN_CRITERION_SCOPE_INVALID",
        path: `$.criteria[${index}]`,
        severity: "error",
        message: "Health-plan criteria must be positively typed as plan cost, cost sharing, network, formulary, benefits, utilization, quality, enrollment, or member-service terms.",
      });
    }
  });
  return diagnostics;
}

export function createHealthPlanFixture() {
  const caseId = "health-plan-demo";
  const plans = [
    { id: "plan-harbor", label: "Harbor Silver Plan", entityType: "insurance-plan", issuer: "Harbor", planId: "HARBOR-SILVER-2027", planType: "PPO", values: [410, 1800, 7200, true, true, 6040] },
    { id: "plan-meadow", label: "Meadow Gold Plan", entityType: "insurance-plan", issuer: "Meadow", planId: "MEADOW-GOLD-2027", planType: "HMO", values: [545, 750, 4800, true, true, 7040] },
    { id: "plan-river", label: "River Bronze Plan", entityType: "insurance-plan", issuer: "River", planId: "RIVER-BRONZE-2027", planType: "HDHP", values: [325, 3200, 9100, false, true, 6550] },
  ];
  const criteria = [
    {
      id: "monthly-premium",
      label: "Monthly premium",
      kind: "score",
      valueType: "currency",
      planAspect: "premium",
      unit: "EUR/month",
      weight: 15,
      scoring: { kind: "linear", min: 300, max: 600, direction: "minimize" },
    },
    {
      id: "deductible",
      label: "Annual deductible",
      kind: "score",
      valueType: "currency",
      planAspect: "deductible",
      unit: "EUR/year",
      weight: 15,
      scoring: { kind: "linear", min: 500, max: 3500, direction: "minimize" },
    },
    {
      id: "oop-maximum",
      label: "Out-of-pocket maximum",
      kind: "score",
      valueType: "currency",
      planAspect: "cost-sharing",
      unit: "EUR/year",
      weight: 20,
      scoring: { kind: "linear", min: 4000, max: 10000, direction: "minimize" },
    },
    { id: "provider-network", label: "Preferred providers in network", kind: "gate", valueType: "boolean", planAspect: "provider-network" },
    { id: "formulary", label: "Required medicines covered", kind: "gate", valueType: "boolean", planAspect: "formulary-coverage" },
    {
      id: "estimated-annual-cost",
      label: "Estimated annual cost for the stated utilization scenario",
      kind: "score",
      valueType: "currency",
      planAspect: "utilization-cost",
      unit: "EUR/year",
      weight: 50,
      scoring: { kind: "linear", min: 4500, max: 8500, direction: "minimize" },
    },
  ];
  const constraints = [
    {
      id: "health-constraint:network",
      criterionId: "provider-network",
      operator: "eq",
      expected: true,
      severity: "mandatory",
    },
    {
      id: "health-constraint:formulary",
      criterionId: "formulary",
      operator: "eq",
      expected: true,
      severity: "mandatory",
    },
  ];
  const entries = plans.flatMap((plan) => [
    {
      key: `${plan.id}:identity`,
      document: `${plan.label} synthetic summary of benefits`,
      text: `Insurance plan identity — issuer: ${plan.issuer}; plan ID: ${plan.planId}; plan type: ${plan.planType}.`,
      locator: { section: "plan-identity" },
    },
    ...criteria.map((criterion, index) => ({
      key: `${plan.id}:${criterion.id}`,
      document: `${plan.label} synthetic summary of benefits`,
      text: `${criterion.label}: ${String(plan.values[index])}. Verify against the live insurer directory before enrollment.`,
      locator: { section: criterion.id },
    })),
  ],
  );
  const bundle = makeEvidenceBundle(caseId, entries);
  const claims = plans.flatMap((plan) =>
    criteria.map((criterion, index) => ({
      id: `${caseId}:claim:${plan.id}:${criterion.id}`,
      subjectId: plan.id,
      criterionId: criterion.id,
      value: plan.values[index],
      status: "accepted",
      confidence: 1,
      sourceRefs: sourceReference(bundle.refs, `${plan.id}:${criterion.id}`),
    })),
  );
  return createDecisionCase({
    id: caseId,
    title: "Household Health-Plan Comparison",
    subtitle: "Synthetic consumer decision-support case",
    domain: { packId: HEALTH_PLAN_PACK_ID, packVersion: "1.0.0" },
    currency: "EUR",
    contract: {
      question: "Which plan best fits the household's declared providers, prescriptions, and expected utilization?",
      objective: "Compare plan terms and transparent cost scenarios while keeping enrollment and medical choices human-controlled.",
      alternativeIds: plans.map((entry) => entry.id),
      criterionIds: criteria.map((entry) => entry.id),
      constraintIds: constraints.map((entry) => entry.id),
      stakeholderIds: ["household"],
      authority: {
        mode: "consumer-decision-support",
        humanConfirmationRequired: true,
        allowAutomatedRanking: true,
        humanOnlyActions: ["activate_contract", "accept_import", "approve_decision"],
        prohibitedFields: [...HEALTH_PLAN_PROHIBITED_FIELDS],
      },
    },
    alternatives: plans.map(({ values: _values, issuer, planId, planType, ...plan }) => ({
      ...plan,
      planIdentity: {
        issuer,
        planId,
        planType,
        sourceRefs: sourceReference(bundle.refs, `${plan.id}:identity`),
      },
    })),
    criteria,
    constraints,
    stakeholders: [
      {
        id: "household",
        label: "Household",
        mandate: "Confirm provider directories, formularies, exclusions, and final enrollment choices directly.",
      },
    ],
    documents: bundle.documents,
    fragments: bundle.fragments,
    claims,
    scenarios: [
      {
        id: "health-scenario:high-utilization",
        label: "High utilization year",
        description: "Illustrative branch with higher estimated annual costs.",
        claimOverrides: {
          [`${caseId}:claim:plan-harbor:estimated-annual-cost`]: 7900,
          [`${caseId}:claim:plan-meadow:estimated-annual-cost`]: 7700,
          [`${caseId}:claim:plan-river:estimated-annual-cost`]: 9300,
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
        action: "Created a synthetic consumer health-plan comparison.",
      },
    ],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

export const healthPlanPack = Object.freeze({
  id: HEALTH_PLAN_PACK_ID,
  version: "1.0.0",
  label: "Health-plan comparison",
  description: "Consumer coverage and cost comparison with explicit assumptions and human enrollment authority.",
  riskClass: "sensitive-consumer-support",
  instrumentHints: ["coverage-map", "cost-waterfall", "formulary-check", "utilization-scenarios"],
  createFixture: createHealthPlanFixture,
  mapImportedDocuments: mapHealthPlanDocuments,
  validateCase: validateHealthPurpose,
  canExecute({ command }) {
    if (["set_insurance_price", "deny_coverage", "adjudicate_claim"].includes(command.type)) {
      return { allowed: false, reason: "Insurer underwriting and claims decisions are outside this product." };
    }
    return { allowed: true };
  },
});
