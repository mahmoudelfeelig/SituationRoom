import { ToolError } from "./envelopes.js";
import { getToolSchema } from "./schemas.js";
import { requirePortMethod } from "./ports.js";

function unwrapPortResult(result, fallbackMessage = "The operation was rejected.") {
  if (result?.ok === false) {
    const error = result.error;
    throw new ToolError(
      typeof error === "object" ? error.code : result.code ?? "VALIDATION_FAILED",
      typeof error === "object" ? error.message : error ?? result.message ?? fallbackMessage,
      {
        retryable: Boolean(typeof error === "object" ? error.retryable : result.retryable),
        recovery: typeof error === "object" ? error.recovery : result.recovery,
        safeDetails: typeof error === "object" ? error.details : undefined,
      },
    );
  }
  return result?.data ?? result;
}

function boundedList(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit);
}

function sourceReadScope(input, context) {
  const importReview = context?.phase === "import_review";
  const canonicalRoom = ["contract_draft", "analysis"].includes(context?.phase);
  if (importReview && !input.jobId) {
    throw new ToolError(
      "VALIDATION_FAILED",
      "Source reads during import review require the active import jobId and caseId.",
      { recovery: { tool: "get_import_status" } },
    );
  }
  if (canonicalRoom && input.jobId) {
    throw new ToolError(
      "VALIDATION_FAILED",
      "Settled decision rooms read canonical case evidence; omit jobId and use the active caseId.",
      { recovery: { tool: "get_workspace_state" } },
    );
  }
  return { caseId: input.caseId, ...(input.jobId ? { jobId: input.jobId } : {}) };
}

function projectCase(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    id: entry.id ?? entry.caseId,
    title: entry.title ?? entry.name,
    domainId: entry.domainId,
    status: entry.status,
    decisionRevision: entry.decisionRevision ?? entry.revision,
    updatedAt: entry.updatedAt,
  };
}

function projectWorkspace(workspace = {}) {
  const cases = workspace.cases ?? workspace.caseSummaries ?? [];
  return {
    workspaceId: workspace.id ?? workspace.workspaceId ?? null,
    phase: workspace.capabilityPhase ?? workspace.workspacePhase ?? workspace.phase ?? "unknown",
    activeCaseId: workspace.activeCaseId ?? workspace.activeCase?.id ?? workspace.caseId ?? null,
    domainId: workspace.domainId ?? workspace.activeCase?.domainId ?? "general",
    role: workspace.role ?? workspace.security?.role ?? "unassigned",
    permissionsDeclared: Array.isArray(workspace.permissions ?? workspace.security?.permissions),
    frozen: Boolean(workspace.frozen),
    pendingHumanCheckpoint: Boolean(workspace.pendingHumanCheckpoint),
    governanceVersion: workspace.governanceVersion ?? 0,
    sharedAuthorityAvailable: workspace.sharedAuthorityAvailable !== false,
    governedAgentMutationsBlocked: Boolean(workspace.governedAgentMutationsBlocked),
    decisionRevision: workspace.decisionRevision ?? 0,
    viewRevision: workspace.viewRevision ?? 0,
    caseCount: Array.isArray(cases) ? cases.length : 0,
    cases: boundedList(cases, 12).map(projectCase),
    stagedSourceCount: workspace.stagedSourceCount ?? workspace.stagedSources?.length ?? 0,
  };
}

function projectContract(contract) {
  if (!contract) return null;
  return {
    id: contract.id ?? contract.contractId,
    caseId: contract.caseId,
    status: contract.status,
    domainId: contract.domainId,
    decisionType: contract.decisionType,
    objective: contract.objective,
    authority: contract.authority,
    evidenceThreshold: contract.evidenceThreshold,
    uncertaintyPolicy: contract.uncertaintyPolicy,
    prohibitedInputs: boundedList(contract.prohibitedInputs, 20),
    alternativeCount: contract.alternativeCount ?? contract.alternatives?.length ?? 0,
    criterionCount: contract.criterionCount ?? contract.criteria?.length ?? 0,
    constraintCount: contract.constraintCount ?? contract.constraints?.length ?? 0,
    revision: contract.revision,
    pendingHumanCheckpoint: Boolean(contract.pendingHumanCheckpoint),
  };
}

function projectImport(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    jobId: entry.jobId ?? entry.id,
    caseId: entry.caseId,
    phase: entry.phase ?? entry.status,
    version: entry.version ?? entry.importVersion,
    progress: entry.progress,
    documentCount: entry.documentCount ?? entry.documents?.length,
    warningCount: entry.warningCount ?? entry.warnings?.length,
    errorCode: entry.error?.code ?? entry.errorCode,
    updatedAt: entry.updatedAt,
  };
}

function projectPresentation(snapshot = {}) {
  return {
    caseId: snapshot.caseId,
    lens: snapshot.lens,
    layoutId: snapshot.layoutId ?? snapshot.layout?.pattern,
    density: snapshot.density,
    question: snapshot.question,
    framing: snapshot.framing,
    decisionRevision: snapshot.decisionRevision,
    decisionHash: snapshot.decisionHash,
    viewRevision: snapshot.viewRevision,
    viewHash: snapshot.viewHash,
    renderedInstrumentIds: boundedList(snapshot.renderedInstrumentIds ?? snapshot.instrumentIds, 20),
    preservedPins: snapshot.preservedPins ?? snapshot.pinCount,
    omittedEntityCount: snapshot.omittedEntityCount,
    viewStale: Boolean(snapshot.viewStale),
  };
}

function createSpec(name, options, capabilities) {
  const mutating = Boolean(options.mutating);
  return {
    name,
    description: options.description,
    family: options.family,
    inputSchema: getToolSchema(name, capabilities),
    annotations: {
      readOnlyHint: !mutating,
      ...(options.untrusted ? { untrustedContentHint: true } : {}),
    },
    mutating,
    decisionMutation: Boolean(options.decisionMutation),
    humanCheckpoint: Boolean(options.humanCheckpoint),
    allowedWithHumanCheckpoint: Boolean(options.allowedWithHumanCheckpoint),
    allowedWhenFrozen: Boolean(options.allowedWhenFrozen),
    prohibitedInRegulated: Boolean(options.prohibitedInRegulated),
    requiresCase: Boolean(options.requiresCase),
    permission: options.permission,
    phases: options.phases,
    lenses: options.lenses,
    when: options.when,
    requiredPort: options.requiredPort,
    execute: options.execute,
  };
}

function commandExecutor(ports, type) {
  return async (input, { actor, signal }) => {
    if (signal?.aborted) throw new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true });
    const { caseId, expectedDecisionRevision, idempotencyKey, ...payload } = input;
    const result = await ports.runtime.executeCommand(
      { type, caseId, payload },
      { expectedRevision: expectedDecisionRevision, idempotencyKey, actor, signal },
    );
    return unwrapPortResult(result);
  };
}

function queryExecutor(ports, mode) {
  return async (input, { signal }) => {
    if (signal?.aborted) throw new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true });
    return unwrapPortResult(await ports.runtime.queryGraph({ ...input, mode, signal }));
  };
}

function diagnosticCodes(result) {
  return boundedList(result?.diagnostics, 12).map((entry) => ({
    code: entry.code,
    ...(entry.metricId ? { metricId: entry.metricId } : {}),
  }));
}

function representativePoints(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const indexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return indexes.map((index) => ({
    value: points[index].value,
    outcomes: boundedList(points[index].outcomes, 4),
  }));
}

function projectAnalysisResult(mode, result = {}) {
  const common = {
    caseId: result.caseId,
    revision: result.revision,
    analysisKind: result.analysisKind,
    supported: Boolean(result.supported),
    originalDecisionUnchanged: Boolean(result.originalDecisionUnchanged),
  };
  if (mode === "scenario") {
    return {
      ...common,
      hashesMatch: result.decisionHashBefore === result.decisionHashAfter,
      scenarioId: result.scenarioId ?? null,
      savedScenarioApplied: Boolean(result.savedScenarioApplied),
      savedOverrideCount: result.savedOverrideCount ?? 0,
      savedAdditionalClaimCount: result.savedAdditionalClaimCount ?? 0,
      appliedOverrides: boundedList(result.appliedOverrides, 20).map((entry) => ({
        metricId: entry.metricId,
        value: entry.value,
        unit: entry.unit,
        alternativeIds: boundedList(entry.alternativeIds, 12),
      })),
      results: boundedList(result.evaluation?.results, 12),
      ranking: boundedList(result.evaluation?.ranking, 12),
      blockerCount: result.evaluation?.blockerCount ?? 0,
      unresolvedCount: result.evaluation?.unresolvedCount ?? 0,
    };
  }
  if (mode === "sensitivity") {
    return {
      ...common,
      sampled: Boolean(result.sampled),
      alternativeIds: boundedList(result.alternativeIds, 12),
      sweeps: boundedList(result.sweeps, 8).map((sweep) => ({
        metricId: sweep.metricId,
        range: sweep.range,
        sampleCount: sweep.points?.length ?? 0,
        representativeSamples: representativePoints(sweep.points),
      })),
      diagnostics: diagnosticCodes(result),
    };
  }
  if (mode === "minimum_change") {
    return {
      ...common,
      minimumChangeFound: Boolean(result.minimumChangeFound),
      exactWithinTrustedDomain: Boolean(result.exactOptimizationAvailable),
      alternativeId: result.alternativeId,
      targetStatus: result.targetStatus,
      baseline: result.baseline,
      result: result.result,
      changes: boundedList(result.changes, 20),
      diagnostics: diagnosticCodes(result),
    };
  }
  return result;
}

function evaluationExecutor(ports, mode) {
  return async (input, { signal }) => {
    const { caseId, ...options } = input;
    const result = unwrapPortResult(await ports.runtime.evaluate(caseId, { ...options, mode, signal }));
    return projectAnalysisResult(mode, result);
  };
}

export function createToolCatalog({
  ports,
  receipts,
  actor,
  capabilities = {},
  getCapabilitySummary = () => ({ activeTools: [] }),
}) {
  const specs = [];
  const add = (name, options) => specs.push(createSpec(name, options, capabilities));

  add("get_workspace_state", {
    family: "kernel",
    description: "Read a bounded summary of the workspace, active case, current phase, staged sources, and declared role. Use it to orient before acting.",
    untrusted: true,
    permission: "workspace:read",
    execute: async () => projectWorkspace(await ports.runtime.getWorkspaceState()),
  });
  add("get_available_capabilities", {
    family: "kernel",
    description: "Read which SituationRoom capabilities are active now and which room lens or workflow phase makes other capabilities available.",
    execute: async () => getCapabilitySummary(),
  });
  add("get_active_decision_contract", {
    family: "kernel",
    description: "Read the active decision contract: objective, authority, evidence threshold, uncertainty policy, prohibited inputs, and model counts.",
    requiresCase: true,
    permission: "case:read",
    phases: ["contract_draft", "analysis", "collaboration", "output", "frozen"],
    untrusted: true,
    execute: async ({ caseId }, { context }) =>
      projectContract(await ports.runtime.getActiveContract(caseId ?? context.activeCaseId)),
  });
  add("get_recent_changes", {
    family: "kernel",
    description: "Read recent audited decision and WebMCP changes with bounded pagination. Use it to understand what changed before continuing work.",
    requiresCase: true,
    permission: "case:read",
    phases: ["analysis", "collaboration", "output", "frozen"],
    lenses: ["investigate", "brief"],
    untrusted: true,
    execute: async ({ caseId, cursor, limit = 10 }) => {
      if (typeof ports.runtime.getRecentChanges === "function") {
        return unwrapPortResult(await ports.runtime.getRecentChanges(caseId, { cursor, limit }));
      }
      return typeof receipts.listAsync === "function"
        ? receipts.listAsync({ cursor, limit })
        : receipts.list({ cursor, limit });
    },
  });

  add("start_import", {
    family: "intake",
    description: "Start asynchronous intake from opaque files already staged and policy-confirmed by a person. Bounded inline text is accepted only for an existing authoritative case; it cannot select files, use paths, or initiate network requests.",
    mutating: true,
    permission: "import:write",
    phases: ["empty", "intake"],
    requiredPort: "imports.startImport",
    untrusted: true,
    execute: async (input, { actor, signal }) => {
      const inputs = [
        ...(input.sourceIds ?? []).map((sourceId) => ({ kind: "staged_source", sourceId })),
        ...(input.inlineText ? [{ kind: "inline_text", text: input.inlineText }] : []),
      ];
      if (!inputs.length) {
        throw new ToolError("VALIDATION_FAILED", "Provide at least one human-staged source or bounded inline text for an existing case.");
      }
      const result = await ports.imports.startImport(inputs, {
        caseId: input.caseId,
        domainHint: input.domainHint,
        idempotencyKey: input.idempotencyKey,
        actor,
        signal,
      });
      return projectImport(unwrapPortResult(result));
    },
  });
  add("list_imports", {
    family: "intake",
    description: "List bounded import-job summaries for the workspace or active case. Imported labels and statuses are untrusted source-derived content.",
    permission: "import:read",
    phases: ["empty", "intake", "importing", "import_review"],
    requiredPort: "imports.listImports",
    untrusted: true,
    execute: async ({ caseId, cursor, limit = 10 }) => {
      const result = await ports.imports.listImports(caseId, { cursor, limit });
      const entries = Array.isArray(result) ? result : result?.entries ?? result?.imports ?? [];
      return {
        entries: boundedList(entries, limit).map(projectImport),
        nextCursor: result?.nextCursor ?? null,
        total: result?.total ?? entries.length,
      };
    },
  });
  add("get_import_status", {
    family: "intake",
    description: "Read one asynchronous import job's phase, progress, warnings, quarantine status, and review requirement.",
    permission: "import:read",
    phases: ["importing", "import_review"],
    requiredPort: "imports.getImport",
    untrusted: true,
    execute: async ({ jobId }) => projectImport(unwrapPortResult(await ports.imports.getImport(jobId))),
  });
  add("cancel_import", {
    family: "intake",
    description: "Cancel an import that has not begun canonical commit. It leaves committed decisions untouched and reports when cancellation is too late.",
    mutating: true,
    permission: "import:write",
    phases: ["importing", "import_review"],
    requiredPort: "imports.cancelImport",
    execute: async (input, { actor, signal }) =>
      projectImport(
        unwrapPortResult(
          await ports.imports.cancelImport(input.jobId, {
            expectedImportVersion: input.expectedImportVersion,
            idempotencyKey: input.idempotencyKey,
            actor,
            signal,
          }),
        ),
      ),
  });
  add("inspect_document", {
    family: "intake",
    description: "Inspect one document inside the active case scope. Import review requires its job ID; settled rooms use the canonical case copy. Source text is untrusted.",
    permission: "import:read",
    phases: ["import_review", "contract_draft", "analysis"],
    lenses: ["investigate"],
    when: (context) => context.phase !== "analysis" || context.presentation?.sourceDrawerOpen === true,
    requiredPort: "imports.inspectDocument",
    untrusted: true,
    execute: async (input, { context }) => {
      const { documentId, includeRegions, cursor, limit = 10 } = input;
      return unwrapPortResult(await ports.imports.inspectDocument(documentId, {
        ...sourceReadScope(input, context),
        includeRegions,
        cursor,
        limit,
      }));
    },
  });
  add("search_sources", {
    family: "intake",
    description: "Search only the active case's canonical evidence, or one explicitly scoped import-review job, and return bounded exact anchors.",
    permission: "import:read",
    phases: ["import_review", "contract_draft", "analysis"],
    lenses: ["investigate"],
    when: (context) => context.phase !== "analysis" || context.presentation?.sourceDrawerOpen === true,
    requiredPort: "imports.searchFragments",
    untrusted: true,
    execute: async (input, { context }) =>
      unwrapPortResult(await ports.imports.searchFragments({ ...input, ...sourceReadScope(input, context) })),
  });
  add("read_source_spans", {
    family: "intake",
    description: "Read selected exact spans within the active case or import-review job. The bounded result preserves page, cell, paragraph, or image-region provenance.",
    permission: "import:read",
    phases: ["import_review", "contract_draft", "analysis"],
    lenses: ["investigate"],
    when: (context) => context.phase !== "analysis" || context.presentation?.sourceDrawerOpen === true,
    requiredPort: "imports.readSourceSpans",
    untrusted: true,
    execute: async (input, { context }) => {
      const { documentId, anchors } = input;
      return unwrapPortResult(await ports.imports.readSourceSpans(
        documentId,
        anchors,
        sourceReadScope(input, context),
      ));
    },
  });
  add("map_table_schema", {
    family: "intake",
    description: "Map spreadsheet columns to semantic fields for a review-required import. It cannot execute formulas or commit the import.",
    mutating: true,
    permission: "import:write",
    phases: ["import_review"],
    requiredPort: "imports.mapTableSchema",
    untrusted: true,
    execute: async (input, { actor, signal }) =>
      unwrapPortResult(
        await ports.imports.mapTableSchema(input.documentId, input.mapping, {
          jobId: input.jobId,
          sheetName: input.sheetName,
          headerRow: input.headerRow,
          expectedImportVersion: input.expectedImportVersion,
          idempotencyKey: input.idempotencyKey,
          actor,
          signal,
        }),
      ),
  });
  add("propose_semantic_mapping", {
    family: "intake",
    description: "Stage bounded cross-document entity-resolution or field-mapping suggestions for visible human review. Suggestions must cite exact import fragments and cannot override deterministic evidence, commit a case, or resolve conflicts automatically.",
    mutating: true,
    allowedWithHumanCheckpoint: true,
    permission: "import:write",
    phases: ["import_review"],
    requiredPort: "imports.proposeSemanticMapping",
    untrusted: true,
    execute: async (input, { actor, signal }) => unwrapPortResult(
      await ports.imports.proposeSemanticMapping(input.jobId, input.suggestions, {
        expectedImportVersion: input.expectedImportVersion,
        idempotencyKey: input.idempotencyKey,
        actor,
        signal,
      }),
    ),
  });
  add("retry_import", {
    family: "intake",
    description: "Retry a failed or quarantined import through the same validation pipeline. It never bypasses quarantine or human review.",
    mutating: true,
    permission: "import:write",
    phases: ["import_review"],
    requiredPort: "imports.retryImport",
    execute: async (input, { actor, signal }) =>
      projectImport(
        unwrapPortResult(
          await ports.imports.retryImport(input.jobId, {
            expectedImportVersion: input.expectedImportVersion,
            idempotencyKey: input.idempotencyKey,
            actor,
            signal,
          }),
        ),
      ),
  });
  add("request_import_review", {
    family: "intake",
    description: "Open a visible human checkpoint for a review-ready import. This tool requests review; it cannot commit evidence to the canonical graph.",
    mutating: true,
    humanCheckpoint: true,
    permission: "import:review_request",
    phases: ["import_review"],
    requiredPort: (availablePorts) =>
      typeof availablePorts.imports?.requestHumanReview === "function" ||
      typeof availablePorts.presentation?.requestHumanCheckpoint === "function",
    execute: async (input, { actor, signal }) => {
      const call =
        typeof ports.imports.requestHumanReview === "function"
          ? ports.imports.requestHumanReview.bind(ports.imports)
          : requirePortMethod(ports, "presentation.requestHumanCheckpoint");
      return unwrapPortResult(await call({ type: "import", ...input, actor, signal }));
    },
  });

  const modelCommands = [
    ["propose_decision_contract", "decision.proposeContract", "Propose a versioned decision contract for human review. It cannot activate the contract or grant decision authority."],
    ["upsert_alternative", "decision.upsertAlternative", "Create or revise a draft alternative with bounded source references."],
    ["set_criterion", "decision.setCriterion", "Create or revise a draft decision criterion, direction, weight, unit, and supporting sources."],
    ["set_constraint", "decision.setConstraint", "Create or revise a hard, soft, or prohibited constraint in the draft decision model."],
    ["add_claims_batch", "decision.addClaimsBatch", "Add a bounded batch of source-linked claims to the draft graph. Imported claim text remains untrusted."],
    ["link_evidence", "decision.linkEvidence", "Propose a typed evidence relationship between canonical entities using an exact source reference."],
    ["propose_rule", "decision.proposeRule", "Propose a rule from trusted operators and metrics. It cannot supply formulas or executable expressions."],
    ["flag_conflict", "decision.flagConflict", "Flag two canonical entities as conflicting and record a bounded explanation for review."],
  ];
  for (const [name, command, description] of modelCommands) {
    add(name, {
      family: "model",
      description,
      mutating: true,
      decisionMutation: true,
      requiresCase: true,
      permission: "decision:draft",
      phases: ["contract_draft"],
      requiredPort: "runtime.executeCommand",
      untrusted: true,
      execute: commandExecutor(ports, command),
    });
  }
  add("validate_decision_model", {
    family: "model",
    description: "Validate the draft model's completeness, references, rules, authority, prohibited inputs, and unresolved blockers without changing it.",
    requiresCase: true,
    permission: "case:read",
    phases: ["contract_draft"],
    untrusted: true,
    execute: queryExecutor(ports, "validate_model"),
  });

  const analysisTools = [
    ["query_decision_graph", "query", "Read bounded canonical evidence paths and relationships for selected entities.", ["investigate", "compare"]],
    ["evaluate_alternatives", "evaluate", "Evaluate selected alternatives with deterministic rules under the active contract.", ["compare", "brief"]],
    ["run_scenario", "scenario", "Evaluate a saved scenario, typed inline metric overrides, or both against a decision clone and deterministic domain rules. It never writes the canonical decision.", ["simulate"]],
    ["compare_branches", "compare_branches", "Compare two or more saved hypothetical branches and explain material differences.", ["compare", "simulate"]],
    ["solve_minimum_change", "minimum_change", "Search trusted finite domains and numeric ranges for the smallest blocker changes needed for eligibility; return an explicit diagnostic-only result when no trusted search domain exists.", ["simulate"]],
    ["run_sensitivity", "sensitivity", "Run deterministic one-at-a-time sweeps only across canonical numeric ranges; metrics without a trusted range are returned explicitly as diagnostic-only, never inferred.", ["simulate"]],
    ["challenge_recommendation", "challenge", "Construct the strongest source-backed challenge to the current recommendation.", ["investigate", "compare"]],
    ["find_missing_evidence", "missing_evidence", "Find blocking or material claims that lack sufficient source evidence.", ["investigate"]],
  ];
  const candidateOutcomeTools = new Set([
    "run_scenario",
    "compare_branches",
    "solve_minimum_change",
    "run_sensitivity",
    "challenge_recommendation",
  ]);
  for (const [name, mode, description, lenses] of analysisTools) {
    add(name, {
      family: "analysis",
      description,
      requiresCase: true,
      permission: "analysis:read",
      phases: ["analysis", "frozen"],
      lenses,
      when: (context) => context.domainId !== "candidate-review" || !candidateOutcomeTools.has(name),
      untrusted: true,
      execute:
        name === "query_decision_graph"
          ? queryExecutor(ports, mode)
          : evaluationExecutor(ports, mode),
    });
  }

  add("compose_decision_room", {
    family: "presentation",
    description: "Apply a validated semantic room recipe from trusted layouts and instruments. It changes presentation only and preserves canonical facts and human pins.",
    mutating: true,
    requiresCase: true,
    permission: "presentation:write",
    phases: ["analysis"],
    requiredPort: "presentation.applyPresentationRecipe",
    execute: async (input) => {
      const { caseId, idempotencyKey, ...recipe } = input;
      const result = await ports.presentation.applyPresentationRecipe(recipe, actor);
      return unwrapPortResult(result, "The presentation recipe was rejected.");
    },
  });
  add("focus_evidence_path", {
    family: "presentation",
    description: "Focus one canonical entity and its causal evidence path in the current room without changing facts, pins, or decision authority.",
    mutating: true,
    requiresCase: true,
    permission: "presentation:write",
    phases: ["analysis"],
    lenses: ["investigate"],
    requiredPort: "presentation.focusEntity",
    execute: async ({ entityRef, pathId }) => unwrapPortResult(await ports.presentation.focusEntity(entityRef, pathId)),
  });
  add("explain_view", {
    family: "presentation",
    description: "Explain the current trusted layout, instruments, omissions, pins, decision revision, and presentation revision.",
    requiresCase: true,
    permission: "case:read",
    phases: ["analysis", "frozen"],
    requiredPort: "presentation.getPresentationSnapshot",
    execute: async () => projectPresentation(await ports.presentation.getPresentationSnapshot()),
  });
  add("save_view", {
    family: "presentation",
    description: "Save the current presentation as a named view-history entry. It does not change the canonical decision revision.",
    mutating: true,
    requiresCase: true,
    permission: "presentation:write",
    phases: ["analysis"],
    lenses: ["brief"],
    requiredPort: "presentation.saveView",
    execute: async ({ label }) => unwrapPortResult(await ports.presentation.saveView({ label, actor })),
  });
  add("restore_view_revision", {
    family: "presentation",
    description: "Restore a prior presentation revision while preserving the current canonical decision and protected pins.",
    mutating: true,
    requiresCase: true,
    permission: "presentation:write",
    phases: ["analysis"],
    lenses: ["brief"],
    requiredPort: "presentation.restoreViewRevision",
    execute: async ({ targetViewRevision }) =>
      unwrapPortResult(await ports.presentation.restoreViewRevision(targetViewRevision)),
  });
  add("replay_revision", {
    family: "presentation",
    description: "Read the audited causal changes for a prior decision revision without restoring or mutating it.",
    requiresCase: true,
    permission: "case:read",
    phases: ["analysis", "output", "frozen"],
    lenses: ["brief"],
    untrusted: true,
    execute: queryExecutor(ports, "replay_revision"),
  });

  add("comment_on_entity", {
    family: "collaboration",
    description: "Add an explicitly agent-authored comment to a canonical entity. It cannot resolve a dispute or impersonate a human reviewer.",
    mutating: true,
    decisionMutation: true,
    requiresCase: true,
    permission: "collaboration:comment",
    phases: ["collaboration"],
    untrusted: true,
    execute: commandExecutor(ports, "collaboration.addAgentComment"),
  });
  add("request_human_resolution", {
    family: "collaboration",
    description: "Open a visible checkpoint asking a person to resolve cited entities. It cannot choose, approve, merge, or close the issue itself.",
    mutating: true,
    humanCheckpoint: true,
    requiresCase: true,
    permission: "collaboration:request_review",
    phases: ["collaboration"],
    requiredPort: "presentation.requestHumanCheckpoint",
    execute: async (input, { actor: invocationActor, signal }) =>
      unwrapPortResult(
        await ports.presentation.requestHumanCheckpoint({
          type: "entity_resolution",
          ...input,
          actor: invocationActor,
          signal,
        }),
      ),
  });
  add("create_branch", {
    family: "collaboration",
    description: "Create a labeled hypothetical branch from an audited revision. It does not merge into the canonical decision.",
    mutating: true,
    decisionMutation: true,
    requiresCase: true,
    permission: "decision:branch",
    phases: ["collaboration"],
    execute: commandExecutor(ports, "decision.createBranch"),
  });

  const outputTools = [
    ["preview_decision_packet", "previewDecisionPacket", false, "Preview a cited decision report without downloading, publishing, or changing the case."],
    ["export_case", "exportCase", true, "Prepare a visible local export of the current case revision. It cannot publish or send the export externally."],
    ["draft_request", "draftRequest", true, "Draft a source-linked request for information or review. It cannot send the request."],
    ["prepare_external_action", "prepareExternalAction", true, "Prepare a visible external-action draft for human review. It cannot submit, approve, or execute the action."],
  ];
  for (const [name, method, mutating, description] of outputTools) {
    add(name, {
      family: "output",
      description,
      mutating,
      humanCheckpoint: mutating,
      requiresCase: true,
      permission: mutating ? "case:export" : "case:read",
      phases: ["output"],
      requiredPort: `outputs.${method}`,
      untrusted: true,
      execute: async (input, { actor: invocationActor, signal }) =>
        unwrapPortResult(await ports.outputs[method](input, { actor: invocationActor, signal })),
    });
  }

  return specs;
}
