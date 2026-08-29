import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Hetzner deployment stays private behind the shared Caddy network", async () => {
  const [compose, dockerfile] = await Promise.all([
    read("../deploy/hetzner/docker-compose.yml"),
    read("../deploy/hetzner/Dockerfile"),
  ]);
  assert.match(compose, /container_name:\s+situationroom-web/);
  assert.match(compose, /expose:\s*[\s\S]*"8080"/);
  assert.match(compose, /web:\s*[\s\S]*external:\s+true/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only:\s+true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /\/config:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700/);
  assert.match(compose, /\/data:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700/);
  assert.match(dockerfile, /setcap -r \/usr\/bin\/caddy/);
  assert.match(dockerfile, /adduser[^\n]+10001/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /USER caddy/);
});

test("static hosting preserves asset errors and narrowly scopes SPA fallback", async () => {
  const caddy = await read("../deploy/hetzner/Caddyfile");
  assert.match(caddy, /@existingAssets/);
  assert.match(caddy, /@missingAssets/);
  assert.match(caddy, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(caddy, /Cache-Control "no-store"/);
  assert.match(caddy, /@uncached not path \/assets\/\* \/source\/\*/);
  assert.match(caddy, /public, no-cache, max-age=0, must-revalidate, no-transform/);
  assert.match(caddy, /@api path \/api \/api\/\*/);
  assert.match(caddy, /method GET HEAD/);
  assert.match(caddy, /header Accept \*text\/html\*/);
  assert.match(caddy, /not path \/assets\/\* \/source\/\* \/api \/api\/\*/);
  assert.match(caddy, /rewrite @spa \/index\.html/);
  assert.doesNotMatch(caddy, /Content-Encoding/);
});

test("public route and document metadata describe the general Decision OS", async () => {
  const [route, html, vite] = await Promise.all([
    read("../deploy/hetzner/Caddyfile.public"),
    read("../index.html"),
    read("../vite.config.mjs"),
  ]);
  assert.match(route, /situationroom\.elfeel\.me/);
  assert.match(route, /reverse_proxy situationroom-web:8080/);
  assert.match(html, /Agent-Constructed Decision OS/);
  assert.doesNotMatch(html, /Procurement Decisions/);
  assert.match(vite, /stableOcrModelFile = "assets\/ocr\/4\.0\.0_best_int\/eng\.traineddata\.gz"/);
});
