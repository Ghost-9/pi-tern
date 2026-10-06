/**
 * The capability contract.
 *
 * One machine-readable manifest describing what this build can do right now, in
 * this environment. Orchestrators read it instead of guessing; humans read it
 * from `/tern doctor --json`. `contract` is bumped only when the *shape* changes,
 * so a consumer can pin to it.
 */
import { detectRasterizer } from "./figure.ts";
import { ghStatus } from "./pr.ts";
import { readTernEnv, ternAvailable, type TernEnv } from "./tern.ts";

export const CONTRACT_VERSION = 1;

export type Requirement = "tern-cli" | "tern-pane" | "tern-daemon" | "gh" | "native" | "tern-plugin" | "pi";

export interface Capability {
	id: string;
	available: boolean;
	requires: Requirement[];
	/** Why it is unavailable, when it is. */
	reason?: string;
	/** The tool that exposes it, if any. */
	tool?: string;
}

export interface Manifest {
	name: "pi-tern";
	version: string;
	contract: number;
	environment: {
		inPane: boolean;
		ternCli: boolean;
		ternVersion?: string;
		multiplexer: boolean;
		platform: string;
		node: string;
		windowSocket: boolean;
		paneSocket: boolean;
		gh: { available: boolean; authenticated: boolean; detail?: string };
		rasterizer?: string;
		native: unknown;
	};
	tsp: { status: string; hello: unknown };
	tools: { direct: string[]; deferred: string[] };
	capabilities: Capability[];
}

export interface ManifestInput {
	version: string;
	directTools: string[];
	deferredTools: string[];
	probe: { status: string; hello: unknown };
	native?: unknown;
	tspKinds?: string[];
	tspFeatures?: string[];
}

/** Filesystem/daemon facts, gathered once per status call. */
export async function gatherEnvironment(env: TernEnv): Promise<Manifest["environment"]> {
	const availability = await ternAvailable();
	const gh = await ghStatus();
	return {
		inPane: env.inTern,
		ternCli: availability.cli,
		ternVersion: availability.version,
		multiplexer: Boolean(process.env.TMUX || process.env.STY || process.env.ZELLIJ),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		windowSocket: Boolean(env.windowSocket),
		paneSocket: Boolean(env.paneSocket),
		gh: { available: gh.available, authenticated: gh.authenticated, detail: gh.detail },
		rasterizer: detectRasterizer(),
		native: (globalThis as { __piTernNative?: { state?: () => unknown } }).__piTernNative?.state?.() ?? null,
	};
}

export function buildManifest(input: ManifestInput, environment: Manifest["environment"]): Manifest {
	const hasTern = environment.ternCli;
	const hasPane = environment.inPane;
	const hasGh = environment.gh.available && environment.gh.authenticated;
	const native = environment.native !== null && environment.native !== undefined;

	const capability = (
		id: string,
		available: boolean,
		requires: Requirement[],
		reason: string | undefined,
		tool?: string,
	): Capability => ({ id, available, requires, ...(reason ? { reason } : {}), ...(tool ? { tool } : {}) });

	const capabilities: Capability[] = [
		capability("diagram.mermaid", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_diagram"),
		capability("figure.chart", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_chart"),
		capability("figure.png", hasTern || Boolean(environment.rasterizer), ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_chart"),
		capability("browser.pip", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_browser"),
		capability("pane.run", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_run"),
		capability("pane.capture", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_capture"),
		capability("pane.events", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_watch"),
		capability("fleet.spawn", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_fleet"),
		capability("worktree", true, ["pi"], undefined, "tern_worktree"),
		capability(
			"pr.summary",
			hasGh,
			["gh"],
			environment.gh.available
				? environment.gh.authenticated
					? undefined
					: "gh is not authenticated (run `gh auth login`)"
				: "gh is not installed",
			"tern_pr",
		),
		capability("pr.watch.pane", hasGh && hasTern, ["gh", "tern-cli"], hasTern ? undefined : "Tern CLI unavailable", "tern_pr"),
		capability("data.docs", hasTern && hasPane || native, ["tern-plugin"], "needs the pi-bridge mailbox (window-half plugin)", "tern_doc"),
		capability("data.boards", hasTern, ["tern-plugin"], undefined, "tern_board"),
		capability("data.sqlite", hasTern, ["tern-plugin"], undefined, "tern_db"),
		capability("carly.ask", hasTern, ["tern-plugin"], undefined, "tern_carly"),
		capability("ui.test", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_ui_test"),
		capability("shot.golden", hasTern, ["tern-cli"], undefined, "tern_shot"),
		capability("remote.hosts", hasTern, ["tern-cli"], undefined, "tern_remote"),
		capability("status.title", hasPane, ["tern-pane"], hasPane ? undefined : "not running in a Tern pane"),
		capability("tsp.probe", hasPane, ["tern-pane"], hasPane ? undefined : "not running in a Tern pane"),
		capability(
			"native.surfaces",
			native,
			["native"],
			native ? undefined : "start pi through the pi-tern launcher inside Tern with PI_TERN_NATIVE=1",
		),
		capability(
			"native.inlineImages",
			native && (input.tspFeatures ?? []).includes("blobs"),
			["native", "tern-cli"],
			native
				? (input.tspFeatures ?? []).includes("blobs")
					? undefined
					: "this Tern build does not advertise the `blobs` feature"
				: "native mode is not active",
		),
		capability("mirror.session", true, ["pi"], undefined),
		capability("bell", Boolean(process.env.PI_TERN_BELL), ["pi"], "opt-in: PI_TERN_BELL=1"),
	];

	return {
		name: "pi-tern",
		version: input.version,
		contract: CONTRACT_VERSION,
		environment,
		tsp: { status: input.probe.status, hello: input.probe.hello },
		tools: { direct: input.directTools, deferred: input.deferredTools },
		capabilities,
	};
}

/** One line per capability, for `/tern doctor` and bug reports. */
export function renderManifest(manifest: Manifest): string {
	const lines: string[] = [
		`pi-tern ${manifest.version} · contract ${manifest.contract}`,
		`tern ${manifest.environment.ternVersion ?? "unavailable"} · inPane=${manifest.environment.inPane} · multiplexer=${manifest.environment.multiplexer} · ${manifest.environment.platform}`,
		`gh ${manifest.environment.gh.available ? (manifest.environment.gh.authenticated ? "authenticated" : "not authenticated") : "missing"} · tsp=${manifest.tsp.status}`,
		"",
	];
	for (const item of manifest.capabilities) {
		const mark = item.available ? "ok  " : "off ";
		lines.push(`${mark}${item.id.padEnd(22)} ${item.tool ?? ""}${item.available ? "" : `  — ${item.reason ?? "unavailable"}`}`);
	}
	return lines.join("\n");
}

export function readEnvSafe(): TernEnv {
	return readTernEnv();
}
