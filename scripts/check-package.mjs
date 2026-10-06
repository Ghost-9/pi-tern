#!/usr/bin/env node
/**
 * Verify the published artifact, not the repository.
 *
 * CI checks out the repo, so everything CI runs is true of the source and silent about the tarball.
 * That is how `npm pack pi-tern@1.1.8` shipped a package missing five of its own files, with a
 * `test` script naming eight test files and shipping none of them: `scripts/gate.sh` was included,
 * `test/` was not, so the shipped package could not run its own gate.
 *
 * This packs the real tarball, unpacks it into a temp directory, installs its dependencies and runs
 * the shipped checks inside it. It is the check that would have caught the v1.1.0-tagged run
 * publishing v1.1.8, and the only one that looks at what a user would actually receive.
 *
 *   node scripts/check-package.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-pkg-"));
const failures = [];

const record = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

try {
	// 1. Pack exactly what npm would publish.
	const packed = spawnSync("npm", ["pack", "--pack-destination", dir, "--json"], {
		cwd: root,
		encoding: "utf8",
		timeout: 120000,
	});
	if (packed.status !== 0) {
		console.error(`npm pack failed:\n${packed.stderr}`);
		process.exit(1);
	}
	const tarball = path.join(dir, JSON.parse(packed.stdout)[0].filename);
	record("npm pack produces a tarball", true, path.basename(tarball));

	// 2. Unpack it and read its manifest, which is the artifact's own idea of itself.
	execFileSync("tar", ["xzf", tarball, "-C", dir]);
	const pkgDir = path.join(dir, "package");
	const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	record("the tarball's version is the version we are releasing", manifest.version === version, `${manifest.version}`);

	// 3. Every file a shipped script names must actually be in the tarball.
	const named = new Set();
	for (const command of Object.values(manifest.scripts ?? {})) {
		for (const match of command.matchAll(/\b(test|lib|scripts|native)\/[A-Za-z0-9._-]+\.[a-z]+/g)) {
			named.add(match[0]);
		}
	}
	const gate = readFileSync(path.join(pkgDir, "scripts", "gate.sh"), "utf8");
	for (const match of gate.matchAll(/\b(test|lib|scripts|native)\/[A-Za-z0-9._-]+\.[a-z]+/g)) {
		named.add(match[0]);
	}
	const absent = [];
	for (const relative of named) {
		try {
			readFileSync(path.join(pkgDir, relative));
		} catch {
			absent.push(relative);
		}
	}
	record(
		"every path a shipped script names is present in the tarball",
		absent.length === 0,
		absent.length ? `missing: ${absent.join(", ")}` : `${named.size} referenced paths`,
	);

	// 4. The tests the manifest advertises are present and actually pass.
	const testFiles = [...(manifest.scripts?.test ?? "").matchAll(/\btest\/[A-Za-z0-9._-]+\.ts/g)].map((m) => m[0]);
	const missingTests = testFiles.filter((f) => {
		try {
			readFileSync(path.join(pkgDir, f));
			return false;
		} catch {
			return true;
		}
	});
	record("the advertised test suite is shipped", missingTests.length === 0, `${testFiles.length} files`);

	// 5. Install and run. This is the part that needs the network; it is the only real proof.
	record("tsconfig.json ships, so the shipped gate can typecheck", (() => {
		try {
			readFileSync(path.join(pkgDir, "tsconfig.json"));
			return true;
		} catch {
			return false;
		}
	})());

	if (process.env.PI_TERN_SKIP_PACKAGE_INSTALL === "1") {
		console.log("SKIP install-and-run (PI_TERN_SKIP_PACKAGE_INSTALL=1)");
	} else {
		const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
			cwd: pkgDir,
			encoding: "utf8",
			timeout: 300000,
		});
		record("the tarball's dependencies install", install.status === 0, install.status === 0 ? "" : install.stderr.slice(-200));

		const tests = spawnSync("npm", ["test"], { cwd: pkgDir, encoding: "utf8", timeout: 300000 });
		const summary = /tests (\d+)[\s\S]*?pass (\d+)[\s\S]*?fail (\d+)/.exec(tests.stdout ?? "");
		record(
			"the shipped suite passes from the tarball",
			tests.status === 0,
			summary ? `${summary[2]}/${summary[1]} pass, ${summary[3]} fail` : (tests.stdout ?? "").slice(-300),
		);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const failed = failures.length;
console.log(`\n${Object.keys({}).length === 0 && failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
