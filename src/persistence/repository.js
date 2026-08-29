export const REPOSITORY_SCHEMA_VERSION = 2;

export const COMMIT_STATUSES = Object.freeze({
  COMMITTED: "committed",
  REPLAYED: "replayed",
  STALE: "stale",
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
  ALREADY_EXISTS: "already_exists",
});

export function receiptKey(caseId, idempotencyKey) {
  return `${caseId}::${idempotencyKey}`;
}

export function eventKey(event) {
  return `${event.caseId}::${String(event.revision).padStart(12, "0")}::${event.id}`;
}

export function assertRepository(repository) {
  const required = [
    "initialize",
    "listCases",
    "getCase",
    "putCase",
    "commitCreateCase",
    "commitCaseCommand",
    "getCommandReceipt",
    "listEvents",
    "getGovernance",
    "commitGovernanceMutation",
    "putImport",
    "createImport",
    "commitImportMutation",
    "getImport",
    "listImports",
    "putDocument",
    "getDocument",
    "listDocuments",
    "deleteDocument",
  ];
  const missing = required.filter((method) => typeof repository?.[method] !== "function");
  if (missing.length) throw new TypeError(`Repository is missing methods: ${missing.join(", ")}`);
  return repository;
}
