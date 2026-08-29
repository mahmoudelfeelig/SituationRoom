import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("CI creates a tested immutable release before deployment", async () => {
  const source = await read("../.github/workflows/ci.yml");
  const workflow = YAML.parse(source);
  assert.equal(workflow.name, "SituationRoom CI");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.release.needs, ["quality", "repository", "browser"]);
  assert.match(source, /git archive/);
  assert.match(source, /situationroom-site\.tar\.gz\.sha256/);
  assert.match(source, /docker compose[^\n]+build --pull/);
  assert.match(source, /docker compose[^\n]+up[\s\\\n]+-d --no-build --wait/);
  assert.match(source, /docker save/);
  assert.match(source, /situationroom-release-\$\{\{ github\.sha \}\}/);
});

test("production deploy is bound to successful main CI and strict SSH", async () => {
  const source = await read("../.github/workflows/deploy-production.yml");
  const workflow = YAML.parse(source);
  assert.equal(workflow.name, "Deploy SituationRoom Production");
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.concurrency.group, "situationroom-production");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.deploy.environment, "production");
  assert.match(source, /\.conclusion == 'success'/);
  assert.match(source, /\.event == 'push'/);
  assert.match(source, /head_repository\.full_name == github\.repository/);
  assert.match(source, /StrictHostKeyChecking=yes/g);
  assert.doesNotMatch(source, /StrictHostKeyChecking=no/);
  assert.doesNotMatch(source, /git reset --hard/);

  const transferIndex = source.indexOf('"${SCP[@]}"');
  const finalRefIndex = source.lastIndexOf("/git/ref/heads/main");
  const activationIndex = source.lastIndexOf('"${SSH[@]}"');
  assert.ok(transferIndex < finalRefIndex, "main must be revalidated after transfer");
  assert.ok(finalRefIndex < activationIndex, "main must be revalidated immediately before activation");
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

test("server activation validates scope and carries rollback and smoke gates", async () => {
  const source = await read("../deploy/hetzner/deploy-release.sh");
  assert.match(source, /DEPLOY_ROOT.*\/opt\/situationroom/);
  assert.match(source, /Release SHA must contain exactly 40/);
  assert.match(source, /trap rollback EXIT/);
  assert.match(source, /restoring the previous Compose release/);
  assert.match(source, /compose up -d --no-build --wait/);
  assert.match(source, /release\.json\?sha=\$RELEASE_SHA/);
  assert.match(source, /missing_status/);
  assert.doesNotMatch(source, /sudo/);

  const rollbackArmedIndex = source.indexOf("PRODUCTION_CHANGED=true");
  const composeSwapIndex = source.indexOf('mv "$NEXT_COMPOSE" "$COMPOSE_FILE"');
  assert.ok(rollbackArmedIndex < composeSwapIndex, "rollback must be armed before the first stable-file mutation");
});
