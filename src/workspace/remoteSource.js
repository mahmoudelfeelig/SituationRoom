function privateIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && [18, 19].includes(b)) ||
    a >= 224;
}

function privateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const localName = normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa");
  const privateIpv6 = /^(?:::|::1$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:)/i;
  return localName || privateIpv4(normalized) || privateIpv6.test(normalized);
}

export function assertSafeRemoteUrl(raw, base) {
  let parsed;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error("Remote source URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Remote sources require credential-free HTTPS URLs.");
  }
  if (privateHostname(parsed.hostname)) {
    throw new Error("Remote sources cannot target private, loopback, reserved, or local-network addresses.");
  }
  return parsed;
}

export function assertSafeRemoteResponse(response, maximumBytes) {
  if (!response?.ok) throw new Error(`Remote source returned HTTP ${response?.status ?? "unknown"}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
    throw new Error("Remote source redirected outside the HTTPS evidence boundary.");
  }
  if (privateHostname(finalUrl.hostname)) {
    throw new Error("Remote source redirected to a private or local address.");
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Remote source exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB import limit.`);
  }
  return finalUrl;
}

export async function resolveUrlSource(url, { signal, maxBytes, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Remote source fetching is unavailable in this browser.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("A positive remote import byte limit is required.");
  let currentUrl = assertSafeRemoteUrl(url);
  let response;
  const maximumRedirects = 5;
  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    response = await fetchImpl(currentUrl.href, {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response?.status < 300 || response?.status >= 400) break;
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("Remote source redirect could not be verified and was blocked.");
    if (redirects === maximumRedirects) throw new Error("Remote source exceeded the verified redirect limit.");
    currentUrl = assertSafeRemoteUrl(location, currentUrl);
  }
  const finalUrl = assertSafeRemoteResponse(response, maxBytes);
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel("Remote evidence exceeded the bounded import size.").catch(() => undefined);
          throw new Error("Remote source exceeded the bounded import size while downloading.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Remote source exceeded the bounded import size while downloading.");
  }

  let decodedName = finalUrl.pathname.split("/").pop() || "remote-evidence.bin";
  try {
    decodedName = decodeURIComponent(decodedName);
  } catch {
    // Preserve the URL-safe filename when percent encoding is malformed.
  }
  return {
    name: decodedName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 240) || "remote-evidence.bin",
    mimeType: response.headers?.get?.("content-type")?.split(";")[0] || "application/octet-stream",
    bytes,
    metadata: { sourceUrl: finalUrl.origin + finalUrl.pathname },
  };
}
