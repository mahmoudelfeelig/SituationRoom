import { sha256Hex } from "../kernel/canonicalize.js";

export function makeEvidenceBundle(caseId, entries) {
  const documents = [];
  const fragments = [];
  const refs = new Map();
  entries.forEach((entry, index) => {
    const key = entry.key ?? `source-${index + 1}`;
    const documentId = `${caseId}:doc:${key}`;
    const fragmentId = `${caseId}:fragment:${key}`;
    const text = String(entry.text ?? "");
    documents.push({
      id: documentId,
      name: entry.document ?? `${key}.txt`,
      format: entry.format ?? "text",
      mimeType: entry.mimeType ?? "text/plain",
      byteHash: `sha256:${sha256Hex(text)}`,
      size: new TextEncoder().encode(text).byteLength,
      importedAt: entry.importedAt ?? "2026-08-28T10:00:00.000Z",
      securityStatus: "reviewed",
    });
    fragments.push({
      id: fragmentId,
      documentId,
      kind: entry.kind ?? "paragraph",
      text,
      locator: entry.locator ?? { paragraph: 1 },
      confidence: entry.confidence ?? 1,
    });
    refs.set(key, {
      documentId,
      fragmentId,
      locator: entry.locator ?? { paragraph: 1 },
      quoteHash: `sha256:${sha256Hex(text)}`,
    });
  });
  return { documents, fragments, refs };
}

export function sourceReference(refs, ...keys) {
  return keys.map((key) => refs.get(key)).filter(Boolean);
}

export function defaultMapImportedDocuments(normalizedDocuments) {
  const documents = normalizedDocuments.map((document) => ({
    id: document.id,
    name: document.name,
    format: document.format,
    mimeType: document.mimeType,
    byteHash: document.byteHash,
    size: document.size,
    importedAt: document.importedAt,
    securityStatus: "reviewed",
    importId: document.importId,
    diagnostics: (document.diagnostics ?? []).map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      message: entry.message,
      ...(entry.details === undefined ? {} : { details: entry.details }),
    })),
    trust: {
      sourceContent: "untrusted",
      instructionLike: Boolean(document.trust?.instructionLike),
      externalLinks: Boolean(document.trust?.externalLinks),
      humanAccepted: true,
    },
    ...(
      document.metadata?.tableMapping
        ? {
            metadata: {
              tableMapping: document.metadata.tableMapping,
              ...(document.metadata.tableMappingHash ? { tableMappingHash: document.metadata.tableMappingHash } : {}),
            },
          }
        : {}
    ),
  }));
  const fragments = normalizedDocuments.flatMap((document) =>
    document.blocks.map((block) => ({
      id: block.id,
      documentId: document.id,
      kind: block.kind,
      text: block.text,
      locator: block.locator,
      confidence: block.confidence ?? 1,
      metadata: block.metadata,
    })),
  );
  return {
    documents,
    fragments,
    claims: [],
    diagnostics: [
      {
        code: "HUMAN_MAPPING_REQUIRED",
        severity: "info",
        message: "Documents are ready; claims require a reviewed mapping to alternatives and criteria.",
      },
    ],
  };
}

export function allowByDefault() {
  return { allowed: true };
}
