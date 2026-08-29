import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeRemoteResponse, assertSafeRemoteUrl, resolveUrlSource } from "../src/workspace/remoteSource.js";

function response({ url = "https://evidence.example/report.csv", chunks = [], headers = {}, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        controller.close();
      },
    }),
  };
}

test("remote evidence rejects unsafe redirects and declared oversized responses", () => {
  assert.throws(() => assertSafeRemoteResponse(response({ url: "http://evidence.example/a" }), 10), /HTTPS evidence boundary/);
  for (const hostname of ["localhost", "127.0.0.1", "10.1.2.3", "100.64.1.2", "192.168.1.2", "172.20.1.2", "198.18.1.2", "224.0.0.1", "[::1]", "[fc00::1]"]) {
    assert.throws(() => assertSafeRemoteResponse(response({ url: `https://${hostname}/a` }), 10), /private or local/);
  }
  assert.throws(() => assertSafeRemoteResponse(response({ headers: { "content-length": "11" } }), 10), /import limit/);
  assert.throws(() => assertSafeRemoteResponse(response({ status: 404 }), 10), /HTTP 404/);
});

test("remote evidence validates the initial URL and every redirect before issuing the next request", async () => {
  assert.throws(() => assertSafeRemoteUrl("http://evidence.example/a"), /credential-free HTTPS/);
  assert.throws(() => assertSafeRemoteUrl("https://user:secret@evidence.example/a"), /credential-free HTTPS/);
  assert.throws(() => assertSafeRemoteUrl("https://100.64.4.2/a"), /private, loopback, reserved/);

  let requests = 0;
  await assert.rejects(
    resolveUrlSource("https://evidence.example/start", {
      maxBytes: 100,
      fetchImpl: async (requestedUrl, options) => {
        requests += 1;
        assert.equal(options.redirect, "manual");
        assert.equal(requestedUrl, "https://evidence.example/start");
        return response({
          url: requestedUrl,
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        });
      },
    }),
    /private, loopback, reserved/,
  );
  assert.equal(requests, 1, "the private redirect target must never be fetched");
});

test("remote evidence follows a bounded verified HTTPS redirect chain", async () => {
  const visited = [];
  const result = await resolveUrlSource("https://evidence.example/start", {
    maxBytes: 10,
    fetchImpl: async (requestedUrl) => {
      visited.push(requestedUrl);
      if (requestedUrl.endsWith("/start")) {
        return response({ url: requestedUrl, status: 302, headers: { location: "/final.csv" } });
      }
      return response({ url: requestedUrl, chunks: [[65, 44, 66]], headers: { "content-type": "text/csv" } });
    },
  });
  assert.deepEqual(visited, ["https://evidence.example/start", "https://evidence.example/final.csv"]);
  assert.equal(result.name, "final.csv");
});

test("remote evidence enforces the limit during streaming and never returns partial bytes", async () => {
  await assert.rejects(
    resolveUrlSource("https://evidence.example/large.bin", {
      maxBytes: 4,
      fetchImpl: async () => response({ chunks: [[1, 2, 3], [4, 5]] }),
    }),
    /exceeded the bounded import size/,
  );
});

test("safe remote evidence returns bounded bytes, a sanitized name, and a query-free provenance URL", async () => {
  const result = await resolveUrlSource("https://evidence.example/request", {
    maxBytes: 10,
    fetchImpl: async () => response({
      url: "https://evidence.example/final%3Areport.csv?token=secret#fragment",
      chunks: [[65, 44, 66]],
      headers: { "content-type": "text/csv; charset=utf-8" },
    }),
  });
  assert.equal(result.name, "final_report.csv");
  assert.equal(result.mimeType, "text/csv");
  assert.deepEqual([...result.bytes], [65, 44, 66]);
  assert.equal(result.metadata.sourceUrl, "https://evidence.example/final%3Areport.csv");
});
