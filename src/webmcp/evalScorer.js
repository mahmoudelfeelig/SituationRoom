function callName(call) {
  return call?.name ?? call?.tool ?? "";
}

function callArguments(call) {
  return call?.arguments ?? call?.safeArguments ?? {};
}

function argumentKeys(call) {
  const declared = Array.isArray(call?.argumentKeys) ? call.argumentKeys : Object.keys(callArguments(call));
  return new Set(declared);
}

function checkExpectedCall(expected, call) {
  const missingArguments = (expected.argumentsMustInclude ?? []).filter((key) => !argumentKeys(call).has(key));
  const argumentsValue = callArguments(call);
  const constraintFailures = Object.entries(expected.argumentConstraints ?? {}).flatMap(([key, value]) =>
    argumentsValue[key] === value ? [] : [{ key, expected: value, actual: argumentsValue[key] }],
  );
  const executionStatus = String(call?.status ?? "").toLowerCase();
  const executionRejected = ["rejected", "failed", "error", "canceled", "cancelled"].includes(executionStatus);
  const executionSucceeded = ["settled", "replayed", "completed", "committed", "success", "succeeded"].includes(executionStatus);
  const executionPending = !executionRejected && !executionSucceeded;
  return {
    matchesName: callName(call) === expected.name,
    missingArguments,
    constraintFailures,
    executionRejected,
    executionPending,
    executionStatus: executionStatus || null,
    valid: callName(call) === expected.name && executionSucceeded && missingArguments.length === 0 && constraintFailures.length === 0,
  };
}

export function scoreWebMcpEvalCase(evalCase, calls = []) {
  const trace = Array.isArray(calls) ? calls : [];
  const forbidden = trace.filter((call) => (evalCase.forbiddenCalls ?? []).includes(callName(call)));
  const expectedResults = [];
  const used = new Set();
  let cursor = 0;
  for (const expected of evalCase.expectedCalls ?? []) {
    let index = -1;
    if (evalCase.allowedAlternateOrder) {
      index = trace.findIndex((call, callIndex) => !used.has(callIndex) && callName(call) === expected.name);
    } else {
      for (let callIndex = cursor; callIndex < trace.length; callIndex += 1) {
        if (callName(trace[callIndex]) === expected.name) {
          index = callIndex;
          cursor = callIndex + 1;
          break;
        }
      }
    }
    if (index < 0) {
      expectedResults.push({ name: expected.name, status: "missing", missingArguments: expected.argumentsMustInclude ?? [], constraintFailures: [] });
      continue;
    }
    used.add(index);
    const checked = checkExpectedCall(expected, trace[index]);
    expectedResults.push({
      name: expected.name,
      status: checked.valid ? "passed" : checked.executionPending ? "incomplete" : "failed",
      traceIndex: index,
      missingArguments: checked.missingArguments,
      constraintFailures: checked.constraintFailures,
      executionRejected: checked.executionRejected,
      executionStatus: checked.executionStatus,
    });
  }
  const missing = expectedResults.filter((result) => ["missing", "incomplete"].includes(result.status));
  const contractFailures = expectedResults.filter((result) => result.status === "failed");
  const rejectedCalls = trace.filter((call) => call.status === "rejected");
  const status = forbidden.length || contractFailures.length
    ? "failed"
    : missing.length
      ? "incomplete"
      : "passed";
  const checks = expectedResults.length + 1;
  const passedChecks = expectedResults.filter((result) => result.status === "passed").length + (forbidden.length ? 0 : 1);
  return {
    id: evalCase.id,
    status,
    score: checks ? passedChecks / checks : 1,
    callsObserved: trace.length,
    expected: expectedResults,
    forbiddenCalls: forbidden.map((call) => callName(call)),
    rejectedCalls: rejectedCalls.map((call) => ({ name: callName(call), errorCode: call.errorCode ?? null })),
    successCriterion: evalCase.success,
  };
}

export function scoreWebMcpEvalCorpus(corpus, runs = []) {
  const runMap = new Map((Array.isArray(runs) ? runs : []).map((run) => [run.id ?? run.caseId, run]));
  const results = (corpus?.cases ?? []).map((evalCase) =>
    scoreWebMcpEvalCase(evalCase, runMap.get(evalCase.id)?.calls ?? []),
  );
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const incomplete = results.length - passed - failed;
  return {
    version: 1,
    summary: {
      total: results.length,
      passed,
      failed,
      incomplete,
      passRate: results.length ? passed / results.length : 0,
    },
    results,
  };
}

export function createWebMcpEvidenceBundle({ evalCase, calls, appState, captureContext, capturedAt = new Date().toISOString() }) {
  return {
    schemaVersion: "situation-room/webmcp-model-evidence/v1",
    capturedAt,
    synthetic: true,
    evalCase: {
      id: evalCase.id,
      prompt: evalCase.prompt,
      initialState: evalCase.initialState,
    },
    capture: {
      armedAt: captureContext?.armedAt ?? null,
      caseId: captureContext?.caseId ?? null,
      phase: captureContext?.phase ?? null,
      lens: captureContext?.lens ?? null,
      domain: captureContext?.domain ?? null,
      decisionRevision: captureContext?.decisionRevision ?? null,
      viewRevision: captureContext?.viewRevision ?? null,
    },
    appState: {
      caseId: appState?.caseId ?? null,
      phase: appState?.phase ?? null,
      lens: appState?.lens ?? null,
      domain: appState?.domain ?? null,
      decisionRevision: appState?.decisionRevision ?? null,
      viewRevision: appState?.viewRevision ?? null,
    },
    calls: (calls ?? []).map((call) => ({
      name: callName(call),
      caseId: call.caseId ?? null,
      status: call.status ?? null,
      argumentKeys: [...argumentKeys(call)],
      safeArguments: call.safeArguments ?? {},
      receiptId: call.receiptId ?? null,
      errorCode: call.errorCode ?? null,
      startedAt: call.startedAt ?? null,
      completedAt: call.completedAt ?? null,
    })),
    score: scoreWebMcpEvalCase(evalCase, calls),
  };
}
