const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "com",
  "bat",
  "cmd",
  "ps1",
  "js",
  "mjs",
  "cjs",
  "vbs",
  "scr",
  "msi",
  "apk",
]);

export const DEFAULT_IMPORT_LIMITS = Object.freeze({
  maxFiles: 50,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxTextCharacters: 5_000_000,
  maxBlocksPerDocument: 25_000,
  maxArchiveEntries: 2_000,
  maxArchiveUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxArchiveDepth: 2,
});

function diagnostic(code, severity, message, details = undefined) {
  return { code, severity, message, ...(details === undefined ? {} : { details }) };
}

export function validateInputEnvelope(inputs, limits = DEFAULT_IMPORT_LIMITS) {
  const diagnostics = [];
  if (!Array.isArray(inputs) || inputs.length < 1) {
    diagnostics.push(diagnostic("NO_INPUTS", "error", "At least one import input is required."));
    return diagnostics;
  }
  if (inputs.length > limits.maxFiles) {
    diagnostics.push(
      diagnostic("TOO_MANY_FILES", "error", `At most ${limits.maxFiles} files may be imported together.`),
    );
  }
  const total = inputs.reduce((sum, input) => sum + (input.size ?? input.bytes?.byteLength ?? 0), 0);
  if (total > limits.maxTotalBytes) {
    diagnostics.push(
      diagnostic("IMPORT_TOO_LARGE", "error", `Import exceeds the ${limits.maxTotalBytes} byte total limit.`),
    );
  }
  return diagnostics;
}

export function preflightFile(input, bytes, limits = DEFAULT_IMPORT_LIMITS) {
  const diagnostics = [];
  const name = String(input.name ?? "");
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const extension = segments.at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  if (segments.includes("..") || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    diagnostics.push(diagnostic("UNSAFE_PATH", "error", "File names may not traverse directories."));
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    diagnostics.push(diagnostic("EXECUTABLE_REJECTED", "error", "Executable content cannot be imported."));
  }
  if (bytes.byteLength === 0) diagnostics.push(diagnostic("EMPTY_FILE", "error", "The imported file is empty."));
  if (bytes.byteLength > limits.maxFileBytes) {
    diagnostics.push(
      diagnostic("FILE_TOO_LARGE", "error", `File exceeds the ${limits.maxFileBytes} byte limit.`),
    );
  }
  const nullCount = bytes.slice(0, Math.min(bytes.length, 8192)).reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  if (nullCount > 512 && /^text\//i.test(input.mimeType ?? "")) {
    diagnostics.push(diagnostic("BINARY_AS_TEXT", "error", "The declared text file contains binary data."));
  }
  return diagnostics;
}

export function scanExtractedDocument(document) {
  const diagnostics = [];
  const text = document.blocks.map((block) => block.text).join("\n");
  const injectionPatterns = [
    /ignore (?:all|any|the) previous instructions/i,
    /reveal (?:the )?(?:system|developer) prompt/i,
    /(?:call|invoke|execute) (?:the )?(?:tool|function)/i,
    /you are (?:now|an?) (?:assistant|system)/i,
  ];
  if (injectionPatterns.some((pattern) => pattern.test(text))) {
    diagnostics.push(
      diagnostic(
        "UNTRUSTED_INSTRUCTION",
        "warning",
        "The source contains instruction-like text. It remains evidence text and cannot control the agent.",
      ),
    );
  }
  if (/https?:\/\//i.test(text)) {
    diagnostics.push(diagnostic("EXTERNAL_LINK", "info", "External links are preserved as untrusted text only."));
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    diagnostics.push(diagnostic("POTENTIAL_PII", "info", "The document may contain personal contact information."));
  }
  const formulaCells = document.blocks.filter(
    (block) => block.kind === "cell" && /^[=+@]|^-\D/.test(block.text.trim()),
  );
  if (formulaCells.length) {
    diagnostics.push(
      diagnostic(
        "FORMULA_LIKE_CELL",
        "warning",
        "Spreadsheet-style formula text is inert in SituationRoom and must be escaped on export.",
        { count: formulaCells.length },
      ),
    );
  }
  const lowConfidence = document.blocks.filter((block) => block.confidence < 0.75).length;
  if (lowConfidence) {
    diagnostics.push(
      diagnostic("LOW_EXTRACTION_CONFIDENCE", "warning", "Some extracted regions require human review.", {
        count: lowConfidence,
      }),
    );
  }
  return diagnostics;
}

export function hasBlockingDiagnostics(diagnostics) {
  return diagnostics.some((entry) => entry.severity === "error");
}
