import { ERROR_CODES, SituationRoomError } from "../kernel/errors.js";
import { createDocumentArtifact } from "./documentModel.js";
import { detectFormat } from "./formats.js";
import {
  DEFAULT_IMPORT_LIMITS,
  hasBlockingDiagnostics,
  preflightFile,
  scanExtractedDocument,
  validateInputEnvelope,
} from "./security.js";
import {
  decodeText,
  decodeTextWithMetadata,
  parseCsv,
  parseEml,
  parseHtml,
  parseJson,
  parseMarkdown,
  parseRtf,
  parseText,
  parseXml,
  parseYaml,
} from "./parsers/native.js";
import { extractZipEntries, parseDocx, parsePptx, parseXlsx } from "./parsers/archive.js";
import { parsePdf } from "./parsers/pdf.js";
import { parseImageOcr } from "./parsers/image.js";

const encoder = new TextEncoder();
const TEXT_DECODING_FORMATS = new Set(["text", "markdown", "json", "csv", "tsv", "html", "xml", "yaml", "rtf", "eml"]);

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new SituationRoomError(ERROR_CODES.IMPORT_CANCELED, "Import was canceled.");
}

export function declaredImportInputSize(input) {
  if (typeof input === "string") return encoder.encode(input).byteLength;
  if (input instanceof Uint8Array) return input.byteLength;
  if (input instanceof ArrayBuffer) return input.byteLength;
  if (!input || typeof input !== "object") return null;
  if (Number.isFinite(input.size) && input.size >= 0) return Number(input.size);
  if (input.bytes instanceof Uint8Array || input.bytes instanceof ArrayBuffer) return input.bytes.byteLength;
  if (typeof input.text === "string") return encoder.encode(input.text).byteLength;
  return null;
}

function assertDeclaredSize(input, limits) {
  const size = declaredImportInputSize(input);
  if (size !== null && size > limits.maxFileBytes) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import input exceeds the per-file safety limit.", {
      recoverable: true,
      action: "select_smaller_file",
      diagnostics: [
        {
          code: "FILE_TOO_LARGE",
          severity: "error",
          message: `File exceeds the ${limits.maxFileBytes} byte limit.`,
          details: { declaredSize: size, maximum: limits.maxFileBytes },
        },
      ],
    });
  }
}

export async function normalizeImportInput(input, sequence = 0, options = {}) {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...(options.limits ?? {}) };
  assertDeclaredSize(input, limits);
  if (typeof input === "string") {
    const bytes = encoder.encode(input);
    return { name: `pasted-text-${sequence + 1}.txt`, mimeType: "text/plain", bytes, size: bytes.byteLength };
  }
  if (input instanceof Uint8Array) {
    return {
      name: `unnamed-${sequence + 1}.bin`,
      mimeType: "application/octet-stream",
      bytes: input.slice(),
      size: input.byteLength,
    };
  }
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input.slice(0));
    return { name: `unnamed-${sequence + 1}.bin`, mimeType: "application/octet-stream", bytes, size: bytes.byteLength };
  }
  if (!input || typeof input !== "object") {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import inputs must be files, bytes, text, or input objects.");
  }
  let bytes;
  if (input.bytes instanceof Uint8Array) bytes = input.bytes.slice();
  else if (input.bytes instanceof ArrayBuffer) bytes = new Uint8Array(input.bytes.slice(0));
  else if (typeof input.text === "string") bytes = encoder.encode(input.text);
  else if (typeof input.arrayBuffer === "function") bytes = new Uint8Array(await input.arrayBuffer());
  else throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import input has no readable content.");
  return {
    name: String(input.name ?? `unnamed-${sequence + 1}.bin`),
    mimeType: String(input.mimeType ?? input.type ?? "application/octet-stream"),
    bytes,
    size: bytes.byteLength,
    lastModified: input.lastModified ?? null,
    metadata: input.metadata ?? {},
  };
}

function boundedBlocks(blocks, maximumCharacters) {
  const retained = [];
  let remaining = maximumCharacters;
  for (const block of blocks) {
    if (remaining <= 0) break;
    const text = String(block.text ?? "");
    if (text.length <= remaining) {
      retained.push(block);
      remaining -= text.length;
      continue;
    }
    retained.push({
      ...block,
      text: text.slice(0, remaining),
      metadata: { ...block.metadata, extractionTruncated: true, originalCharacterCount: text.length },
    });
    remaining = 0;
  }
  return retained;
}

async function parseByFormat(input, detected, context) {
  const common = { signal: context.signal, limits: context.limits, depth: context.depth };
  switch (detected.format) {
    case "text":
      return parseText(input.bytes);
    case "markdown":
      return parseMarkdown(input.bytes);
    case "json":
      return parseJson(input.bytes);
    case "csv":
      return parseCsv(input.bytes, ",");
    case "tsv":
      return parseCsv(input.bytes, "\t");
    case "html":
      return parseHtml(input.bytes);
    case "xml":
      return parseXml(input.bytes);
    case "yaml":
      return parseYaml(input.bytes);
    case "rtf":
      return parseRtf(input.bytes);
    case "eml":
      return parseEml(input.bytes, common);
    case "pdf":
      return parsePdf(input.bytes, {
        ...common,
        password: context.passwords?.[input.name],
        onProgress: context.onSubprogress,
      });
    case "docx":
      return parseDocx(input.bytes, common);
    case "xlsx":
      return parseXlsx(input.bytes, common);
    case "pptx":
      return parsePptx(input.bytes, common);
    case "image":
      return parseImageOcr(input.bytes, {
        ...common,
        mimeType: input.mimeType,
        ...(context.ocr ?? {}),
        onProgress: context.onSubprogress,
      });
    default:
      throw new SituationRoomError(ERROR_CODES.UNSUPPORTED_FORMAT, `No safe parser is available for '${detected.format}'.`, {
        format: detected.format,
        diagnosticCode: "PARSER_UNAVAILABLE",
      });
  }
}

function errorDiagnostics(error) {
  if (error instanceof SituationRoomError) {
    const nested = error.details?.diagnostics;
    return Array.isArray(nested)
      ? nested
      : [
          {
            code: error.details?.diagnosticCode ?? error.code,
            severity: "error",
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        ];
  }
  return [{ code: "PARSER_FAILURE", severity: "error", message: error instanceof Error ? error.message : String(error) }];
}

async function parseOne(input, context) {
  abortIfNeeded(context.signal);
  context.counters.bytes += input.bytes.byteLength;
  context.counters.files += 1;
  if (
    context.counters.bytes > context.limits.maxTotalBytes ||
    context.counters.files > context.limits.maxFiles + context.limits.maxArchiveEntries
  ) {
    throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Expanded import exceeds the total safety limit.", {
      diagnosticCode: "IMPORT_EXPANSION_LIMIT",
    });
  }
  const preflight = preflightFile(input, input.bytes, context.limits);
  const detected = detectFormat(input);
  const initialDiagnostics = [...preflight, ...detected.diagnostics];
  if (detected.format === "zip" && !hasBlockingDiagnostics(initialDiagnostics)) {
    try {
      const { entries, diagnostics } = await extractZipEntries(input.bytes, {
        limits: context.limits,
        depth: context.depth,
      });
      const documents = [];
      for (const [index, entry] of entries.entries()) {
        abortIfNeeded(context.signal);
        const nestedInput = {
          name: entry.name.split("/").pop() || `archive-entry-${index + 1}`,
          mimeType: "application/octet-stream",
          bytes: entry.bytes,
          size: entry.bytes.byteLength,
          metadata: { archiveName: input.name, archivePath: entry.name },
        };
        documents.push(
          ...(await parseOne(nestedInput, {
            ...context,
            depth: context.depth + 1,
            sequenceOffset: context.sequenceOffset + index + 1,
            inheritedDiagnostics: [...(context.inheritedDiagnostics ?? []), ...initialDiagnostics, ...diagnostics],
          })),
        );
      }
      return documents;
    } catch (error) {
      initialDiagnostics.push(...errorDiagnostics(error));
    }
  }

  let parsed = { blocks: [], diagnostics: [], metadata: {} };
  if (!hasBlockingDiagnostics(initialDiagnostics) && detected.format !== "zip") {
    try {
      parsed = await parseByFormat(input, detected, context);
    } catch (error) {
      if (error instanceof SituationRoomError && error.code === ERROR_CODES.IMPORT_CANCELED) throw error;
      parsed = { blocks: [], diagnostics: errorDiagnostics(error), metadata: {} };
    }
  }
  const diagnostics = [
    ...(context.inheritedDiagnostics ?? []),
    ...initialDiagnostics,
    ...(parsed.diagnostics ?? []),
  ];
  if ((parsed.blocks?.length ?? 0) > context.limits.maxBlocksPerDocument) {
    diagnostics.push({
      code: "BLOCK_LIMIT_EXCEEDED",
      severity: "error",
      message: `Extraction exceeds ${context.limits.maxBlocksPerDocument} blocks.`,
    });
    parsed.blocks = parsed.blocks.slice(0, context.limits.maxBlocksPerDocument);
  }
  const characterCount = (parsed.blocks ?? []).reduce((sum, block) => sum + String(block.text ?? "").length, 0);
  if (characterCount > context.limits.maxTextCharacters) {
    diagnostics.push({
      code: "TEXT_LIMIT_EXCEEDED",
      severity: "error",
      message: `Extracted text exceeds ${context.limits.maxTextCharacters} characters.`,
      details: { extractedCharacters: characterCount, retainedCharacters: context.limits.maxTextCharacters },
    });
    parsed.blocks = boundedBlocks(parsed.blocks ?? [], context.limits.maxTextCharacters);
  }
  if (TEXT_DECODING_FORMATS.has(detected.format)) {
    diagnostics.push(...decodeTextWithMetadata(input.bytes).diagnostics);
  }
  let document = createDocumentArtifact({
    input,
    bytes: input.bytes,
    format: detected.format,
    importId: context.importId,
    caseId: context.caseId,
    sequence: context.sequenceOffset,
    blocks: parsed.blocks ?? [],
    diagnostics,
    metadata: { ...input.metadata, ...(parsed.metadata ?? {}), structuredData: parsed.structuredData },
    securityStatus: hasBlockingDiagnostics(diagnostics) ? "quarantined" : "review-required",
    importedAt: context.importedAt,
  });
  const scanDiagnostics = scanExtractedDocument(document);
  document = {
    ...document,
    diagnostics: [...document.diagnostics, ...scanDiagnostics],
    trust: {
      sourceContent: "untrusted",
      instructionLike: scanDiagnostics.some((entry) => entry.code === "UNTRUSTED_INSTRUCTION"),
      externalLinks: scanDiagnostics.some((entry) => entry.code === "EXTERNAL_LINK"),
      humanAcceptanceRequired: true,
    },
    securityStatus: hasBlockingDiagnostics([...document.diagnostics, ...scanDiagnostics])
      ? "quarantined"
      : "review-required",
  };
  return [document];
}

export async function parseImportInputs(inputs, options = {}) {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...(options.limits ?? {}) };
  const declaredEnvelope = inputs.map((input) => ({ size: declaredImportInputSize(input) ?? 0 }));
  const declaredDiagnostics = validateInputEnvelope(declaredEnvelope, limits);
  if (hasBlockingDiagnostics(declaredDiagnostics)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import envelope failed validation before reading file contents.", {
      recoverable: true,
      action: "select_smaller_files",
      diagnostics: declaredDiagnostics,
    });
  }
  inputs.forEach((input) => assertDeclaredSize(input, limits));
  const normalized = [];
  for (const [index, input] of inputs.entries()) {
    abortIfNeeded(options.signal);
    normalized.push(await normalizeImportInput(input, index, { limits }));
  }
  const envelopeDiagnostics = validateInputEnvelope(normalized, limits);
  if (hasBlockingDiagnostics(envelopeDiagnostics)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import envelope failed validation.", {
      diagnostics: envelopeDiagnostics,
    });
  }
  await options.onNormalizedInputs?.(normalized);
  const documents = [];
  const counters = { bytes: 0, files: 0 };
  for (const [index, input] of normalized.entries()) {
    abortIfNeeded(options.signal);
    documents.push(
      ...(await parseOne(input, {
        importId: options.importId,
        caseId: options.caseId,
        signal: options.signal,
        limits,
        depth: 0,
        sequenceOffset: index,
        counters,
        passwords: options.passwords,
        ocr: options.ocr,
        importedAt: options.importedAt ?? new Date().toISOString(),
        onSubprogress: (fraction) => options.onProgress?.((index + fraction) / normalized.length),
      })),
    );
    options.onProgress?.((index + 1) / normalized.length);
  }
  const firstByHash = new Map();
  const deduplicated = documents.map((document) => {
    const first = firstByHash.get(document.byteHash);
    if (!first) {
      firstByHash.set(document.byteHash, document.id);
      return document;
    }
    return {
      ...document,
      diagnostics: [
        ...document.diagnostics,
        {
          code: "DUPLICATE_FILE",
          severity: "warning",
          message: "This file duplicates another artifact in the same import.",
          details: { duplicateOf: first },
        },
      ],
    };
  });
  return { documents: deduplicated, diagnostics: envelopeDiagnostics };
}

export function previewText(bytes, maximum = 2_000) {
  return decodeText(bytes).slice(0, maximum);
}
