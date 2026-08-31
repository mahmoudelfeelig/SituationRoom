import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("CI creates a tested immutable release before deployment", async () => {
  const source = await read("../.github/workflows/ci.yml");
  const workflow = YAML.parse(source);
  assert.equal(workflow.name, "SituationRoom CI");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.release.needs, ["quality", "repository", "browser"]);
  assert.ok(source.indexOf("npm run build") < source.indexOf("npm run test:sites"));
  assert.match(source, /git archive/);
  assert.match(source, /situationroom-site\.tar\.gz\.sha256/);
  assert.match(source, /docker compose[^\n]+build --pull/);
  assert.match(source, /docker compose[^\n]+up[\s\\\n]+-d --no-build --wait/);
  assert.match(source, /docker save/);
  assert.match(source, /situationroom-release-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(source, /\|\s*grep -Fq/);
});

test("production release delegates to the immutable shared gateway", async () => {
  const source = await read("../.github/workflows/deploy-production.yml");
  const workflow = YAML.parse(source);
  assert.equal(workflow.name, "Deploy SituationRoom Production");
  assert.deepEqual(workflow.permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  });
  assert.match(source, /\.conclusion == 'success'/);
  assert.match(source, /\.event == 'push'/);
  assert.match(source, /head_repository\.full_name == github\.repository/);
  assert.equal(
    workflow.jobs.release.uses,
    "mahmoudelfeelig/HetznerReleaseGateway/.github/workflows/release.yml@f6319b2dbaf4c1f10230c6425967f34553acd61d",
  );
  assert.deepEqual(workflow.jobs.release.with, {
    app: "situationroom",
    source_sha: "${{ github.event.workflow_run.head_sha }}",
    ci_run_id: "${{ github.event.workflow_run.id }}",
  });
  assert.doesNotMatch(source, /secrets:\s*inherit/);
  assert.doesNotMatch(source, /\b(?:ssh|scp|rsync)\b/i);
  assert.doesNotMatch(source, /HETZNER_|SSH_PRIVATE_KEY|SSH_KNOWN_HOSTS/);
});

test("all external actions are pinned to immutable commits", async () => {
  const sources = await Promise.all([
    read("../.github/workflows/ci.yml"),
    read("../.github/workflows/deploy-production.yml"),
  ]);
  const uses = sources.join("\n").match(/uses:\s+[^\s]+/g) ?? [];
  assert.ok(uses.length >= 8);
  for (const entry of uses) {
    assert.match(entry, /@[0-9a-f]{40}$/);
  }
});

test("CI artifact contains only the tested image and its checksum authority", async () => {
  const source = await read("../.github/workflows/ci.yml");
  assert.match(source, /docker save/);
  assert.match(source, /situationroom-image\.tar\.gz/);
  assert.match(source, /SHA256SUMS/);
  assert.doesNotMatch(source, /deploy-release\.sh/);
  assert.doesNotMatch(source, /situationroom-files\.tar\.gz/);
});

test("no workflow can reintroduce a direct host credential path", async () => {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/i.test(name));
  const source = (
    await Promise.all(workflowNames.map((name) => readFile(new URL(name, workflowDirectory), "utf8")))
  ).join("\n");

  assert.doesNotMatch(source, /secrets:\s*inherit/);
  assert.doesNotMatch(source, /\b(?:ssh|scp|rsync)\b/i);
  assert.doesNotMatch(source, /\$\{\{\s*(?:secrets|vars)\.(?:HETZNER|SSH)_[A-Z0-9_]+\s*\}\}/);
});
