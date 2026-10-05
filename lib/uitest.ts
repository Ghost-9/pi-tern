/**
 * UI-test harness: run a Tern shot scenario, then optional control-endpoint assertions.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { shotScenarios } from "./ctl.ts";
import { runTern } from "./tern.ts";

export interface UiAssertion {
	type: "tree" | "a11y" | "state" | "css" | "webcall" | "dump" | "stats";
	selector?: string;
	expect?: string;
	command?: string[];
}

export interface UiTestResult {
	code: number;
	outDir: string;
	files: string[];
	shotOutput: string;
	assertions: Array<{ type: string; ok: boolean; detail: string }>;
	passed: boolean;
}

/** Run `tern shot` for a scenario file, then evaluate assertions against a control endpoint. */
export async function uiTest(options: {
	scenario: string;
	outDir?: string;
	control?: string;
	assertions?: UiAssertion[];
	timeoutMs?: number;
}): Promise<UiTestResult> {
	const outDir = options.outDir ?? path.join("/tmp", `pi-tern-uitest-${Date.now()}`);
	const shot = await shotScenarios([options.scenario], outDir, options.timeoutMs ?? 180000);
	const files: string[] = [];
	try {
		for (const entry of readdirSync(outDir, { recursive: true })) files.push(String(entry));
	} catch {
		/* no output */
	}
	const assertions: UiTestResult["assertions"] = [];
	for (const assertion of options.assertions ?? []) {
		if (!options.control) {
			assertions.push({ type: assertion.type, ok: false, detail: "no control endpoint provided" });
			continue;
		}
		const command = assertion.command ?? buildAssertionCommand(assertion);
		const result = await runTern(["ctl", "--control", options.control, ...command], 30000);
		const output = `${result.stdout}${result.stderr}`.trim();
		const ok = result.code === 0 && (!assertion.expect || output.includes(assertion.expect));
		assertions.push({
			type: assertion.type,
			ok,
			detail: `${command.join(" ")} → exit ${result.code}; ${output.slice(0, 300)}`,
		});
	}
	return {
		code: shot.code,
		outDir,
		files,
		shotOutput: shot.output,
		assertions,
		passed: shot.code === 0 && assertions.every((entry) => entry.ok),
	};
}

function buildAssertionCommand(assertion: UiAssertion): string[] {
	switch (assertion.type) {
		case "tree":
			return ["tree", assertion.selector ?? ""].filter(Boolean);
		case "a11y":
			return ["a11y", assertion.selector ?? ""].filter(Boolean);
		case "state":
			return ["state"];
		case "stats":
			return ["stats"];
		case "dump":
			return ["dump", assertion.selector ?? ""].filter(Boolean);
		case "css":
			return ["css", assertion.selector ?? ""].filter(Boolean);
		case "webcall": {
			if (!assertion.selector || !assertion.expect) return ["state"];
			return ["webcall", assertion.selector, assertion.expect];
		}
		default:
			return ["state"];
	}
}
