export const DECLARED_FORMATS = Object.freeze([
  "text",
  "markdown",
  "json",
  "csv",
  "tsv",
  "html",
  "xml",
  "yaml",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "rtf",
  "eml",
  "image",
  "zip",
  "legacy-doc",
  "legacy-xls",
  "legacy-ppt",
  "odt",
  "ods",
  "odp",
  "msg",
  "heic",
  "parquet",
]);

export const SUPPORTED_FORMATS = new Set([
  "text",
  "markdown",
  "json",
  "csv",
  "tsv",
  "html",
  "xml",
  "yaml",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "rtf",
  "eml",
  "image",
  "zip",
]);

const EXTENSIONS = Object.freeze({
  txt: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  csv: "csv",
  tsv: "tsv",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
  pptm: "pptx",
  rtf: "rtf",
  eml: "eml",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tif: "image",
  tiff: "image",
  webp: "image",
  zip: "zip",
  doc: "legacy-doc",
  xls: "legacy-xls",
  ppt: "legacy-ppt",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  msg: "msg",
  heic: "heic",
  heif: "heic",
  parquet: "parquet",
});

const MIME_TYPES = Object.freeze({
  "text/plain": "text",
  "text/markdown": "markdown",
  "application/json": "json",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
  "application/rtf": "rtf",
  "message/rfc822": "eml",
  "application/zip": "zip",
  "image/png": "image",
  "image/jpeg": "image",
  "image/tiff": "image",
  "image/webp": "image",
});

export function extensionOf(name = "") {
  const leaf = String(name).replaceAll("\\", "/").split("/").pop() ?? "";
  const index = leaf.lastIndexOf(".");
  return index > 0 ? leaf.slice(index + 1).toLowerCase() : "";
}

export function formatFromExtension(name) {
  return EXTENSIONS[extensionOf(name)] ?? null;
}

export function formatFromMime(mimeType = "") {
  return MIME_TYPES[String(mimeType).toLowerCase().split(";")[0].trim()] ?? null;
}

function begins(bytes, expected) {
  return expected.every((byte, index) => bytes[index] === byte);
}

export function sniffFormat(bytes) {
  if (begins(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (begins(bytes, [0x50, 0x4b, 0x03, 0x04]) || begins(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (begins(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image";
  if (begins(bytes, [0xff, 0xd8, 0xff])) return "image";
  if (begins(bytes, [0x49, 0x49, 0x2a, 0x00]) || begins(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image";
  if (begins(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image";
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).trimStart();
  if (prefix.startsWith("{\\rtf")) return "rtf";
  if (/^(?:from|return-path|received|message-id|mime-version|subject):/im.test(prefix)) return "eml";
  if (/^<!doctype\s+html|^<html[\s>]/i.test(prefix)) return "html";
  if (/^<\?xml\s|^<[a-z_][\w:.-]*(?:\s|>)/i.test(prefix)) return "xml";
  if (/^[\[{]/.test(prefix)) return "json";
  return "text";
}

export function detectFormat({ name = "", mimeType = "", bytes = new Uint8Array() }) {
  const extensionFormat = formatFromExtension(name);
  const mimeFormat = formatFromMime(mimeType);
  const sniffedFormat = sniffFormat(bytes);
  const declaredOfficeFormat = [extensionFormat, mimeFormat].find((candidate) =>
    ["docx", "xlsx", "pptx"].includes(candidate),
  );
  let format = extensionFormat ?? mimeFormat ?? sniffedFormat;
  if (declaredOfficeFormat && sniffedFormat === "zip") format = declaredOfficeFormat;
  const diagnostics = [];
  if (["pdf", "zip", "image"].includes(sniffedFormat)) {
    const officePackage = Boolean(declaredOfficeFormat) && sniffedFormat === "zip";
    if (!officePackage) {
      if (extensionFormat && extensionFormat !== sniffedFormat) {
        diagnostics.push({
          code: "BINARY_SIGNATURE_OVERRIDES_DECLARATION",
          severity: "warning",
          message: `Binary signature indicates ${sniffedFormat}; the declared ${extensionFormat} type was not trusted.`,
        });
      }
      format = sniffedFormat;
    }
  }
  if (extensionFormat && mimeFormat && extensionFormat !== mimeFormat) {
    diagnostics.push({
      code: "MIME_EXTENSION_MISMATCH",
      severity: "warning",
      message: `File extension indicates ${extensionFormat}, while MIME type indicates ${mimeFormat}.`,
    });
  }
  if (["pdf", "image", "zip", "docx", "xlsx", "pptx"].includes(format)) {
    const expectedSniff = ["docx", "xlsx", "pptx"].includes(format) ? "zip" : format;
    if (sniffedFormat !== expectedSniff) {
      diagnostics.push({
        code: "SIGNATURE_MISMATCH",
        severity: "error",
        message: `The file signature does not match the declared ${format} format.`,
      });
    }
  }
  return { format, extensionFormat, mimeFormat, sniffedFormat, diagnostics };
}
