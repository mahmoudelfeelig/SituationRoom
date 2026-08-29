import { ERROR_CODES, SituationRoomError } from "../../kernel/errors.js";
import { DEFAULT_IMPORT_LIMITS } from "../security.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

function zipDiagnostic(code, severity, message, details = undefined) {
  return { code, severity, message, ...(details === undefined ? {} : { details }) };
}

function safeArchivePath(name) {
  const normalized = name.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.split("/").includes("..") &&
    !normalized.includes("\0")
  );
}

export function inspectZipDirectory(bytes, limits = DEFAULT_IMPORT_LIMITS) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let offset = 0;
  while (offset + 46 <= bytes.byteLength) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) {
      throw new SituationRoomError(ERROR_CODES.QUARANTINED, "ZIP directory entry exceeds the archive boundary.", {
        diagnosticCode: "MALFORMED_ARCHIVE",
      });
    }
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, flags, compressionMethod, compressedSize, uncompressedSize, encrypted: Boolean(flags & 1) });
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    offset = end;
  }
  const diagnostics = [];
  if (!entries.length) {
    diagnostics.push(zipDiagnostic("ZIP_DIRECTORY_MISSING", "error", "The archive has no readable central directory."));
  }
  if (entries.length > limits.maxArchiveEntries) {
    diagnostics.push(
      zipDiagnostic("ARCHIVE_ENTRY_LIMIT", "error", `Archive exceeds ${limits.maxArchiveEntries} entries.`),
    );
  }
  if (totalUncompressed > limits.maxArchiveUncompressedBytes) {
    diagnostics.push(
      zipDiagnostic(
        "ARCHIVE_EXPANSION_LIMIT",
        "error",
        `Archive expands beyond ${limits.maxArchiveUncompressedBytes} bytes.`,
      ),
    );
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > limits.maxCompressionRatio) {
    diagnostics.push(
      zipDiagnostic("SUSPICIOUS_COMPRESSION_RATIO", "error", "Archive compression ratio exceeds the safe limit."),
    );
  }
  const unsafePaths = entries.filter((entry) => !safeArchivePath(entry.name));
  if (unsafePaths.length) {
    diagnostics.push(
      zipDiagnostic("ARCHIVE_PATH_TRAVERSAL", "error", "Archive contains unsafe entry paths.", {
        entries: unsafePaths.slice(0, 20).map((entry) => entry.name),
      }),
    );
  }
  const encrypted = entries.filter((entry) => entry.encrypted);
  if (encrypted.length) {
    diagnostics.push(
      zipDiagnostic("ENCRYPTED_DOCUMENT", "error", "Encrypted archive entries require a decrypted source file.", {
        entries: encrypted.slice(0, 20).map((entry) => entry.name),
      }),
    );
  }
  const macros = entries.filter((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry.name));
  if (macros.length) {
    diagnostics.push(
      zipDiagnostic("OFFICE_MACRO_DETECTED", "error", "Macro-enabled Office content is quarantined.", {
        entries: macros.map((entry) => entry.name),
      }),
    );
  }
  return { entries, totalCompressed, totalUncompressed, diagnostics };
}

export async function extractZipEntries(bytes, options = {}) {
  const limits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  if ((options.depth ?? 0) > limits.maxArchiveDepth) {
    throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Nested archive depth exceeds the safe limit.", {
      diagnosticCode: "ARCHIVE_RECURSION_LIMIT",
    });
  }
  const inspection = inspectZipDirectory(bytes, limits);
  if (inspection.diagnostics.some((entry) => entry.severity === "error")) {
    throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Archive failed security validation.", {
      diagnostics: inspection.diagnostics,
    });
  }
  try {
    const { unzipSync } = await import("fflate");
    const extracted = unzipSync(bytes);
    const entries = Object.entries(extracted)
      .filter(([name]) => !name.endsWith("/"))
      .map(([name, value]) => ({ name, bytes: new Uint8Array(value) }));
    const actualSize = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    if (actualSize > limits.maxArchiveUncompressedBytes || entries.length > limits.maxArchiveEntries) {
      throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Extracted archive exceeds safe limits.", {
        diagnosticCode: "ARCHIVE_EXPANSION_LIMIT",
      });
    }
    return { entries, diagnostics: inspection.diagnostics };
  } catch (error) {
    if (error instanceof SituationRoomError) throw error;
    throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Archive extraction failed.", {
      diagnosticCode: "MALFORMED_ARCHIVE",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function xmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlText(xml, tagPattern = "(?:w|a):t") {
  const pattern = new RegExp(`<${tagPattern}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => xmlEntities(match[1])).join("");
}

function decodeEntry(entries, name, required = true) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    if (!required) return null;
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `Office package is missing '${name}'.`);
  }
  return decoder.decode(entry.bytes);
}

function attribute(source, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(source);
  return match ? xmlEntities(match[1]) : null;
}

export async function parseDocx(bytes, options = {}) {
  const { entries, diagnostics } = await extractZipEntries(bytes, options);
  const documentXml = decodeEntry(entries, "word/document.xml");
  const blocks = [];
  let tableIndex = 0;
  const withoutTables = documentXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/gi, (tableXml) => {
    tableIndex += 1;
    let cellIndex = 0;
    for (const cellMatch of tableXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gi)) {
      cellIndex += 1;
      const text = xmlText(cellMatch[0]).trim();
      if (text) blocks.push({ kind: "cell", text, locator: { table: tableIndex, cell: cellIndex } });
    }
    return " ";
  });
  let paragraph = 0;
  for (const match of withoutTables.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)) {
    paragraph += 1;
    const text = xmlText(match[0]).trim();
    if (text) blocks.push({ kind: "paragraph", text, locator: { paragraph } });
  }
  if (!blocks.length) {
    diagnostics.push(zipDiagnostic("NO_EXTRACTABLE_TEXT", "warning", "The Word document contains no extractable text."));
  }
  const commentsXml = decodeEntry(entries, "word/comments.xml", false);
  if (commentsXml) {
    let comment = 0;
    for (const match of commentsXml.matchAll(/<w:comment\b[\s\S]*?<\/w:comment>/gi)) {
      comment += 1;
      const text = xmlText(match[0]).trim();
      if (text) blocks.push({ kind: "comment", text, locator: { comment } });
    }
  }
  return { blocks, diagnostics, metadata: { packageEntries: entries.length } };
}

function normalizeOfficePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

export async function parseXlsx(bytes, options = {}) {
  const { entries, diagnostics } = await extractZipEntries(bytes, options);
  const workbookXml = decodeEntry(entries, "xl/workbook.xml");
  const relationshipsXml = decodeEntry(entries, "xl/_rels/workbook.xml.rels");
  const sharedStringsXml = decodeEntry(entries, "xl/sharedStrings.xml", false);
  const sharedStrings = sharedStringsXml
    ? [...sharedStringsXml.matchAll(/<si\b[\s\S]*?<\/si>/gi)].map((match) => xmlText(match[0], "t"))
    : [];
  const relationships = new Map(
    [...relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].map((match) => [
      attribute(match[1], "Id"),
      normalizeOfficePath("xl", attribute(match[1], "Target") ?? ""),
    ]),
  );
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].map((match, index) => ({
    name: attribute(match[1], "name") ?? `Sheet ${index + 1}`,
    relationshipId: attribute(match[1], "r:id"),
    hidden: ["hidden", "veryHidden"].includes(attribute(match[1], "state")),
  }));
  const blocks = [];
  let formulaCount = 0;
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const entryPath = relationships.get(sheet.relationshipId);
    const worksheet = decodeEntry(entries, entryPath);
    if (sheet.hidden) {
      diagnostics.push(
        zipDiagnostic("HIDDEN_SHEET", "warning", `Hidden sheet '${sheet.name}' was included and requires review.`),
      );
    }
    blocks.push({
      kind: "heading",
      text: sheet.name,
      locator: { sheet: sheet.name, sheetIndex: sheetIndex + 1 },
      metadata: { hidden: sheet.hidden },
    });
    for (const match of worksheet.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = match[1];
      const content = match[2];
      const range = attribute(attributes, "r") ?? "unknown";
      const type = attribute(attributes, "t");
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(content)?.[1] ?? "";
      const inline = /<is\b[\s\S]*?<\/is>/i.exec(content)?.[0];
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(content)?.[1];
      let value = xmlEntities(raw);
      if (type === "s") value = sharedStrings[Number.parseInt(raw, 10)] ?? "";
      else if (type === "inlineStr" && inline) value = xmlText(inline, "t");
      else if (type === "b") value = raw === "1" ? "true" : "false";
      if (formula !== undefined) {
        formulaCount += 1;
        if (/\[[^\]]+\]|WEBSERVICE\s*\(/i.test(formula)) {
          diagnostics.push(
            zipDiagnostic("EXTERNAL_FORMULA_REFERENCE", "warning", `Cell ${sheet.name}!${range} has an external formula reference.`),
          );
        }
      }
      blocks.push({
        kind: "cell",
        text: value,
        locator: { sheet: sheet.name, range },
        metadata: { type: type ?? "number", formula: formula === undefined ? null : xmlEntities(formula), cachedValue: value },
      });
    }
  }
  if (formulaCount) {
    diagnostics.push(
      zipDiagnostic(
        "CACHED_FORMULA_VALUES",
        "warning",
        "Spreadsheet formulas were not executed; displayed values are cached workbook results.",
        { count: formulaCount },
      ),
    );
  }
  diagnostics.push(
    zipDiagnostic(
      "SPREADSHEET_TYPES_REQUIRE_REVIEW",
      "info",
      "Dates, currencies, locale-specific numbers, hidden rows, and merged cells require schema review.",
    ),
  );
  return { blocks, diagnostics, metadata: { sheets: sheets.map(({ name, hidden }) => ({ name, hidden })) } };
}

export async function parsePptx(bytes, options = {}) {
  const { entries, diagnostics } = await extractZipEntries(bytes, options);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => {
      const leftNumber = Number(/slide(\d+)/i.exec(left.name)?.[1] ?? 0);
      const rightNumber = Number(/slide(\d+)/i.exec(right.name)?.[1] ?? 0);
      return leftNumber - rightNumber;
    });
  const blocks = [];
  slides.forEach((slide, slideIndex) => {
    const xml = decoder.decode(slide.bytes);
    let paragraph = 0;
    for (const match of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/gi)) {
      paragraph += 1;
      const text = xmlText(match[0]).trim();
      if (text) blocks.push({ kind: paragraph === 1 ? "heading" : "paragraph", text, locator: { slide: slideIndex + 1, paragraph } });
    }
  });
  const notes = entries
    .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  notes.forEach((note, noteIndex) => {
    const text = xmlText(decoder.decode(note.bytes)).trim();
    if (text) blocks.push({ kind: "speaker-notes", text, locator: { slide: noteIndex + 1, notes: true } });
  });
  if (!slides.length) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "PowerPoint package contains no slides.");
  }
  if (!blocks.length) {
    diagnostics.push(zipDiagnostic("NO_EXTRACTABLE_TEXT", "warning", "Slides contain no extractable text."));
  }
  return { blocks, diagnostics, metadata: { slideCount: slides.length } };
}
