import {
  CLAIM_STATUSES,
  CONSTRAINT_OPERATORS,
  CRITERION_KINDS,
  DECISION_SCHEMA_VERSION,
} from "./model.js";
import { ERROR_CODES, SituationRoomError } from "./errors.js";
import { sha256Hex } from "./canonicalize.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const VALUE_TYPES = new Set(["boolean", "number", "string", "enum", "date", "currency"]);

function diagnostic(code, path, message, severity = "error") {
  return { code, path, message, severity };
}

function validateId(value, path, diagnostics) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    diagnostics.push(diagnostic("INVALID_ID", path, "IDs must be 1-128 safe identifier characters."));
    return false;
  }
  return true;
}

function normalizePolicyField(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function inspectProhibitedFields(value, prohibited, path, diagnostics, visited = new WeakSet()) {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (prohibited.has(normalizePolicyField(key))) {
      diagnostics.push(
        diagnostic("PROHIBITED_FIELD", `${path}.${key}`, `The active domain policy prohibits field '${key}'.`),
      );
    }
    inspectProhibitedFields(child, prohibited, `${path}.${key}`, diagnostics, visited);
  }
}

function valueMatchesType(value, criterion) {
  switch (criterion?.valueType) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "currency":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "enum":
      return (
        typeof value === "string" &&
        (!Array.isArray(criterion.allowedValues) || criterion.allowedValues.includes(value))
      );
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateClaimEntry(claim, path, context, diagnostics, { validateClaimId = false } = {}) {
  if (!isPlainRecord(claim)) {
    diagnostics.push(diagnostic("OBJECT_REQUIRED", path, "A claim must be an object."));
    return;
  }
  if (validateClaimId) validateId(claim.id, `${path}.id`, diagnostics);
  if (!context.alternatives.has(claim.subjectId)) {
    diagnostics.push(diagnostic("UNKNOWN_REFERENCE", `${path}.subjectId`, "Claim subject is unknown."));
  }
  if (!context.criteria.has(claim.criterionId)) {
    diagnostics.push(diagnostic("UNKNOWN_REFERENCE", `${path}.criterionId`, "Claim criterion is unknown."));
  }
  if (!CLAIM_STATUSES.includes(claim.status)) {
    diagnostics.push(diagnostic("INVALID_CLAIM_STATUS", `${path}.status`, "Unsupported claim status."));
  }
  const criterion = context.criteriaById.get(claim.criterionId);
  if (criterion && !valueMatchesType(claim.value, criterion)) {
    diagnostics.push(
      diagnostic(
        "CLAIM_TYPE_MISMATCH",
        `${path}.value`,
        `Claim value does not match criterion type '${criterion.valueType}'.`,
      ),
    );
  }
  if (
    claim.confidence !== undefined &&
    (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1)
  ) {
    diagnostics.push(diagnostic("INVALID_CONFIDENCE", `${path}.confidence`, "Confidence must be between zero and one."));
  }
  if (!Array.isArray(claim.sourceRefs)) {
    diagnostics.push(diagnostic("ARRAY_REQUIRED", `${path}.sourceRefs`, "sourceRefs must be an array."));
    return;
  }
  claim.sourceRefs.forEach((reference, referenceIndex) => {
    const fragment = context.fragments.get(reference?.fragmentId);
    if (!fragment || fragment.documentId !== reference?.documentId) {
      diagnostics.push(
        diagnostic(
          "UNKNOWN_SOURCE_REFERENCE",
          `${path}.sourceRefs[${referenceIndex}]`,
          "Source reference must identify a fragment belonging to the referenced document.",
        ),
      );
    }
    if (
      fragment &&
      reference.quoteHash !== undefined &&
      reference.quoteHash !== `sha256:${sha256Hex(fragment.text)}`
    ) {
      diagnostics.push(
        diagnostic(
          "SOURCE_HASH_MISMATCH",
          `${path}.sourceRefs[${referenceIndex}].quoteHash`,
          "Source quote hash does not match the referenced fragment.",
        ),
      );
    }
  });
  if (
    context.sourceRequired &&
    claim.status === "accepted" &&
    claim.origin !== "derived" &&
    claim.sourceRefs.length === 0
  ) {
    diagnostics.push(diagnostic("SOURCE_REQUIRED", `${path}.sourceRefs`, "Accepted claims require source evidence."));
  }
}

function validateScenarioEntry(scenario, path, context, diagnostics) {
  if (!isPlainRecord(scenario)) {
    diagnostics.push(diagnostic("OBJECT_REQUIRED", path, "A scenario must be an object."));
    return;
  }
  if (
    typeof scenario.label !== "string" ||
    !scenario.label.trim() ||
    scenario.label.length > 200
  ) {
    diagnostics.push(
      diagnostic("INVALID_SCENARIO_LABEL", `${path}.label`, "Scenario labels must contain 1-200 characters."),
    );
  }
  if (scenario.description !== undefined && (typeof scenario.description !== "string" || scenario.description.length > 4000)) {
    diagnostics.push(
      diagnostic("INVALID_SCENARIO_DESCRIPTION", `${path}.description`, "Scenario descriptions must be at most 4,000 characters."),
    );
  }
  if (
    scenario.baseRevision !== undefined &&
    (!Number.isInteger(scenario.baseRevision) ||
      scenario.baseRevision < 1 ||
      scenario.baseRevision > context.caseRevision)
  ) {
    diagnostics.push(
      diagnostic(
        "INVALID_SCENARIO_REVISION",
        `${path}.baseRevision`,
        "Scenario baseRevision must identify an existing positive case revision.",
      ),
    );
  }
  if (scenario.mergedAt !== undefined && (typeof scenario.mergedAt !== "string" || Number.isNaN(Date.parse(scenario.mergedAt)))) {
    diagnostics.push(diagnostic("INVALID_DATE", `${path}.mergedAt`, "mergedAt must be an ISO-compatible date string."));
  }

  if (scenario.claimOverrides !== undefined && !isPlainRecord(scenario.claimOverrides)) {
    diagnostics.push(
      diagnostic("OBJECT_REQUIRED", `${path}.claimOverrides`, "claimOverrides must be a plain object keyed by claim ID."),
    );
  } else {
    const overrides = Object.entries(scenario.claimOverrides ?? {});
    if (overrides.length > 500) {
      diagnostics.push(
        diagnostic("TOO_MANY_OVERRIDES", `${path}.claimOverrides`, "A scenario may override at most 500 claims."),
      );
    }
    for (const [claimId, value] of overrides) {
      const overridePath = `${path}.claimOverrides[${JSON.stringify(claimId)}]`;
      const claim = context.claimsById.get(claimId);
      if (!claim) {
        diagnostics.push(
          diagnostic("UNKNOWN_REFERENCE", overridePath, `Scenario override references unknown claim '${claimId}'.`),
        );
        continue;
      }
      const criterion = context.criteriaById.get(claim.criterionId);
      if (criterion && !valueMatchesType(value, criterion)) {
        diagnostics.push(
          diagnostic(
            "CLAIM_TYPE_MISMATCH",
            overridePath,
            `Scenario value does not match claim criterion type '${criterion.valueType}'.`,
          ),
        );
      }
    }
  }

  if (scenario.additionalClaims !== undefined && !Array.isArray(scenario.additionalClaims)) {
    diagnostics.push(
      diagnostic("ARRAY_REQUIRED", `${path}.additionalClaims`, "additionalClaims must be an array."),
    );
  } else {
    const additionalClaims = scenario.additionalClaims ?? [];
    if (additionalClaims.length > 500) {
      diagnostics.push(
        diagnostic("TOO_MANY_SCENARIO_CLAIMS", `${path}.additionalClaims`, "A scenario may add at most 500 claims."),
      );
    }
    additionalClaims.forEach((claim, claimIndex) => {
      const claimPath = `${path}.additionalClaims[${claimIndex}]`;
      validateClaimEntry(claim, claimPath, context, diagnostics, { validateClaimId: true });
      if (!isPlainRecord(claim) || typeof claim.id !== "string") return;
      if (context.reservedAdditionalClaimIds.has(claim.id)) {
        diagnostics.push(
          diagnostic(
            "DUPLICATE_ID",
            `${claimPath}.id`,
            `ID '${claim.id}' is already used at ${context.reservedAdditionalClaimIds.get(claim.id)}.`,
          ),
        );
      } else {
        context.reservedAdditionalClaimIds.set(claim.id, `${claimPath}.id`);
      }
    });
  }

  if (scenario.mergedClaimIds !== undefined) {
    if (!Array.isArray(scenario.mergedClaimIds)) {
      diagnostics.push(diagnostic("ARRAY_REQUIRED", `${path}.mergedClaimIds`, "mergedClaimIds must be an array."));
    } else {
      const seen = new Set();
      scenario.mergedClaimIds.forEach((claimId, index) => {
        if (!context.claimsById.has(claimId)) {
          diagnostics.push(
            diagnostic("UNKNOWN_REFERENCE", `${path}.mergedClaimIds[${index}]`, `Unknown merged claim '${claimId}'.`),
          );
        }
        if (seen.has(claimId)) {
          diagnostics.push(
            diagnostic("DUPLICATE_REFERENCE", `${path}.mergedClaimIds[${index}]`, `Duplicate claim '${claimId}'.`),
          );
        }
        seen.add(claimId);
      });
    }
  }
}

export function validateDecisionCase(decisionCase) {
  const diagnostics = [];
  if (!decisionCase || typeof decisionCase !== "object") {
    return [diagnostic("INVALID_CASE", "$", "A decision case must be an object.")];
  }
  if (decisionCase.schemaVersion !== DECISION_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic(
        "UNSUPPORTED_SCHEMA",
        "$.schemaVersion",
        `Expected schema version ${DECISION_SCHEMA_VERSION}.`,
      ),
    );
  }
  validateId(decisionCase.id, "$.id", diagnostics);
  if (typeof decisionCase.title !== "string" || !decisionCase.title.trim()) {
    diagnostics.push(diagnostic("TITLE_REQUIRED", "$.title", "A non-empty title is required."));
  }
  if (!Number.isInteger(decisionCase.revision) || decisionCase.revision < 1) {
    diagnostics.push(diagnostic("INVALID_REVISION", "$.revision", "Revision must be a positive integer."));
  }
  if (!["draft", "active", "approved", "archived"].includes(decisionCase.status)) {
    diagnostics.push(diagnostic("INVALID_CASE_STATUS", "$.status", "Unsupported case status."));
  }
  if (!["draft", "active"].includes(decisionCase.contract?.status)) {
    diagnostics.push(diagnostic("INVALID_CONTRACT_STATUS", "$.contract.status", "Contract status must be draft or active."));
  }
  if (decisionCase.status === "approved" && decisionCase.contract?.status !== "active") {
    diagnostics.push(diagnostic("APPROVED_CASE_REQUIRES_ACTIVE_CONTRACT", "$.contract.status", "An approved case must retain an active contract."));
  }
  validateId(decisionCase.domain?.packId, "$.domain.packId", diagnostics);

  const collections = [
    "alternatives",
    "criteria",
    "constraints",
    "stakeholders",
    "documents",
    "fragments",
    "claims",
    "rules",
    "scenarios",
    "decisions",
    "approvals",
    "conflicts",
    "audit",
  ];
  const allIds = new Map();
  for (const collection of collections) {
    if (!Array.isArray(decisionCase[collection])) {
      diagnostics.push(diagnostic("ARRAY_REQUIRED", `$.${collection}`, `${collection} must be an array.`));
      continue;
    }
    decisionCase[collection].forEach((entry, index) => {
      const path = `$.${collection}[${index}].id`;
      if (!validateId(entry?.id, path, diagnostics)) return;
      if (allIds.has(entry.id)) {
        diagnostics.push(
          diagnostic("DUPLICATE_ID", path, `ID '${entry.id}' is already used at ${allIds.get(entry.id)}.`),
        );
      } else {
        allIds.set(entry.id, path);
      }
    });
  }
  if (validateId(decisionCase.contract?.id, "$.contract.id", diagnostics)) {
    if (allIds.has(decisionCase.contract.id)) {
      diagnostics.push(
        diagnostic("DUPLICATE_ID", "$.contract.id", `ID '${decisionCase.contract.id}' is already in use.`),
      );
    }
    allIds.set(decisionCase.contract.id, "$.contract.id");
  }

  const alternatives = new Set(decisionCase.alternatives?.map((entry) => entry.id));
  const criteria = new Set(decisionCase.criteria?.map((entry) => entry.id));
  const criteriaById = new Map(decisionCase.criteria?.map((entry) => [entry.id, entry]));
  const constraints = new Set(decisionCase.constraints?.map((entry) => entry.id));
  const stakeholders = new Set(decisionCase.stakeholders?.map((entry) => entry.id));
  const documents = new Set(decisionCase.documents?.map((entry) => entry.id));
  const fragments = new Map(decisionCase.fragments?.map((entry) => [entry.id, entry]));

  const contractReferences = [
    ["alternativeIds", alternatives],
    ["criterionIds", criteria],
    ["constraintIds", constraints],
    ["stakeholderIds", stakeholders],
  ];
  if (decisionCase.contract?.status === "active") {
    if (!decisionCase.contract.alternativeIds?.length) {
      diagnostics.push(
        diagnostic("ACTIVE_CONTRACT_REQUIRES_ALTERNATIVES", "$.contract.alternativeIds", "An active contract needs alternatives."),
      );
    }
    if (!decisionCase.contract.criterionIds?.length) {
      diagnostics.push(
        diagnostic("ACTIVE_CONTRACT_REQUIRES_CRITERIA", "$.contract.criterionIds", "An active contract needs criteria."),
      );
    }
  }
  for (const [field, allowed] of contractReferences) {
    if (!Array.isArray(decisionCase.contract?.[field])) {
      diagnostics.push(diagnostic("ARRAY_REQUIRED", `$.contract.${field}`, `${field} must be an array.`));
      continue;
    }
    const seen = new Set();
    decisionCase.contract[field].forEach((id, index) => {
      if (!allowed.has(id)) {
        diagnostics.push(
          diagnostic("UNKNOWN_REFERENCE", `$.contract.${field}[${index}]`, `Unknown referenced ID '${id}'.`),
        );
      }
      if (seen.has(id)) {
        diagnostics.push(
          diagnostic("DUPLICATE_REFERENCE", `$.contract.${field}[${index}]`, `Duplicate reference '${id}'.`),
        );
      }
      seen.add(id);
    });
  }

  decisionCase.criteria?.forEach((criterion, index) => {
    const path = `$.criteria[${index}]`;
    if (typeof criterion.label !== "string" || !criterion.label.trim() || criterion.label.length > 200) {
      diagnostics.push(diagnostic("INVALID_CRITERION_LABEL", `${path}.label`, "Criterion labels must contain 1-200 characters."));
    }
    if (!CRITERION_KINDS.includes(criterion.kind)) {
      diagnostics.push(diagnostic("INVALID_CRITERION_KIND", `${path}.kind`, "Unsupported criterion kind."));
    }
    if (!VALUE_TYPES.has(criterion.valueType)) {
      diagnostics.push(diagnostic("INVALID_VALUE_TYPE", `${path}.valueType`, "Unsupported criterion value type."));
    }
    if (criterion.kind === "score" && (!Number.isFinite(criterion.weight) || criterion.weight < 0)) {
      diagnostics.push(diagnostic("INVALID_WEIGHT", `${path}.weight`, "Score weights must be finite and non-negative."));
    }
    if (criterion.scoring?.kind === "linear") {
      if (!Number.isFinite(criterion.scoring.min) || !Number.isFinite(criterion.scoring.max)) {
        diagnostics.push(diagnostic("INVALID_SCORING_RANGE", `${path}.scoring`, "Linear bounds must be finite."));
      } else if (criterion.scoring.max <= criterion.scoring.min) {
        diagnostics.push(diagnostic("INVALID_SCORING_RANGE", `${path}.scoring`, "Linear maximum must exceed minimum."));
      }
    }
    if (criterion.scoring?.kind === "lookup") {
      const values = Object.values(criterion.scoring.values ?? {});
      if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        diagnostics.push(
          diagnostic("INVALID_SCORING_LOOKUP", `${path}.scoring.values`, "Lookup scores must be numbers between zero and one."),
        );
      }
    }
  });

  decisionCase.alternatives?.forEach((alternative, index) => {
    if (typeof alternative.label !== "string" || !alternative.label.trim() || alternative.label.length > 200) {
      diagnostics.push(
        diagnostic(
          "INVALID_ALTERNATIVE_LABEL",
          `$.alternatives[${index}].label`,
          "Alternative labels must contain 1-200 characters.",
        ),
      );
    }
    if (alternative.description !== undefined && (typeof alternative.description !== "string" || alternative.description.length > 2_000)) {
      diagnostics.push(
        diagnostic(
          "INVALID_ALTERNATIVE_DESCRIPTION",
          `$.alternatives[${index}].description`,
          "Alternative descriptions must be at most 2,000 characters.",
        ),
      );
    }
  });

  decisionCase.constraints?.forEach((constraint, index) => {
    const path = `$.constraints[${index}]`;
    if (!criteria.has(constraint.criterionId)) {
      diagnostics.push(diagnostic("UNKNOWN_REFERENCE", `${path}.criterionId`, "Constraint criterion is unknown."));
    }
    if (!CONSTRAINT_OPERATORS.includes(constraint.operator)) {
      diagnostics.push(diagnostic("INVALID_OPERATOR", `${path}.operator`, "Unsupported constraint operator."));
    }
    if (!['mandatory', 'advisory'].includes(constraint.severity)) {
      diagnostics.push(diagnostic("INVALID_SEVERITY", `${path}.severity`, "Severity must be mandatory or advisory."));
    }
    constraint.alternativeIds?.forEach((id, alternativeIndex) => {
      if (!alternatives.has(id)) {
        diagnostics.push(
          diagnostic("UNKNOWN_REFERENCE", `${path}.alternativeIds[${alternativeIndex}]`, "Unknown alternative."),
        );
      }
    });
  });

  decisionCase.fragments?.forEach((fragment, index) => {
    if (!documents.has(fragment.documentId)) {
      diagnostics.push(
        diagnostic("UNKNOWN_REFERENCE", `$.fragments[${index}].documentId`, "Fragment document is unknown."),
      );
    }
    if (typeof fragment.text !== "string") {
      diagnostics.push(diagnostic("TEXT_REQUIRED", `$.fragments[${index}].text`, "Fragment text is required."));
    }
  });

  decisionCase.documents?.forEach((document, index) => {
    if (document.securityStatus === "quarantined") {
      diagnostics.push(
        diagnostic(
          "QUARANTINED_DOCUMENT",
          `$.documents[${index}].securityStatus`,
          "Quarantined documents cannot enter canonical decision state.",
        ),
      );
    }
  });

  decisionCase.claims?.forEach((claim, index) => {
    const path = `$.claims[${index}]`;
    if (!alternatives.has(claim.subjectId)) {
      diagnostics.push(diagnostic("UNKNOWN_REFERENCE", `${path}.subjectId`, "Claim subject is unknown."));
    }
    if (!criteria.has(claim.criterionId)) {
      diagnostics.push(diagnostic("UNKNOWN_REFERENCE", `${path}.criterionId`, "Claim criterion is unknown."));
    }
    if (!CLAIM_STATUSES.includes(claim.status)) {
      diagnostics.push(diagnostic("INVALID_CLAIM_STATUS", `${path}.status`, "Unsupported claim status."));
    }
    const criterion = criteriaById.get(claim.criterionId);
    if (criterion && !valueMatchesType(claim.value, criterion)) {
      diagnostics.push(
        diagnostic(
          "CLAIM_TYPE_MISMATCH",
          `${path}.value`,
          `Claim value does not match criterion type '${criterion.valueType}'.`,
        ),
      );
    }
    if (claim.confidence !== undefined && (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1)) {
      diagnostics.push(diagnostic("INVALID_CONFIDENCE", `${path}.confidence`, "Confidence must be between zero and one."));
    }
    if (!Array.isArray(claim.sourceRefs)) {
      diagnostics.push(diagnostic("ARRAY_REQUIRED", `${path}.sourceRefs`, "sourceRefs must be an array."));
    } else {
      claim.sourceRefs.forEach((reference, referenceIndex) => {
        const fragment = fragments.get(reference.fragmentId);
        if (!fragment || fragment.documentId !== reference.documentId) {
          diagnostics.push(
            diagnostic(
              "UNKNOWN_SOURCE_REFERENCE",
              `${path}.sourceRefs[${referenceIndex}]`,
              "Source reference must identify a fragment belonging to the referenced document.",
            ),
          );
        }
        if (
          fragment &&
          reference.quoteHash !== undefined &&
          reference.quoteHash !== `sha256:${sha256Hex(fragment.text)}`
        ) {
          diagnostics.push(
            diagnostic(
              "SOURCE_HASH_MISMATCH",
              `${path}.sourceRefs[${referenceIndex}].quoteHash`,
              "Source quote hash does not match the referenced fragment.",
            ),
          );
        }
      });
      if (
        decisionCase.contract?.evidencePolicy?.sourceRequired &&
        claim.status === "accepted" &&
        claim.origin !== "derived" &&
        claim.sourceRefs.length === 0
      ) {
        diagnostics.push(diagnostic("SOURCE_REQUIRED", `${path}.sourceRefs`, "Accepted claims require source evidence."));
      }
    }
  });

  const scenarioContext = {
    alternatives,
    criteria,
    criteriaById,
    fragments,
    claimsById: new Map(decisionCase.claims?.map((claim) => [claim.id, claim])),
    sourceRequired: decisionCase.contract?.evidencePolicy?.sourceRequired === true,
    caseRevision: decisionCase.revision,
    reservedAdditionalClaimIds: new Map(allIds),
  };
  decisionCase.scenarios?.forEach((scenario, index) => {
    validateScenarioEntry(scenario, `$.scenarios[${index}]`, scenarioContext, diagnostics);
  });

  const prohibited = new Set(
    decisionCase.contract?.authority?.prohibitedFields?.map(normalizePolicyField),
  );
  if (prohibited.size) {
    inspectProhibitedFields(decisionCase.alternatives, prohibited, "$.alternatives", diagnostics);
    inspectProhibitedFields(decisionCase.criteria, prohibited, "$.criteria", diagnostics);
    inspectProhibitedFields(decisionCase.constraints, prohibited, "$.constraints", diagnostics);
    inspectProhibitedFields(decisionCase.claims, prohibited, "$.claims", diagnostics);
    inspectProhibitedFields(decisionCase.documents, prohibited, "$.documents", diagnostics);
    inspectProhibitedFields(decisionCase.fragments, prohibited, "$.fragments", diagnostics);
    inspectProhibitedFields(decisionCase.scenarios, prohibited, "$.scenarios", diagnostics);
  }

  return diagnostics;
}

export function assertValidDecisionCase(decisionCase) {
  const diagnostics = validateDecisionCase(decisionCase);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      `Decision case validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
      { diagnostics },
    );
  }
  return diagnostics;
}
