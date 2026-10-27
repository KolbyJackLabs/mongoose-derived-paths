// Cuts a release: bumps the version on dev, merges dev into main as
// "release: vX.Y.Z", tags it, and (after confirmation) pushes dev, main and the
// tag. Pushing the tag runs .github/workflows/publish.yml, which publishes to npm.
//
//   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--no-push]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const [bump, ...flags] = process.argv.slice(2);
const push = !flags.includes("--no-push");

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  fail("Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--no-push]");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: "inherit" });

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Preconditions: a clean dev that matches origin, and a main that dev can merge into.
if (git("branch", "--show-current") !== "dev") fail("Run releases from the dev branch.");
if (git("status", "--porcelain")) fail("Working tree is not clean.");
git("fetch", "--quiet", "--tags", "origin");
if (git("rev-parse", "dev") !== git("rev-parse", "origin/dev")) fail("dev is not in sync with origin/dev.");

// Build and test before touching any branch (prepublishOnly runs these again at publish time).
run("npm", "run", "build");
run("npm", "test");
run("npm", "run", "test:types");

run("npm", "version", bump, "--no-git-tag-version");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;
if (git("tag", "--list", tag)) {
  git("checkout", "package.json", "package-lock.json");
  fail(`Tag ${tag} already exists; version bump reverted.`);
}

git("add", "package.json", "package-lock.json");
git("commit", "--quiet", "-m", `chore: bump version to ${version}`);

git("switch", "--quiet", "main");
git("merge", "--quiet", "--ff-only", "origin/main");
git("merge", "--quiet", "--no-ff", "dev", "-m", `release: ${tag}`);
git("tag", tag);
git("switch", "--quiet", "dev");

console.log(`\nPrepared ${tag}: version bump on dev, "release: ${tag}" on main, tag ${tag} (all local).`);

const pushCommands = `git push origin dev main && git push origin ${tag}`;
let confirmed = false;
if (push) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Push dev, main and ${tag} to origin? This publishes ${version} to npm via publish.yml. [y/N] `);
  rl.close();
  confirmed = /^y(es)?$/i.test(answer.trim());
}

if (!confirmed) {
  console.log(`Not pushed. To publish later, run:\n  ${pushCommands}`);
  process.exit(0);
}

// Branches first, so the tag's commit is already on main when publish.yml starts.
run("git", "push", "origin", "dev", "main");
run("git", "push", "origin", tag);
console.log(`\nPushed ${tag}. Follow the publish run with: gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId -q '.[0].databaseId')`);
console.log(`If it fails, publish by hand from main: git switch main && npm publish --access public`);
