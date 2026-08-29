import { sha256Hex } from "../kernel/canonicalize.js";

function safeLeafName(name) {
  const leaf = String(name || "untitled").replaceAll("\\", "/").split("/").pop() || "untitled";
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240) || "untitled";
}

export function createDocumentArtifact({
  input,
  bytes,
  format,
  importId,
  caseId,
  sequence = 0,
  blocks = [],
  diagnostics = [],
  metadata = {},
  securityStatus = "unreviewed",
  importedAt = new Date().toISOString(),
}) {
  const rawHash = sha256Hex(bytes);
  const identityHash = sha256Hex(
    [
      String(caseId ?? "unscoped-case"),
      String(importId ?? "unscoped-import"),
      rawHash,
      String(input.name ?? ""),
      String(input.metadata?.archivePath ?? ""),
      String(sequence),
    ].join("\u0000"),
  );
  const id = `document:${identityHash.slice(0, 24)}:${sequence}`;
  const normalizedBlocks = blocks.map((block, index) => ({
    id: `${id}:block:${index + 1}`,
    documentId: id,
    kind: block.kind ?? "paragraph",
    text: String(block.text ?? ""),
    locator: block.locator ?? { index: index + 1 },
    confidence: block.confidence ?? 1,
    ...(block.metadata === undefined ? {} : { metadata: block.metadata }),
  }));
  return {
    id,
    caseId: caseId ?? null,
    importId,
    name: safeLeafName(input.name),
    mimeType: input.mimeType || "application/octet-stream",
    format,
    size: bytes.byteLength,
    byteHash: `sha256:${rawHash}`,
    importedAt,
    securityStatus,
    blocks: normalizedBlocks,
    diagnostics,
    metadata,
  };
}

export function sourceRefForBlock(block) {
  return {
    documentId: block.documentId,
    fragmentId: block.id,
    locator: block.locator,
    quoteHash: `sha256:${sha256Hex(block.text)}`,
  };
}
