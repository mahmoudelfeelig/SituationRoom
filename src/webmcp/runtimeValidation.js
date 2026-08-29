const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function typeMatches(type, value) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function addIssue(issues, path, message, code = "invalid") {
  issues.push({ path: path || "$", message, code });
}

function validateFormat(format, value) {
  if (format === "uri") {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol);
    } catch {
      return false;
    }
  }
  if (format === "date-time") return !Number.isNaN(Date.parse(value));
  return true;
}

function visit(schema, value, path, issues, budget, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    addIssue(issues, path, "Input contains too many values.", "too_complex");
    return;
  }
  if (depth > budget.maxDepth) {
    addIssue(issues, path, "Input nesting is too deep.", "too_deep");
    return;
  }
  if (!schema || typeof schema !== "object") {
    addIssue(issues, path, "Tool schema is invalid.", "invalid_schema");
    return;
  }

  if (schema.const !== undefined && !sameJsonValue(schema.const, value)) {
    addIssue(issues, path, `Value must equal ${JSON.stringify(schema.const)}.`, "const");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJsonValue(entry, value))) {
    addIssue(issues, path, "Value is not in the allowed set.", "enum");
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((entry) => visit(entry, value, path, issues, budget, depth + 1));
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((entry) => {
      const candidateIssues = [];
      visit(entry, value, path, candidateIssues, { ...budget, nodes: 0 }, depth + 1);
      return candidateIssues.length === 0;
    });
    if (!matches) addIssue(issues, path, "Value does not match any allowed shape.", "any_of");
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry) => {
      const candidateIssues = [];
      visit(entry, value, path, candidateIssues, { ...budget, nodes: 0 }, depth + 1);
      return candidateIssues.length === 0;
    }).length;
    if (matches !== 1) addIssue(issues, path, "Value must match exactly one allowed shape.", "one_of");
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      addIssue(issues, path, `Expected ${types.join(" or ")}.`, "type");
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      addIssue(issues, path, `Must contain at least ${schema.minLength} characters.`, "min_length");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      addIssue(issues, path, `Must contain at most ${schema.maxLength} characters.`, "max_length");
    }
    if (schema.pattern) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern, "u");
      } catch {
        addIssue(issues, path, "Tool schema contains an invalid pattern.", "invalid_schema");
      }
      if (pattern && !pattern.test(value)) addIssue(issues, path, "Value has an invalid format.", "pattern");
    }
    if (schema.format && !validateFormat(schema.format, value)) {
      addIssue(issues, path, `Value must be a valid ${schema.format}.`, "format");
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addIssue(issues, path, `Must be at least ${schema.minimum}.`, "minimum");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addIssue(issues, path, `Must be at most ${schema.maximum}.`, "maximum");
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addIssue(issues, path, `Must contain at least ${schema.minItems} items.`, "min_items");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      addIssue(issues, path, `Must contain at most ${schema.maxItems} items.`, "max_items");
    }
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) {
        addIssue(issues, path, "Items must be unique.", "unique_items");
      }
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        visit(schema.items, entry, `${path}[${index}]`, issues, budget, depth + 1);
      });
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    for (const key of keys) {
      if (BLOCKED_KEYS.has(key)) addIssue(issues, `${path}.${key}`, "Property is not allowed.", "blocked_key");
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      addIssue(issues, path, `Must contain at least ${schema.minProperties} properties.`, "min_properties");
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      addIssue(issues, path, `Must contain at most ${schema.maxProperties} properties.`, "max_properties");
    }
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        addIssue(issues, `${path}.${required}`, "Required property is missing.", "required");
      }
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        visit(properties[key], value[key], `${path}.${key}`, issues, budget, depth + 1);
      } else if (schema.additionalProperties === false) {
        addIssue(issues, `${path}.${key}`, "Unexpected property.", "additional_property");
      } else if (isPlainObject(schema.additionalProperties)) {
        visit(schema.additionalProperties, value[key], `${path}.${key}`, issues, budget, depth + 1);
      }
    }
  }
}

export function validateInput(schema, value, options = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "Input must be JSON serializable.", code: "not_json" }] };
  }
  const maxInputChars = options.maxInputChars ?? 32_000;
  if (serialized === undefined || serialized.length > maxInputChars) {
    return {
      ok: false,
      issues: [{ path: "$", message: `Input exceeds the ${maxInputChars}-character limit.`, code: "too_large" }],
    };
  }

  const issues = [];
  visit(schema, value, "$", issues, {
    nodes: 0,
    maxNodes: options.maxNodes ?? 5_000,
    maxDepth: options.maxDepth ?? 12,
  });
  return { ok: issues.length === 0, issues };
}

export function summarizeValidationIssues(issues, limit = 3) {
  return issues
    .slice(0, limit)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join(" ");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
