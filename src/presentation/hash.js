function stableStringifyInternal(value, seen) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    throw new TypeError("Presentation values must not contain circular references.");
  }
  seen.add(value);

  let output;
  if (Array.isArray(value)) {
    output = `[${value.map((item) => stableStringifyInternal(item, seen)).join(",")}]`;
  } else {
    output = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyInternal(value[key], seen)}`)
      .join(",")}}`;
  }

  seen.delete(value);
  return output;
}

export function stableStringify(value) {
  return stableStringifyInternal(value, new WeakSet());
}

export function hashPresentationValue(value) {
  const input = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sr-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

