import { ERROR_CODES, SituationRoomError } from "./errors.js";

const SAFE_OPERATORS = new Set([
  "literal",
  "ref",
  "and",
  "or",
  "not",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "add",
  "subtract",
  "multiply",
  "divide",
  "contains",
  "in",
  "coalesce",
  "if",
]);
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export const UNKNOWN = Object.freeze({ kind: "unknown" });

function isUnknown(value) {
  return value === UNKNOWN || value === undefined || value === null;
}

function resolveReference(context, path) {
  if (typeof path !== "string" || path.length > 512) return UNKNOWN;
  const segments = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");
  let value = context;
  for (const segment of segments) {
    if (!segment || BLOCKED_PATH_SEGMENTS.has(segment) || value === null || value === undefined) {
      return UNKNOWN;
    }
    if (!Object.prototype.hasOwnProperty.call(Object(value), segment)) return UNKNOWN;
    value = value[segment];
  }
  return value;
}

function requireFiniteNumber(value, operator) {
  if (!Number.isFinite(value)) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      `Operator '${operator}' requires finite numeric operands.`,
    );
  }
  return value;
}

export function evaluateExpression(expression, context = {}, limits = {}) {
  const maxDepth = limits.maxDepth ?? 32;
  const maxNodes = limits.maxNodes ?? 1_000;
  let visited = 0;

  function evaluate(node, depth) {
    visited += 1;
    if (visited > maxNodes || depth > maxDepth) {
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        "Rule expression exceeds the safe complexity limit.",
      );
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Rule nodes must be objects.");
    }
    if (!SAFE_OPERATORS.has(node.op)) {
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        `Unsupported rule operator '${String(node.op)}'.`,
      );
    }
    if (node.op === "literal") return node.value;
    if (node.op === "ref") return resolveReference(context, node.path);
    if (node.op === "not") {
      const value = evaluate(node.arg, depth + 1);
      return isUnknown(value) ? UNKNOWN : !Boolean(value);
    }
    if (node.op === "if") {
      const condition = evaluate(node.condition, depth + 1);
      if (isUnknown(condition)) return UNKNOWN;
      return evaluate(condition ? node.then : node.else, depth + 1);
    }
    const argumentsList = Array.isArray(node.args) ? node.args : [];
    if (node.op === "coalesce") {
      for (const argument of argumentsList) {
        const value = evaluate(argument, depth + 1);
        if (!isUnknown(value)) return value;
      }
      return UNKNOWN;
    }
    const values = argumentsList.map((argument) => evaluate(argument, depth + 1));
    if (node.op === "and") {
      if (values.some((value) => value === false)) return false;
      return values.some(isUnknown) ? UNKNOWN : values.every(Boolean);
    }
    if (node.op === "or") {
      if (values.some((value) => value === true)) return true;
      return values.some(isUnknown) ? UNKNOWN : values.some(Boolean);
    }
    if (values.length !== 2) {
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        `Operator '${node.op}' requires exactly two arguments.`,
      );
    }
    const [left, right] = values;
    if (isUnknown(left) || isUnknown(right)) return UNKNOWN;
    switch (node.op) {
      case "eq":
        return Object.is(left, right);
      case "ne":
        return !Object.is(left, right);
      case "gt":
        return left > right;
      case "gte":
        return left >= right;
      case "lt":
        return left < right;
      case "lte":
        return left <= right;
      case "add":
        return requireFiniteNumber(left, node.op) + requireFiniteNumber(right, node.op);
      case "subtract":
        return requireFiniteNumber(left, node.op) - requireFiniteNumber(right, node.op);
      case "multiply":
        return requireFiniteNumber(left, node.op) * requireFiniteNumber(right, node.op);
      case "divide": {
        const divisor = requireFiniteNumber(right, node.op);
        if (divisor === 0) {
          throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Division by zero is not allowed.");
        }
        return requireFiniteNumber(left, node.op) / divisor;
      }
      case "contains":
        return typeof left === "string" || Array.isArray(left) ? left.includes(right) : false;
      case "in":
        return Array.isArray(right) ? right.includes(left) : false;
      default:
        return UNKNOWN;
    }
  }

  return evaluate(expression, 0);
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? value : time;
  }
  return value;
}

export function evaluateConstraint(actualValue, constraint) {
  if (isUnknown(actualValue)) {
    return { status: "unknown", actual: null, expected: constraint.expected };
  }
  const actual = comparable(actualValue);
  const expected = comparable(constraint.expected);
  let passed;
  switch (constraint.operator) {
    case "eq":
      passed = Object.is(actual, expected);
      break;
    case "ne":
      passed = !Object.is(actual, expected);
      break;
    case "gt":
      passed = actual > expected;
      break;
    case "gte":
      passed = actual >= expected;
      break;
    case "lt":
      passed = actual < expected;
      break;
    case "lte":
      passed = actual <= expected;
      break;
    case "contains":
      passed = (typeof actual === "string" || Array.isArray(actual)) && actual.includes(expected);
      break;
    case "not_contains":
      passed = !((typeof actual === "string" || Array.isArray(actual)) && actual.includes(expected));
      break;
    case "in":
      passed = Array.isArray(expected) && expected.includes(actual);
      break;
    case "not_in":
      passed = Array.isArray(expected) && !expected.includes(actual);
      break;
    default:
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        `Unsupported constraint operator '${constraint.operator}'.`,
      );
  }
  return { status: passed ? "pass" : "fail", actual: actualValue, expected: constraint.expected };
}

export function isUnknownValue(value) {
  return isUnknown(value);
}
