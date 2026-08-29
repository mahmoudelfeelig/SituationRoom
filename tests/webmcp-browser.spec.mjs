import { expect, test } from "@playwright/test";

const PROHIBITED_TOOL_NAME = /(approve|purchase|send|submit|underwrite|adjudicate|reject_candidate|delete_case)/i;

async function waitForIntegratedRoom(page) {
  await expect.poll(
    async () => page.evaluate(() => ({
      bridgeType: typeof window.__situationRoom,
      bootStatus: window.__situationRoom?.getState?.().bootStatus ?? null,
      gatewayAvailable: window.__situationRoom?.gateway?.snapshot?.().available ?? false,
    })),
    {
      timeout: 15_000,
      message: "The page-owned WebMCP bootstrap must settle and expose the integrated room bridge.",
    },
  ).toEqual({ bridgeType: "object", bootStatus: "ready", gatewayAvailable: true });
  await expect.poll(async () => (await discover(page)).length).toBeGreaterThan(0);
}

async function discover(page) {
  return page.evaluate(async () => {
    const tools = await document.modelContext.getTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchemaType: typeof tool.inputSchema,
      inputSchema: typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema,
      readOnlyHint: tool.annotations?.readOnlyHint,
    }));
  });
}

async function toolNames(page) {
  return (await discover(page)).map((tool) => tool.name);
}

async function executeTool(page, name, input) {
  return page.evaluate(
    async ({ toolName, args }) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`Tool is not registered: ${toolName}`);
      const serialized = await document.modelContext.executeTool(tool, JSON.stringify(args));
      return { resultType: typeof serialized, parsed: JSON.parse(serialized) };
    },
    { toolName: name, args: input },
  );
}

async function appSnapshot(page) {
  return page.evaluate(async () => {
    const room = window.__situationRoom.getState();
    const [workspace, presentation] = await Promise.all([
      window.__situationRoom.ports.runtime.getWorkspaceState(),
      window.__situationRoom.ports.presentation.getPresentationSnapshot(),
    ]);
    return {
      activeCaseId: room.activeCase.id,
      domainId: room.activeCase.domain.packId,
      activeCaseJson: JSON.stringify(room.activeCase),
      capabilityPhase: room.capabilityPhase,
      frozen: room.frozen,
      decisionRevision: workspace.decisionRevision,
      decisionHash: workspace.decisionHash,
      viewRevision: room.viewRevision,
      viewHash: presentation.viewHash,
      lens: room.lens,
      outputArtifactCount: room.outputArtifacts.length,
      reviewArtifactCount: room.reviewArtifacts.length,
      presentation,
    };
  });
}

function instrumentTypesByLens(tools) {
  const schema = tools.find((tool) => tool.name === "compose_decision_room")?.inputSchema;
  expect(schema?.oneOf).toHaveLength(4);
  return Object.fromEntries(schema.oneOf.map((branch) => [
    branch.properties.lens.const,
    {
      layoutId: branch.properties.layoutId.const,
      instrumentTypes: branch.properties.instruments.items.properties.type.enum,
    },
  ]));
}

function expectReadOnlyReceipt(result, snapshot) {
  expect(result.parsed.ok).toBe(true);
  expect(result.parsed.receipt.revisionBefore).toBe(snapshot.decisionRevision);
  expect(result.parsed.receipt.revisionAfter).toBe(snapshot.decisionRevision);
  expect(result.parsed.receipt.viewRevisionBefore).toBe(snapshot.viewRevision);
  expect(result.parsed.receipt.viewRevisionAfter).toBe(snapshot.viewRevision);
  expect(result.parsed.meta?.outputTruncated).not.toBe(true);
  expect(JSON.stringify(result.parsed).length).toBeLessThanOrEqual(1_400);
}

function expectWorkspaceUnchanged(after, before) {
  expect(after.activeCaseJson).toBe(before.activeCaseJson);
  expect(after.decisionRevision).toBe(before.decisionRevision);
  expect(after.decisionHash).toBe(before.decisionHash);
  expect(after.viewRevision).toBe(before.viewRevision);
  expect(after.viewHash).toBe(before.viewHash);
  expect(after.lens).toBe(before.lens);
  expect(after.outputArtifactCount).toBe(before.outputArtifactCount);
  expect(after.reviewArtifactCount).toBe(before.reviewArtifactCount);
}

async function openRoomControls(page) {
  const toggle = page.getByRole("button", { name: "Room controls", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator("#os-utility-menu")).toHaveClass(/is-open/);
}

async function clickRoomControl(page, name) {
  await openRoomControls(page);
  await page.locator("#os-utility-menu").getByRole("button", { name }).click();
}

async function openNewDecision(page) {
  const link = page.locator(".os-new-docket");
  if (await link.isVisible()) await link.click();
  else await clickRoomControl(page, /New decision/);
  await expect(page).toHaveURL(/\/new$/);
}

async function selectWorkflowPhase(page, label, expectedPhase) {
  await page.locator(".os-workflow-tabs a", { hasText: label }).click();
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.getState().capabilityPhase)).toBe(expectedPhase);
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.gateway.context?.phase)).toBe(expectedPhase);
}

function assertNoProhibitedNames(tools) {
  expect(tools.filter((tool) => PROHIBITED_TOOL_NAME.test(tool.name))).toEqual([]);
}

test("the real page owns WebMCP discovery, governed phase changes, view-only composition, output drafts, and freeze retirement", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const api = await page.evaluate(() => ({
    registerTool: typeof document.modelContext?.registerTool,
    getTools: typeof document.modelContext?.getTools,
    executeTool: typeof document.modelContext?.executeTool,
  }));
  expect(api).toEqual({ registerTool: "function", getTools: "function", executeTool: "function" });
  await waitForIntegratedRoom(page);

  const observedTools = [];
  const initialTools = await discover(page);
  observedTools.push(...initialTools);
  expect(initialTools.every((tool) => tool.inputSchemaType === "string")).toBe(true);
  expect(initialTools.map((tool) => tool.name)).toContain("compose_decision_room");
  expect(initialTools.map((tool) => tool.name)).toContain("query_decision_graph");
  assertNoProhibitedNames(initialTools);

  const initial = await appSnapshot(page);
  expect(initial.capabilityPhase).toBe("analysis");
  expect(initial.frozen).toBe(false);
  expect(initial.domainId).toBe("procurement");

  const instruments = instrumentTypesByLens(initialTools);
  expect(instruments).toEqual({
    investigate: {
      layoutId: "trace",
      instrumentTypes: [
        "protected-invariants",
        "pinned-context",
        "compliance-gate-wall",
        "evidence-excerpt",
        "claim-interpretation",
        "constraint-gate",
        "outcome-seal",
        "contradiction-docket",
        "missing-evidence",
      ],
    },
    compare: {
      layoutId: "matrix",
      instrumentTypes: [
        "protected-invariants",
        "pinned-context",
        "compliance-gate-wall",
        "comparison-matrix",
        "score-breakdown",
        "metric-waterfall",
        "risk-frontier",
      ],
    },
    simulate: {
      layoutId: "fork",
      instrumentTypes: [
        "protected-invariants",
        "pinned-context",
        "concession-set",
        "outcome-seal",
        "scenario-controls",
        "sensitivity-plot",
      ],
    },
    brief: {
      layoutId: "council",
      instrumentTypes: [
        "protected-invariants",
        "pinned-context",
        "tco-waterfall",
        "stakeholder-mandate",
        "decision-brief",
        "outcome-seal",
        "evidence-excerpt",
        "risk-frontier",
      ],
    },
  });
  for (const lens of Object.values(instruments)) {
    expect(lens.instrumentTypes).not.toEqual(expect.arrayContaining([
      "candidate-requirement-coverage",
      "bias-shield",
      "plan-cost-waterfall",
      "weighted-criteria",
    ]));
  }

  const workspace = await executeTool(page, "get_workspace_state", {});
  expect(workspace.resultType).toBe("string");
  expect(workspace.parsed.ok).toBe(true);
  expect(workspace.parsed.data.phase).toBe("analysis");
  expect(workspace.parsed.data.sharedAuthorityAvailable).toBe(true);
  expect(workspace.parsed.data.governedAgentMutationsBlocked).toBe(false);
  expect(workspace.parsed.data.governanceVersion).toBeGreaterThanOrEqual(0);
  expect(workspace.parsed.state.caseId).toBe(initial.activeCaseId);
  expect(workspace.parsed.state.decisionRevision).toBe(initial.decisionRevision);
  expect(JSON.stringify(workspace.parsed).length).toBeLessThanOrEqual(1_400);

  const alternative = initial.presentation.entities.find((entity) => entity.kind === "alternative");
  expect(alternative).toBeTruthy();
  const composed = await executeTool(page, "compose_decision_room", {
    caseId: initial.activeCaseId,
    recipeVersion: 1,
    intent: "compare",
    lens: "compare",
    question: "Compare the verified alternatives against the same criteria.",
    framing: "Keep protected constraints and cited trade-offs visible.",
    layoutId: "matrix",
    density: "balanced",
    instruments: [
      {
        id: "browser-comparison",
        type: "comparison-matrix",
        region: "primary",
        priority: 90,
        entityRefs: [{ kind: "alternative", id: alternative.id }],
        options: {},
      },
    ],
    focusPathIds: [],
    expectedDecisionRevision: initial.decisionRevision,
    expectedViewRevision: initial.viewRevision,
    idempotencyKey: "real-browser-compose-0001",
  });
  expect(composed.parsed.ok).toBe(true);
  expect(composed.parsed.receipt.revisionBefore).toBe(initial.decisionRevision);
  expect(composed.parsed.receipt.revisionAfter).toBe(initial.decisionRevision);
  expect(composed.parsed.receipt.viewRevisionBefore).toBe(initial.viewRevision);
  expect(composed.parsed.receipt.viewRevisionAfter).toBe(initial.viewRevision + 1);
  expect(composed.parsed.ui.settled).toBe(true);

  const afterCompose = await appSnapshot(page);
  expect(afterCompose.activeCaseJson).toBe(initial.activeCaseJson);
  expect(afterCompose.decisionRevision).toBe(initial.decisionRevision);
  expect(afterCompose.decisionHash).toBe(initial.decisionHash);
  expect(afterCompose.viewRevision).toBe(initial.viewRevision + 1);
  expect(afterCompose.viewHash).not.toBe(initial.viewHash);
  expect(afterCompose.lens).toBe("compare");
  await expect(page.locator(".os-header-ledger")).toContainText(`v${afterCompose.viewRevision}`);

  await expect.poll(async () => toolNames(page)).toContain("evaluate_alternatives");
  const compareTools = await discover(page);
  observedTools.push(...compareTools);
  assertNoProhibitedNames(compareTools);

  const simulated = await executeTool(page, "compose_decision_room", {
    caseId: afterCompose.activeCaseId,
    recipeVersion: 1,
    intent: "simulate",
    lens: "simulate",
    question: "Stress Northstar deployment against the mandatory launch window.",
    framing: "Keep canonical and hypothetical outcomes separate.",
    layoutId: "fork",
    density: "balanced",
    instruments: [{
      id: "browser-scenario-controls",
      type: "scenario-controls",
      region: "secondary",
      priority: 90,
      entityRefs: [
        { kind: "alternative", id: "vendor-a" },
        { kind: "criterion", id: "r3" },
      ],
      options: { metricIds: ["r3"] },
    }],
    focusPathIds: [],
    expectedDecisionRevision: afterCompose.decisionRevision,
    expectedViewRevision: afterCompose.viewRevision,
    idempotencyKey: "real-browser-simulate-0001",
  });
  expect(simulated.parsed.ok).toBe(true);
  expect(simulated.parsed.receipt.revisionBefore).toBe(afterCompose.decisionRevision);
  expect(simulated.parsed.receipt.revisionAfter).toBe(afterCompose.decisionRevision);
  expect(simulated.parsed.receipt.viewRevisionBefore).toBe(afterCompose.viewRevision);
  expect(simulated.parsed.receipt.viewRevisionAfter).toBe(afterCompose.viewRevision + 1);

  const beforeAnalysis = await appSnapshot(page);
  expect(beforeAnalysis.activeCaseJson).toBe(afterCompose.activeCaseJson);
  expect(beforeAnalysis.decisionHash).toBe(afterCompose.decisionHash);
  expect(beforeAnalysis.decisionRevision).toBe(afterCompose.decisionRevision);
  expect(beforeAnalysis.viewRevision).toBe(afterCompose.viewRevision + 1);
  expect(beforeAnalysis.lens).toBe("simulate");
  await expect.poll(async () => toolNames(page)).toEqual(expect.arrayContaining([
    "run_scenario",
    "run_sensitivity",
    "solve_minimum_change",
  ]));
  const simulateTools = await discover(page);
  observedTools.push(...simulateTools);
  assertNoProhibitedNames(simulateTools);

  const savedScenario = await executeTool(page, "run_scenario", {
    caseId: beforeAnalysis.activeCaseId,
    scenarioId: "procurement-scenario:deployment-delay",
    alternativeIds: ["vendor-a"],
  });
  expectReadOnlyReceipt(savedScenario, beforeAnalysis);
  expect(savedScenario.parsed.data).toMatchObject({
    analysisKind: "saved_scenario_evaluation",
    supported: true,
    originalDecisionUnchanged: true,
    hashesMatch: true,
    scenarioId: "procurement-scenario:deployment-delay",
    savedScenarioApplied: true,
    savedOverrideCount: 1,
    appliedOverrides: [],
    results: [{ alternativeId: "vendor-a", eligible: false, score: 71, blockers: ["r3"] }],
  });

  const scenario = await executeTool(page, "run_scenario", {
    caseId: beforeAnalysis.activeCaseId,
    alternativeIds: ["vendor-a"],
    overrides: [{ metricId: "r3", value: 13, unit: "weeks" }],
  });
  expectReadOnlyReceipt(scenario, beforeAnalysis);
  expect(scenario.parsed.data).toMatchObject({
    analysisKind: "transient_typed_scenario",
    supported: true,
    originalDecisionUnchanged: true,
    hashesMatch: true,
    appliedOverrides: [{ metricId: "r3", value: 13, unit: "weeks", alternativeIds: ["vendor-a"] }],
    results: [{ alternativeId: "vendor-a", eligible: false, score: 71, blockers: ["r3"] }],
  });

  const sensitivity = await executeTool(page, "run_sensitivity", {
    caseId: beforeAnalysis.activeCaseId,
    alternativeIds: ["vendor-a"],
    metricIds: ["r3"],
    samples: 10,
  });
  expectReadOnlyReceipt(sensitivity, beforeAnalysis);
  expect(sensitivity.parsed.data).toMatchObject({
    analysisKind: "deterministic_one_at_a_time_sweep",
    supported: true,
    sampled: true,
    originalDecisionUnchanged: true,
    alternativeIds: ["vendor-a"],
    sweeps: [{
      metricId: "r3",
      range: { min: 8, max: 14, step: null, unit: "weeks", source: "criterion.scoring.linear" },
      sampleCount: 10,
    }],
  });
  const sensitivitySamples = sensitivity.parsed.data.sweeps[0].representativeSamples;
  expect(sensitivitySamples[0]).toMatchObject({
    value: 8,
    outcomes: [{ alternativeId: "vendor-a", score: 87, eligible: true, blockerCount: 0 }],
  });
  expect(sensitivitySamples.at(-1)).toMatchObject({
    value: 14,
    outcomes: [{ alternativeId: "vendor-a", score: 67, eligible: false, blockerCount: 1 }],
  });

  const minimumChange = await executeTool(page, "solve_minimum_change", {
    caseId: beforeAnalysis.activeCaseId,
    alternativeId: "vendor-b",
    targetStatus: "eligible",
    lockedMetricIds: [],
  });
  expectReadOnlyReceipt(minimumChange, beforeAnalysis);
  expect(minimumChange.parsed.data).toMatchObject({
    analysisKind: "deterministic_minimum_change_search",
    supported: true,
    minimumChangeFound: true,
    exactWithinTrustedDomain: true,
    originalDecisionUnchanged: true,
    alternativeId: "vendor-b",
    baseline: { eligible: false, score: 38, blockers: ["r1", "r4"] },
    result: { eligible: true, score: 71, blockers: [] },
  });
  expect(minimumChange.parsed.data.changes.map((entry) => [entry.metricId, entry.from, entry.to])).toEqual([
    ["r1", false, true],
    ["r4", 305000, 300000],
  ]);

  expectWorkspaceUnchanged(await appSnapshot(page), beforeAnalysis);

  await selectWorkflowPhase(page, "Model", "contract_draft");
  await expect.poll(async () => toolNames(page)).toContain("propose_decision_contract");
  const modelTools = await discover(page);
  observedTools.push(...modelTools);
  expect(modelTools.map((tool) => tool.name)).not.toContain("compose_decision_room");
  assertNoProhibitedNames(modelTools);

  const beforeProposal = await appSnapshot(page);
  const proposal = await executeTool(page, "propose_decision_contract", {
    caseId: beforeProposal.activeCaseId,
    decisionType: "vendor_selection",
    objective: "Use source-linked gates and transparent cost evidence for human review.",
    affectedParties: ["Decision owner", "Information Security"],
    evidenceThreshold: "source_required",
    uncertaintyPolicy: "request_review",
    prohibitedInputs: ["Uncited assumptions"],
    authority: "human_decides",
    expectedDecisionRevision: beforeProposal.decisionRevision,
    idempotencyKey: "real-browser-contract-proposal-0001",
  });
  expect(proposal.parsed.ok).toBe(true);
  await expect.poll(async () => (await appSnapshot(page)).reviewArtifactCount).toBe(beforeProposal.reviewArtifactCount + 1);
  const afterProposal = await appSnapshot(page);
  expect(afterProposal.activeCaseJson).toBe(beforeProposal.activeCaseJson);
  expect(afterProposal.decisionRevision).toBe(beforeProposal.decisionRevision);
  expect(afterProposal.decisionHash).toBe(beforeProposal.decisionHash);

  await selectWorkflowPhase(page, "Review", "collaboration");
  await expect.poll(async () => toolNames(page)).toContain("comment_on_entity");
  await expect(page.locator(".review-artifact-strip")).toContainText("Contract activation and authority changes require a human-reviewed canonical contract replacement.");
  const proposalRow = page.locator(".review-artifact-strip li").filter({ hasText: "decision proposeContract" }).first();
  await proposalRow.getByRole("button", { name: "Review in model" }).click();
  await expect(page.getByRole("heading", { name: "Decision model editor" })).toBeVisible();
  await expect(page.locator(".model-proposal-brief")).toContainText("Use source-linked gates and transparent cost evidence for human review.");
  const duringHumanReview = await appSnapshot(page);
  expect(duringHumanReview.activeCaseJson).toBe(beforeProposal.activeCaseJson);
  expect(duringHumanReview.decisionHash).toBe(beforeProposal.decisionHash);
  await page.getByRole("button", { name: "Return to review" }).click();
  await expect(page.getByRole("heading", { name: "Review exchange" })).toBeVisible();
  await proposalRow.getByRole("button", { name: "Reject proposal" }).click();
  await expect(proposalRow).toContainText("rejected by human");
  expect((await appSnapshot(page)).activeCaseJson).toBe(beforeProposal.activeCaseJson);
  const collaborationTools = await discover(page);
  observedTools.push(...collaborationTools);
  expect(collaborationTools.map((tool) => tool.name)).toContain("create_branch");
  assertNoProhibitedNames(collaborationTools);

  await selectWorkflowPhase(page, "Outputs", "output");
  await expect.poll(async () => toolNames(page)).toContain("export_case");
  const outputTools = await discover(page);
  observedTools.push(...outputTools);
  expect(outputTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
    "preview_decision_packet",
    "export_case",
    "draft_request",
    "prepare_external_action",
  ]));
  assertNoProhibitedNames(outputTools);

  const beforeExport = await appSnapshot(page);
  const exported = await executeTool(page, "export_case", {
    caseId: beforeExport.activeCaseId,
    format: "json",
    expectedDecisionRevision: beforeExport.decisionRevision,
    idempotencyKey: "real-browser-export-0001",
  });
  expect(exported.parsed.ok).toBe(true);
  expect(exported.parsed.receipt.revisionBefore).toBe(beforeExport.decisionRevision);
  expect(exported.parsed.receipt.revisionAfter).toBe(beforeExport.decisionRevision);
  const afterExport = await appSnapshot(page);
  expect(afterExport.outputArtifactCount).toBe(beforeExport.outputArtifactCount + 1);
  expect(afterExport.activeCaseJson).toBe(beforeExport.activeCaseJson);
  expect(afterExport.decisionHash).toBe(beforeExport.decisionHash);
  expect(afterExport.decisionRevision).toBe(beforeExport.decisionRevision);
  expect(afterExport.viewRevision).toBe(beforeExport.viewRevision);
  await expect(page.locator(".prepared-output-ledger")).toContainText("agent");

  const drafted = await executeTool(page, "draft_request", {
    caseId: afterExport.activeCaseId,
    purpose: "Clarify the disputed incident-response evidence with an exact source reference.",
    recipientRole: "Information Security reviewer",
    entityRefs: [{ kind: "alternative", id: alternative.id }],
    expectedDecisionRevision: afterExport.decisionRevision,
    idempotencyKey: "real-browser-draft-request-0001",
  });
  expect(drafted.parsed.ok).toBe(true);
  await expect.poll(async () => (await appSnapshot(page)).reviewArtifactCount).toBe(afterExport.reviewArtifactCount + 1);
  const afterDraft = await appSnapshot(page);
  expect(afterDraft.activeCaseJson).toBe(afterExport.activeCaseJson);
  expect(afterDraft.decisionHash).toBe(afterExport.decisionHash);
  expect(afterDraft.decisionRevision).toBe(afterExport.decisionRevision);

  const beforeDeniedAction = afterDraft.outputArtifactCount;
  const deniedPurchase = await executeTool(page, "prepare_external_action", {
    caseId: afterExport.activeCaseId,
    actionType: "purchase",
    summary: "Purchase the recommended option immediately.",
    entityRefs: [{ kind: "alternative", id: alternative.id }],
    expectedDecisionRevision: afterExport.decisionRevision,
    idempotencyKey: "real-browser-purchase-denied",
  });
  expect(deniedPurchase.parsed.ok).toBe(false);
  expect(deniedPurchase.parsed.error.code).toBe("POLICY_DENIED");
  expect((await appSnapshot(page)).outputArtifactCount).toBe(beforeDeniedAction);

  await clickRoomControl(page, "Freeze");
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.getState().frozen)).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.gateway.context?.phase)).toBe("frozen");
  await expect.poll(async () => toolNames(page)).not.toContain("export_case");
  const frozenTools = await discover(page);
  observedTools.push(...frozenTools);
  expect(frozenTools.map((tool) => tool.name)).not.toContain("compose_decision_room");
  expect(frozenTools.every((tool) => tool.readOnlyHint === true)).toBe(true);
  assertNoProhibitedNames(frozenTools);

  assertNoProhibitedNames(observedTools);
  expect(pageErrors).toEqual([]);
});

test("request_human_resolution stages a cited Review artifact without opening human approval", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const before = await appSnapshot(page);
  const alternative = before.presentation.entities.find((entity) => entity.kind === "alternative");
  expect(alternative).toBeTruthy();

  await selectWorkflowPhase(page, "Review", "collaboration");
  await expect.poll(async () => toolNames(page)).toContain("request_human_resolution");

  const invented = await executeTool(page, "request_human_resolution", {
    caseId: before.activeCaseId,
    entityRefs: [{ kind: "alternative", id: "invented-alternative" }],
    question: "Please resolve this cited contradiction.",
    expectedDecisionRevision: before.decisionRevision,
    idempotencyKey: "browser-human-resolution-invented-ref",
  });
  expect(invented.parsed.ok).toBe(false);
  expect(invented.parsed.error.code).toBe("NOT_FOUND");
  expect((await appSnapshot(page)).reviewArtifactCount).toBe(before.reviewArtifactCount);

  const question = "Please resolve the cited incident-response contradiction before any human approval.";
  const requested = await executeTool(page, "request_human_resolution", {
    caseId: before.activeCaseId,
    entityRefs: [{ kind: "alternative", id: alternative.id }],
    question,
    expectedDecisionRevision: before.decisionRevision,
    idempotencyKey: "browser-human-resolution-0001",
  });
  expect(requested.parsed.ok).toBe(true);
  expect(requested.parsed.data.availableFields ?? Object.keys(requested.parsed.data)).toEqual(expect.arrayContaining([
    "awaitingHuman",
    "artifact",
  ]));
  const stagedArtifact = await page.evaluate(() => window.__situationRoom.getState().reviewArtifacts[0]);
  expect(stagedArtifact).toMatchObject({
    kind: "human_resolution_request",
    body: question,
    source: "agent",
    status: "awaiting-human",
    entityRefs: [{ kind: "alternative", id: alternative.id }],
  });

  const visibleArtifact = page.locator(".review-artifact-strip li").filter({ hasText: question });
  await expect(visibleArtifact).toBeVisible();
  await expect(visibleArtifact).toContainText("human resolution request");
  await expect(visibleArtifact).toContainText("agent · awaiting human");
  await expect(page.getByRole("dialog", { name: "Commit the human decision" })).toHaveCount(0);

  const after = await appSnapshot(page);
  expect(after.activeCaseJson).toBe(before.activeCaseJson);
  expect(after.decisionRevision).toBe(before.decisionRevision);
  expect(after.decisionHash).toBe(before.decisionHash);
  expect(after.reviewArtifactCount).toBe(before.reviewArtifactCount + 1);

  await expect.poll(async () => toolNames(page)).not.toContain("request_human_resolution");
  const checkpointTools = await discover(page);
  expect(checkpointTools.every((tool) => tool.readOnlyHint === true)).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const restoredArtifact = await page.evaluate(() =>
    window.__situationRoom.getState().reviewArtifacts.find((artifact) => artifact.kind === "human_resolution_request"),
  );
  expect(restoredArtifact).toMatchObject({ id: stagedArtifact.id, status: "awaiting-human", body: question });
  expect(await toolNames(page)).not.toContain("compose_decision_room");
  expect((await discover(page)).every((tool) => tool.readOnlyHint === true)).toBe(true);

  const restoredVisibleArtifact = page.locator(".review-artifact-strip li").filter({ hasText: question });
  await restoredVisibleArtifact.getByLabel("Human response").fill("The cited incident-response evidence was independently verified and the contradiction is closed.");
  await restoredVisibleArtifact.getByRole("button", { name: "Resolve checkpoint" }).click();
  await expect.poll(async () => page.evaluate((artifactId) => {
    const room = window.__situationRoom.getState();
    return {
      pending: room.governance.humanCheckpoints.some((artifact) => artifact.id === artifactId && ["awaiting-human", "under-human-review"].includes(artifact.status)),
      status: room.reviewArtifacts.find((artifact) => artifact.id === artifactId)?.status,
    };
  }, stagedArtifact.id)).toEqual({ pending: false, status: "resolved-by-human" });
  await expect.poll(async () => toolNames(page)).toContain("compose_decision_room");
  expect(pageErrors).toEqual([]);
});

test("a frozen case with a pending human checkpoint normalizes analysis deep links to Review", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const before = await appSnapshot(page);
  const alternative = before.presentation.entities.find((entity) => entity.kind === "alternative");
  expect(alternative).toBeTruthy();

  await selectWorkflowPhase(page, "Review", "collaboration");
  const requested = await executeTool(page, "request_human_resolution", {
    caseId: before.activeCaseId,
    entityRefs: [{ kind: "alternative", id: alternative.id }],
    question: "Resolve the cited contradiction before analysis continues.",
    expectedDecisionRevision: before.decisionRevision,
    idempotencyKey: "browser-frozen-pending-route-normalization",
  });
  expect(requested.parsed.ok).toBe(true);
  await clickRoomControl(page, "Freeze");
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.getState().frozen)).toBe(true);

  await page.goto(`/cases/${before.activeCaseId}/analyze/compare`, { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  await expect(page).toHaveURL(new RegExp(`/cases/${before.activeCaseId}/review$`));
  await expect.poll(async () => page.evaluate(() => window.__situationRoom.getState().capabilityPhase)).toBe("collaboration");
  await expect(page.locator(".collaboration-desk")).toHaveCount(1);
  await expect(page.locator(".compiled-room-view, .os-question-rail, .os-history-rail")).toHaveCount(0);
});

test("shared freeze authority propagates across tabs and rejects a stale direct mutation", async ({ page, context }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const peer = await context.newPage();
  try {
    await peer.goto("/", { waitUntil: "domcontentloaded" });
    await waitForIntegratedRoom(peer);
    const before = await appSnapshot(peer);

    await clickRoomControl(page, "Freeze");
    await expect.poll(async () => peer.evaluate(() => ({
      frozen: window.__situationRoom.getState().frozen,
      phase: window.__situationRoom.gateway.context?.phase,
    }))).toEqual({ frozen: true, phase: "frozen" });
    expect((await discover(peer)).every((tool) => tool.readOnlyHint === true)).toBe(true);

    const directMutation = await peer.evaluate(async ({ caseId, revision }) => {
      try {
        await window.__situationRoom.ports.runtime.executeCommand({
          type: "decision.upsertAlternative",
          caseId,
          payload: {
            alternativeId: "stale-tab-option",
            label: "Stale tab option",
            description: "Must never be committed while shared governance is frozen.",
          },
        }, {
          caseId,
          expectedRevision: revision,
          idempotencyKey: "cross-tab-freeze-direct-mutation",
          actor: { type: "agent", id: "cross-tab-test" },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    }, { caseId: before.activeCaseId, revision: before.decisionRevision });
    expect(directMutation).toMatchObject({ ok: false, code: "CASE_FROZEN" });
    expect((await appSnapshot(peer)).activeCaseJson).toBe(before.activeCaseJson);

    await clickRoomControl(page, "Frozen");
    await expect.poll(async () => peer.evaluate(() => window.__situationRoom.getState().frozen)).toBe(false);
    await expect.poll(async () => toolNames(peer)).toContain("compose_decision_room");
  } finally {
    await peer.close();
  }
});

test("session-only fallback stays usable, retires governed agent mutations, and can reset", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const fallback = await page.evaluate(() => ({
    mode: window.__situationRoom.getState().persistenceMode,
    warning: window.__situationRoom.getState().persistenceWarning,
    frozenForHuman: window.__situationRoom.getState().frozen,
    gatewayPhase: window.__situationRoom.gateway.context?.phase,
  }));
  expect(fallback).toMatchObject({ mode: "session-only", frozenForHuman: false, gatewayPhase: "frozen" });
  expect(fallback.warning).toMatch(/Cross-tab authority is unavailable.*agent mutations are disabled/i);
  await expect(page.getByRole("alert")).toContainText("Session-only workspace");
  const sessionWorkspace = await executeTool(page, "get_workspace_state", {});
  expect(sessionWorkspace.parsed.data.sharedAuthorityAvailable).toBe(false);
  expect(sessionWorkspace.parsed.data.governedAgentMutationsBlocked).toBe(true);
  expect((await discover(page)).every((tool) => tool.readOnlyHint === true)).toBe(true);

  await clickRoomControl(page, "Reset demo");
  const resetDialog = page.getByRole("dialog", { name: "Reset the local demonstration" });
  await expect(resetDialog).toBeVisible();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    resetDialog.getByRole("button", { name: "Erase local workspace and reseed" }).click(),
  ]);
  await waitForIntegratedRoom(page);
  expect(await page.evaluate(() => window.__situationRoom.getState().persistenceMode)).toBe("session-only");
});

test("prepared decision packets retain only the latest twenty durable blobs", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  await selectWorkflowPhase(page, "Output", "output");
  const before = await appSnapshot(page);

  for (let index = 0; index < 22; index += 1) {
    const exported = await executeTool(page, "export_case", {
      caseId: before.activeCaseId,
      format: "json",
      expectedDecisionRevision: before.decisionRevision,
      idempotencyKey: `bounded-output-retention-${String(index).padStart(2, "0")}`,
    });
    expect(exported.parsed.ok).toBe(true);
  }
  expect(await page.evaluate(() => window.__situationRoom.getState().outputArtifacts.length)).toBe(20);
  const outputPager = page.getByRole("navigation", { name: "Prepared output pages" });
  await expect(outputPager).toContainText("Page 1 of 5 · 20 artifacts");
  await outputPager.getByRole("button", { name: "Next" }).click();
  await expect(outputPager).toContainText("Page 2 of 5 · 20 artifacts");
  const durableOutputCount = await page.evaluate(async (caseId) => {
    const request = indexedDB.open("situation-room-os-v2", 2);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(["blobs"]);
      const keysRequest = transaction.objectStore("blobs").getAllKeys();
      const keys = await new Promise((resolve, reject) => {
        keysRequest.onsuccess = () => resolve(keysRequest.result);
        keysRequest.onerror = () => reject(keysRequest.error);
      });
      return keys.filter((key) => String(key).startsWith(`output:${caseId}:`)).length;
    } finally {
      database.close();
    }
  }, before.activeCaseId);
  expect(durableOutputCount).toBe(20);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  expect(await page.evaluate(() => window.__situationRoom.getState().outputArtifacts.length)).toBe(20);
  await selectWorkflowPhase(page, "Output", "output");
  await expect(page.getByRole("navigation", { name: "Prepared output pages" })).toContainText("Page 1 of 5 · 20 artifacts");
});

test("a real WebMCP candidate import reopens the same explicit human review after reload and commits safely", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  await openNewDecision(page);
  const dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "candidate-evidence.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([
      "candidate,gender,date_of_birth,typescript_years",
      "Candidate A,woman,1990-01-02,6",
      "Candidate B,man,1989-03-04,4",
    ].join("\n")),
  });
  const sourceId = await dialog.locator(".os-staged-files li").getAttribute("data-source-id");
  expect(sourceId).toMatch(/^staged:/);
  expect(sourceId).not.toMatch(/candidate|evidence/i);
  await dialog.getByRole("button", { name: "Confirm Candidate review domain" }).click();
  await expect.poll(async () => toolNames(page)).toContain("start_import");

  const mismatchedDomain = await executeTool(page, "start_import", {
    caseId: "candidate-review-demo",
    sourceIds: [sourceId],
    domainHint: "generic",
    idempotencyKey: "browser-candidate-domain-mismatch-0001",
  });
  expect(mismatchedDomain.parsed.ok).toBe(false);
  expect(mismatchedDomain.parsed.error.code).toBe("POLICY_DENIED");

  const started = await executeTool(page, "start_import", {
    sourceIds: [sourceId],
    domainHint: "candidate-review",
    idempotencyKey: "browser-candidate-import-0001",
  });
  expect(started.parsed.ok).toBe(true);
  await expect(dialog.getByRole("heading", { name: "Decision Contract" })).toBeVisible({ timeout: 20_000 });
  const beforeReload = await page.evaluate(() => {
    const review = window.__situationRoom.getState().activeImportReview;
    return {
      jobId: review.job.id,
      caseId: review.caseId,
      criteria: review.proposal.caseInput.criteria.map((entry) => entry.label),
      alternatives: review.proposal.caseInput.alternatives.map((entry) => entry.label),
      evidenceText: review.documents.flatMap((document) => document.blocks.map((block) => block.text)),
    };
  });
  expect(beforeReload.criteria).toEqual(["typescript_years"]);
  expect(beforeReload.alternatives).toEqual(["Candidate A", "Candidate B"]);
  expect(beforeReload.evidenceText).not.toContain("woman");
  expect(beforeReload.evidenceText).not.toContain("1990-01-02");
  expect(beforeReload.evidenceText).toContain("[protected field redacted]");

  const sourceProjection = await page.evaluate(() => {
    const document = window.__situationRoom.getState().activeImportReview.documents[0];
    return {
      documentId: document.id,
      redactedAnchor: document.blocks.find((block) => block.text === "[protected field redacted]")?.id,
      safeAnchor: document.blocks.find((block) => /typescript/i.test(block.text))?.id,
    };
  });
  expect(sourceProjection.redactedAnchor).toBeTruthy();
  expect(sourceProjection.safeAnchor).toBeTruthy();
  await expect.poll(async () => toolNames(page)).toContain("inspect_document");
  const { documentId } = sourceProjection;
  const inspected = await executeTool(page, "inspect_document", {
    caseId: beforeReload.caseId,
    jobId: beforeReload.jobId,
    documentId,
    includeRegions: true,
    limit: 1,
  });
  expect(inspected.parsed.ok).toBe(true);
  const inspectedJson = JSON.stringify(inspected.parsed.data);
  expect(inspectedJson).not.toMatch(/\b(?:woman|man|1990-01-02|1989-03-04)\b/i);

  for (const query of ["woman", "1990-01-02"]) {
    const protectedSearch = await executeTool(page, "search_sources", {
      caseId: beforeReload.caseId,
      jobId: beforeReload.jobId,
      query,
      documentIds: [documentId],
      limit: 20,
    });
    expect(protectedSearch.parsed.ok).toBe(true);
    expect(protectedSearch.parsed.data).toMatchObject({ total: 0, results: [] });
  }

  const safeSearch = await executeTool(page, "search_sources", {
    caseId: beforeReload.caseId,
    jobId: beforeReload.jobId,
    query: "typescript",
    documentIds: [documentId],
    limit: 20,
  });
  expect(safeSearch.parsed.ok).toBe(true);
  expect(safeSearch.parsed.data.total).toBeGreaterThan(0);
  expect(JSON.stringify(safeSearch.parsed.data)).not.toMatch(/\b(?:woman|man|1990-01-02|1989-03-04)\b/i);

  const spans = await executeTool(page, "read_source_spans", {
    caseId: beforeReload.caseId,
    jobId: beforeReload.jobId,
    documentId,
    anchors: [sourceProjection.redactedAnchor],
  });
  expect(spans.parsed.ok).toBe(true);
  const spansJson = JSON.stringify(spans.parsed.data);
  expect(spansJson).not.toMatch(/\b(?:woman|man|1990-01-02|1989-03-04)\b/i);
  expect(spansJson).toContain("[protected field redacted]");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForIntegratedRoom(page);
  const restoredDialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await expect(restoredDialog.getByRole("heading", { name: "Decision Contract" })).toBeVisible({ timeout: 20_000 });
  const restored = await page.evaluate(() => {
    const review = window.__situationRoom.getState().activeImportReview;
    return {
      jobId: review.job.id,
      caseId: review.caseId,
      phase: review.job.phase,
      pendingHumanCheckpoint: Boolean(review),
    };
  });
  expect(restored).toEqual({
    jobId: beforeReload.jobId,
    caseId: beforeReload.caseId,
    phase: "review_required",
    pendingHumanCheckpoint: true,
  });

  await restoredDialog.getByLabel(/I reviewed the complete paginated alternatives/).check();
  await restoredDialog.getByRole("button", { name: "Commit reviewed draft" }).click();
  await expect(restoredDialog).toBeHidden({ timeout: 20_000 });
  const committed = await page.evaluate(async ({ jobId, caseId }) => {
    const room = window.__situationRoom.getState();
    const importJob = await window.__situationRoom.ports.imports.getImport(jobId);
    return {
      activeCaseId: room.activeCase.id,
      revision: room.activeCase.revision,
      criteria: room.activeCase.criteria.map((entry) => entry.label),
      containsProtectedEvidence: room.activeCase.fragments.some(
        (entry) => ["woman", "man", "1990-01-02", "1989-03-04"].includes(entry.text),
      ),
      containsRedaction: room.activeCase.fragments.some((entry) => entry.text === "[protected field redacted]"),
      importPhase: importJob.phase,
      expectedCaseId: caseId,
    };
  }, beforeReload);
  expect(committed).toEqual({
    activeCaseId: beforeReload.caseId,
    revision: 1,
    criteria: ["typescript_years"],
    containsProtectedEvidence: false,
    containsRedaction: true,
    importPhase: "complete",
    expectedCaseId: beforeReload.caseId,
  });
  expect(pageErrors).toEqual([]);
});
