const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$";

export const identifierSchema = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: IDENTIFIER_PATTERN,
});

export const idempotencyKeySchema = Object.freeze({
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
  description: "Stable key reused only when retrying the same mutation.",
});

export const entityRefSchema = Object.freeze({
  type: "object",
  required: ["kind", "id"],
  properties: {
    kind: identifierSchema,
    id: identifierSchema,
  },
  additionalProperties: false,
});

const paginationProperties = {
  cursor: { type: "string", maxLength: 240 },
  limit: { type: "integer", minimum: 1, maximum: 20 },
};

const decisionMutationProperties = {
  caseId: identifierSchema,
  expectedDecisionRevision: { type: "integer", minimum: 0 },
  idempotencyKey: idempotencyKeySchema,
};

const decisionMutationRequired = ["caseId", "expectedDecisionRevision", "idempotencyKey"];

function objectSchema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const CORE_SCHEMAS = Object.freeze({
  get_workspace_state: objectSchema(),
  get_available_capabilities: objectSchema(),
  get_active_decision_contract: objectSchema({ caseId: identifierSchema }),
  get_recent_changes: objectSchema({ caseId: identifierSchema, ...paginationProperties }),
});

export const IMPORT_SCHEMAS = Object.freeze({
  start_import: objectSchema(
    {
      caseId: identifierSchema,
      sourceIds: {
        type: "array",
        items: identifierSchema,
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        description: "Files already staged by a person in this page.",
      },
      inlineText: { type: "string", minLength: 1, maxLength: 20_000 },
      domainHint: identifierSchema,
      idempotencyKey: idempotencyKeySchema,
    },
    ["idempotencyKey"],
  ),
  list_imports: objectSchema({ caseId: identifierSchema, ...paginationProperties }),
  get_import_status: objectSchema({ jobId: identifierSchema }, ["jobId"]),
  cancel_import: objectSchema(
    {
      jobId: identifierSchema,
      expectedImportVersion: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["jobId", "expectedImportVersion", "idempotencyKey"],
  ),
  inspect_document: objectSchema(
    {
      caseId: identifierSchema,
      jobId: identifierSchema,
      documentId: identifierSchema,
      includeRegions: { type: "boolean" },
      ...paginationProperties,
    },
    ["caseId", "documentId"],
  ),
  search_sources: objectSchema(
    {
      caseId: identifierSchema,
      jobId: identifierSchema,
      query: { type: "string", minLength: 2, maxLength: 240 },
      documentIds: { type: "array", items: identifierSchema, maxItems: 20, uniqueItems: true },
      ...paginationProperties,
    },
    ["caseId", "query"],
  ),
  read_source_spans: objectSchema(
    {
      caseId: identifierSchema,
      jobId: identifierSchema,
      documentId: identifierSchema,
      anchors: { type: "array", items: identifierSchema, minItems: 1, maxItems: 20, uniqueItems: true },
    },
    ["caseId", "documentId", "anchors"],
  ),
  map_table_schema: objectSchema(
    {
      jobId: identifierSchema,
      documentId: identifierSchema,
      sheetName: { type: "string", minLength: 1, maxLength: 120 },
      headerRow: { type: "integer", minimum: 1, maximum: 1_000_000 },
      mapping: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: objectSchema(
          {
            sourceColumn: { type: "string", minLength: 1, maxLength: 120 },
            targetField: identifierSchema,
            semanticType: {
              type: "string",
              enum: ["identifier", "label", "number", "currency", "date", "boolean", "category", "text", "source_ref"],
            },
          },
          ["sourceColumn", "targetField", "semanticType"],
        ),
      },
      expectedImportVersion: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["jobId", "documentId", "sheetName", "headerRow", "mapping", "expectedImportVersion", "idempotencyKey"],
  ),
  propose_semantic_mapping: objectSchema(
    {
      jobId: identifierSchema,
      suggestions: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          oneOf: [
            objectSchema(
              {
                id: identifierSchema,
                kind: { type: "string", const: "entity-resolution" },
                aliases: { type: "array", minItems: 2, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 160 } },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                sourceRefs: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: objectSchema({ documentId: identifierSchema, fragmentId: identifierSchema }, ["documentId", "fragmentId"]),
                },
              },
              ["id", "kind", "aliases", "confidence", "sourceRefs"],
            ),
            objectSchema(
              {
                id: identifierSchema,
                kind: { type: "string", const: "field-mapping" },
                sourceField: { type: "string", minLength: 1, maxLength: 160 },
                targetCriterion: { type: "string", minLength: 1, maxLength: 160 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                sourceRefs: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: objectSchema({ documentId: identifierSchema, fragmentId: identifierSchema }, ["documentId", "fragmentId"]),
                },
              },
              ["id", "kind", "sourceField", "targetCriterion", "confidence", "sourceRefs"],
            ),
          ],
        },
      },
      expectedImportVersion: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["jobId", "suggestions", "expectedImportVersion", "idempotencyKey"],
  ),
  retry_import: objectSchema(
    {
      jobId: identifierSchema,
      expectedImportVersion: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["jobId", "expectedImportVersion", "idempotencyKey"],
  ),
  request_import_review: objectSchema(
    {
      jobId: identifierSchema,
      note: { type: "string", maxLength: 500 },
      expectedImportVersion: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["jobId", "expectedImportVersion", "idempotencyKey"],
  ),
});

const sourceRefsSchema = {
  type: "array",
  items: entityRefSchema,
  maxItems: 30,
  uniqueItems: true,
};

export const MODEL_SCHEMAS = Object.freeze({
  propose_decision_contract: objectSchema(
    {
      ...decisionMutationProperties,
      decisionType: identifierSchema,
      objective: { type: "string", minLength: 8, maxLength: 500 },
      affectedParties: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 20 },
      evidenceThreshold: { type: "string", enum: ["source_required", "corroborated", "declared", "exploratory"] },
      uncertaintyPolicy: { type: "string", enum: ["block", "show_range", "penalize", "request_review"] },
      prohibitedInputs: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 30 },
      authority: { type: "string", enum: ["human_decides", "human_approves", "advisory_only"] },
    },
    [...decisionMutationRequired, "decisionType", "objective", "evidenceThreshold", "uncertaintyPolicy", "authority"],
  ),
  upsert_alternative: objectSchema(
    {
      ...decisionMutationProperties,
      alternativeId: identifierSchema,
      label: { type: "string", minLength: 1, maxLength: 160 },
      description: { type: "string", maxLength: 700 },
      sourceRefs: sourceRefsSchema,
    },
    [...decisionMutationRequired, "label"],
  ),
  set_criterion: objectSchema(
    {
      ...decisionMutationProperties,
      criterionId: identifierSchema,
      label: { type: "string", minLength: 1, maxLength: 160 },
      direction: { type: "string", enum: ["maximize", "minimize", "target", "qualitative"] },
      weight: { type: "number", minimum: 0, maximum: 1 },
      unit: { type: "string", maxLength: 40 },
      sourceRefs: sourceRefsSchema,
    },
    [...decisionMutationRequired, "criterionId", "label", "direction"],
  ),
  set_constraint: objectSchema(
    {
      ...decisionMutationProperties,
      constraintId: identifierSchema,
      label: { type: "string", minLength: 1, maxLength: 200 },
      severity: { type: "string", enum: ["hard", "soft", "prohibited"] },
      operator: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "excludes", "required"] },
      targetValue: { type: ["string", "number", "boolean", "null"], maxLength: 240 },
      unit: { type: "string", maxLength: 40 },
      sourceRefs: sourceRefsSchema,
    },
    [...decisionMutationRequired, "constraintId", "label", "severity", "operator"],
  ),
  add_claims_batch: objectSchema(
    {
      ...decisionMutationProperties,
      claims: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: objectSchema(
          {
            claimId: identifierSchema,
            subjectRef: entityRefSchema,
            predicate: identifierSchema,
            value: { type: ["string", "number", "boolean"], maxLength: 500 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            sourceRefs: sourceRefsSchema,
          },
          ["claimId", "subjectRef", "predicate", "value", "sourceRefs"],
        ),
      },
    },
    [...decisionMutationRequired, "claims"],
  ),
  link_evidence: objectSchema(
    {
      ...decisionMutationProperties,
      from: entityRefSchema,
      to: entityRefSchema,
      relation: { type: "string", enum: ["supports", "contradicts", "qualifies", "derived_from", "applies_to"] },
      sourceRef: entityRefSchema,
    },
    [...decisionMutationRequired, "from", "to", "relation"],
  ),
  propose_rule: objectSchema(
    {
      ...decisionMutationProperties,
      ruleId: identifierSchema,
      label: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", enum: ["threshold", "boolean_gate", "eligibility", "weighted_score"] },
      metricId: identifierSchema,
      operator: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte"] },
      threshold: { type: ["number", "boolean", "string"], maxLength: 120 },
      unit: { type: "string", maxLength: 40 },
      required: { type: "boolean" },
      sourceRefs: sourceRefsSchema,
    },
    [...decisionMutationRequired, "ruleId", "label", "kind", "metricId", "operator", "threshold"],
  ),
  flag_conflict: objectSchema(
    {
      ...decisionMutationProperties,
      leftRef: entityRefSchema,
      rightRef: entityRefSchema,
      reason: { type: "string", minLength: 4, maxLength: 500 },
    },
    [...decisionMutationRequired, "leftRef", "rightRef", "reason"],
  ),
  validate_decision_model: objectSchema({ caseId: identifierSchema }, ["caseId"]),
});

const alternativeIds = { type: "array", items: identifierSchema, maxItems: 50, uniqueItems: true };
const metricIds = { type: "array", items: identifierSchema, maxItems: 30, uniqueItems: true };

const runScenarioProperties = {
  caseId: identifierSchema,
  scenarioId: identifierSchema,
  alternativeIds,
  overrides: {
    type: "array",
    minItems: 1,
    maxItems: 50,
    items: objectSchema(
      {
        metricId: identifierSchema,
        value: { type: ["string", "number", "boolean", "null"], maxLength: 240 },
        unit: { type: "string", maxLength: 40 },
      },
      ["metricId", "value"],
    ),
  },
};

export const ANALYSIS_SCHEMAS = Object.freeze({
  query_decision_graph: objectSchema({
    caseId: identifierSchema,
    entityRefs: { type: "array", items: entityRefSchema, maxItems: 40 },
    relationTypes: { type: "array", items: identifierSchema, maxItems: 20, uniqueItems: true },
    statuses: { type: "array", items: identifierSchema, maxItems: 20, uniqueItems: true },
    ...paginationProperties,
  }, ["caseId"]),
  evaluate_alternatives: objectSchema({ caseId: identifierSchema, alternativeIds, scenarioId: identifierSchema }, ["caseId"]),
  run_scenario: {
    ...objectSchema(runScenarioProperties, ["caseId"]),
    allOf: [{
      anyOf: [
        { required: ["scenarioId"] },
        { required: ["overrides"] },
      ],
    }],
  },
  compare_branches: objectSchema(
    { caseId: identifierSchema, branchIds: { type: "array", items: identifierSchema, minItems: 2, maxItems: 8, uniqueItems: true } },
    ["caseId", "branchIds"],
  ),
  solve_minimum_change: objectSchema(
    { caseId: identifierSchema, alternativeId: identifierSchema, targetStatus: { type: "string", enum: ["eligible"] }, lockedMetricIds: metricIds },
    ["caseId", "alternativeId", "targetStatus"],
  ),
  run_sensitivity: objectSchema(
    { caseId: identifierSchema, alternativeIds, metricIds: { ...metricIds, minItems: 1 }, samples: { type: "integer", minimum: 10, maximum: 21 } },
    ["caseId", "metricIds"],
  ),
  challenge_recommendation: objectSchema(
    { caseId: identifierSchema, recommendationId: identifierSchema, focus: { type: "string", enum: ["evidence", "assumptions", "constraints", "uncertainty", "all"] } },
    ["caseId"],
  ),
  find_missing_evidence: objectSchema(
    { caseId: identifierSchema, alternativeIds, criterionIds: metricIds, severity: { type: "string", enum: ["blocking", "material", "all"] } },
    ["caseId"],
  ),
});

const fallbackInstrumentTypes = [
  "protected-invariants",
  "pinned-context",
  "evidence-excerpt",
  "source-preview",
  "claim-interpretation",
  "constraint-gate",
  "outcome-seal",
  "causal-trace",
  "contradiction-docket",
  "timeline",
  "missing-evidence",
  "comparison-matrix",
  "score-breakdown",
  "metric-waterfall",
  "scenario-controls",
  "sensitivity-plot",
  "risk-frontier",
  "stakeholder-mandate",
  "decision-brief",
  "data-quality-docket",
  "vendor-lanes",
  "compliance-gate-wall",
  "tco-waterfall",
  "concession-set",
  "candidate-requirement-coverage",
  "verified-experience-timeline",
  "missing-verification-docket",
  "bias-shield",
  "plan-cost-waterfall",
  "provider-network-check",
  "formulary-coverage-table",
  "utilization-scenario",
  "weighted-criteria",
  "pareto-frontier",
];

export function buildPresentationSchemas(capabilities = {}) {
  const instrumentTypes = capabilities.instrumentTypes?.length
    ? capabilities.instrumentTypes
    : fallbackInstrumentTypes;
  const layoutIds = capabilities.layoutIds?.length
    ? capabilities.layoutIds
    : ["trace", "matrix", "fork", "council"];
  const regions = capabilities.regions?.length
    ? capabilities.regions
    : ["primary", "secondary", "supporting"];

  const instrumentSchema = (allowedTypes) => objectSchema(
    {
      id: identifierSchema,
      type: { type: "string", enum: allowedTypes },
      region: { type: "string", enum: regions },
      priority: { type: "integer", minimum: 0, maximum: 100 },
      entityRefs: { type: "array", items: entityRefSchema, maxItems: 80 },
      options: objectSchema({
        compact: { type: "boolean" },
        showSources: { type: "boolean" },
        groupBy: identifierSchema,
        sortBy: identifierSchema,
        sortDirection: { type: "string", enum: ["asc", "desc"] },
        scenarioId: identifierSchema,
        metricIds,
      }),
    },
    ["id", "type", "region", "priority", "entityRefs"],
  );

  const compositionProperties = (lens, allowedTypes) => ({
    caseId: identifierSchema,
    recipeVersion: { type: "integer", const: 1 },
    intent: { type: "string", enum: ["investigate", "compare", "simulate", "brief", "explain"] },
    lens: lens ? { type: "string", const: lens } : { type: "string", enum: ["investigate", "compare", "simulate", "brief"] },
    question: { type: "string", minLength: 4, maxLength: 240 },
    framing: { type: "string", maxLength: 300 },
    layoutId: lens
      ? { type: "string", const: { investigate: "trace", compare: "matrix", simulate: "fork", brief: "council" }[lens] }
      : { type: "string", enum: layoutIds },
    density: { type: "string", enum: ["focused", "balanced", "dense"] },
    instruments: { type: "array", items: instrumentSchema(allowedTypes), minItems: 1, maxItems: 12 },
    focusPathIds: { type: "array", items: identifierSchema, maxItems: 20, uniqueItems: true },
    expectedDecisionRevision: { type: "integer", minimum: 0 },
    expectedViewRevision: { type: "integer", minimum: 0 },
    idempotencyKey: idempotencyKeySchema,
  });
  const compositionRequired = [
    "caseId",
    "recipeVersion",
    "intent",
    "lens",
    "question",
    "layoutId",
    "density",
    "instruments",
    "expectedDecisionRevision",
    "expectedViewRevision",
    "idempotencyKey",
  ];
  const declaredByLens = capabilities.instrumentTypesByLens;
  const compositionSchema = declaredByLens && typeof declaredByLens === "object"
    ? {
        type: "object",
        oneOf: ["investigate", "compare", "simulate", "brief"].map((lens) =>
          objectSchema(
            compositionProperties(
              lens,
              Array.isArray(declaredByLens[lens]) && declaredByLens[lens].length
                ? declaredByLens[lens]
                : instrumentTypes,
            ),
            compositionRequired,
          ),
        ),
        additionalProperties: false,
      }
    : objectSchema(compositionProperties(null, instrumentTypes), compositionRequired);

  return Object.freeze({
    compose_decision_room: compositionSchema,
    focus_evidence_path: objectSchema(
      {
        caseId: identifierSchema,
        entityRef: entityRefSchema,
        pathId: identifierSchema,
        expectedDecisionRevision: { type: "integer", minimum: 0 },
        expectedViewRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
      },
      ["caseId", "entityRef", "expectedDecisionRevision", "expectedViewRevision", "idempotencyKey"],
    ),
    explain_view: objectSchema({ caseId: identifierSchema }, ["caseId"]),
    save_view: objectSchema(
      {
        caseId: identifierSchema,
        label: { type: "string", minLength: 1, maxLength: 120 },
        expectedDecisionRevision: { type: "integer", minimum: 0 },
        expectedViewRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
      },
      ["caseId", "label", "expectedDecisionRevision", "expectedViewRevision", "idempotencyKey"],
    ),
    restore_view_revision: objectSchema(
      {
        caseId: identifierSchema,
        targetViewRevision: { type: "integer", minimum: 1 },
        expectedDecisionRevision: { type: "integer", minimum: 0 },
        expectedViewRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
      },
      ["caseId", "targetViewRevision", "expectedDecisionRevision", "expectedViewRevision", "idempotencyKey"],
    ),
    replay_revision: objectSchema(
      { caseId: identifierSchema, decisionRevision: { type: "integer", minimum: 1 }, ...paginationProperties },
      ["caseId", "decisionRevision"],
    ),
  });
}

export const COLLABORATION_SCHEMAS = Object.freeze({
  comment_on_entity: objectSchema(
    {
      ...decisionMutationProperties,
      entityRef: entityRefSchema,
      body: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    [...decisionMutationRequired, "entityRef", "body"],
  ),
  request_human_resolution: objectSchema(
    {
      caseId: identifierSchema,
      entityRefs: { type: "array", items: entityRefSchema, minItems: 1, maxItems: 20 },
      question: { type: "string", minLength: 4, maxLength: 500 },
      expectedDecisionRevision: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["caseId", "entityRefs", "question", "expectedDecisionRevision", "idempotencyKey"],
  ),
  create_branch: objectSchema(
    {
      ...decisionMutationProperties,
      label: { type: "string", minLength: 1, maxLength: 120 },
      purpose: { type: "string", minLength: 4, maxLength: 500 },
      fromRevision: { type: "integer", minimum: 1 },
    },
    [...decisionMutationRequired, "label", "purpose"],
  ),
});

export const OUTPUT_SCHEMAS = Object.freeze({
  preview_decision_packet: objectSchema(
    {
      caseId: identifierSchema,
      format: { type: "string", enum: ["pdf", "html", "docx", "json"] },
      includeAppendix: { type: "boolean" },
      expectedDecisionRevision: { type: "integer", minimum: 0 },
    },
    ["caseId", "format", "expectedDecisionRevision"],
  ),
  export_case: objectSchema(
    {
      caseId: identifierSchema,
      format: { type: "string", enum: ["json", "jsonld", "csv", "xlsx", "pdf", "html", "docx"] },
      expectedDecisionRevision: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["caseId", "format", "expectedDecisionRevision", "idempotencyKey"],
  ),
  draft_request: objectSchema(
    {
      caseId: identifierSchema,
      purpose: { type: "string", minLength: 4, maxLength: 500 },
      recipientRole: { type: "string", minLength: 1, maxLength: 120 },
      entityRefs: { type: "array", items: entityRefSchema, minItems: 1, maxItems: 30 },
      expectedDecisionRevision: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["caseId", "purpose", "recipientRole", "entityRefs", "expectedDecisionRevision", "idempotencyKey"],
  ),
  prepare_external_action: objectSchema(
    {
      caseId: identifierSchema,
      actionType: identifierSchema,
      summary: { type: "string", minLength: 4, maxLength: 700 },
      entityRefs: { type: "array", items: entityRefSchema, maxItems: 30 },
      expectedDecisionRevision: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
    },
    ["caseId", "actionType", "summary", "expectedDecisionRevision", "idempotencyKey"],
  ),
});

export function getToolSchema(name, capabilities) {
  return (
    CORE_SCHEMAS[name] ??
    IMPORT_SCHEMAS[name] ??
    MODEL_SCHEMAS[name] ??
    ANALYSIS_SCHEMAS[name] ??
    buildPresentationSchemas(capabilities)[name] ??
    COLLABORATION_SCHEMAS[name] ??
    OUTPUT_SCHEMAS[name]
  );
}
