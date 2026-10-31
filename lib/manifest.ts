/**
 * The capability contract.
 *
 * One machine-readable manifest describing what this build can do right now, in
 * this environment. Orchestrators read it instead of guessing; humans read it
 * from `/tern doctor --json`. `contract` is bumped only when the *shape* changes,
 * so a consumer can pin to it.
 */
import { bridgeStatus } from "./bridge.ts";
import { detectRasterizer } from "./figure.ts";
import { describeIdentity, resolveIdentity, type TernIdentity } from "./identity.ts";
import { ghStatus } from "./pr.ts";
import { readTernEnv, ternAvailable, versionAtLeast, SESSION_VERBS_SINCE, type TernEnv } from "./tern.ts";
import { TSP_KNOWN_MAX, negotiateHello, type HelloNegotiation, type TspHello } from "./tsp.ts";

export const CONTRACT_VERSION = 1;

export type Requirement = "tern-cli" | "tern-pane" | "tern-daemon" | "gh" | "native" | "tern-plugin" | "pi";

/**
 * How much of a capability is proven.
 *
 * The README has carried a stable/experimental column since 1.0; the manifest did not, so an
 * orchestrator reading `/tern doctor --json` could not tell "measured on 0.9.8" from "wired up and
 * not yet seen working". Everything here that has not been observed end to end says `experimental`
 * — a claim with no evidence behind it is worse than no claim.
 */
export type Maturity = "stable" | "experimental";

export interface Capability {
	id: string;
	available: boolean;
	requires: Requirement[];
	/** Why it is unavailable, when it is. */
	reason?: string;
	/** The tool that exposes it, if any. */
	tool?: string;
	maturity?: Maturity;
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
		/** The pi-bridge Tern plugin: the data plane and Carly need it, and a stale copy is a failure. */
		bridge: { installed: boolean; upToDate: boolean; version?: string; status?: string; problems?: unknown[] };
		/**
		 * What the Tern CLI says about itself.
		 *
		 * `sessionVerbs` is the 0.9 capability boundary (`whoami`, `process`, `pip`, `dock`): the
		 * reason strings below quote the version, so a consumer can tell "this Tern is too old"
		 * from "this Tern is missing something". Optional because a hand-built environment (tests,
		 * an older consumer) predates it.
		 */
		tern?: {
			version?: string;
			commit?: string;
			sessionVerbs: boolean;
			configDir?: string;
			daemonSocket?: boolean;
			identity?: TernIdentity;
		};
		rasterizer?: string;
		native: unknown;
	};
	tsp: { status: string; hello: unknown; negotiation?: HelloNegotiation };
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
	let bridge: Manifest["environment"]["bridge"] = { installed: false, upToDate: false };
	if (availability.cli) {
		try {
			bridge = await bridgeStatus();
		} catch {
			/* an unreadable plugin list reads as "not installed", which is honest */
		}
	}
	// Not cached behind `inPane`: a headless agent still has an identity to report, and asking is
	// one subprocess at most (TERN_IDENTITY answers it for free inside a pane).
	const identity = await resolveIdentity().catch(() => null);
	return {
		inPane: env.inTern,
		ternCli: availability.cli,
		ternVersion: availability.version,
		tern: {
			...(availability.release ? { version: availability.release.version } : {}),
			...(availability.release?.commit ? { commit: availability.release.commit } : {}),
			sessionVerbs: availability.cli && versionAtLeast(availability.release, SESSION_VERBS_SINCE),
			...(env.configDir ? { configDir: env.configDir } : {}),
			...(env.daemonSocket ? { daemonSocket: true } : {}),
			...(identity ? { identity } : {}),
		},
		multiplexer: Boolean(process.env.TMUX || process.env.STY || process.env.ZELLIJ),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		windowSocket: Boolean(env.windowSocket),
		paneSocket: Boolean(env.paneSocket),
		gh: { available: gh.available, authenticated: gh.authenticated, detail: gh.detail },
		bridge,
		rasterizer: detectRasterizer(),
		native: (globalThis as { __piTernNative?: { state?: () => unknown } }).__piTernNative?.state?.() ?? null,
	};
}

export function buildManifest(input: ManifestInput, environment: Manifest["environment"]): Manifest {
	const hasTern = environment.ternCli;
	const hasPane = environment.inPane;
	const hasGh = environment.gh.available && environment.gh.authenticated;
	const native = environment.native !== null && environment.native !== undefined;
	// The data plane and Carly are served by the Tern plugin, not by the CLI: claiming them from
	// "the CLI answered" was wrong, and an orchestrator that trusted it scheduled work that always
	// failed. A pane is not required — a Tern window with the plugin is.
	const bridgeReady = environment.bridge.installed && environment.bridge.upToDate;
	const bridgeReason = environment.bridge.installed
		? `the pi-bridge Tern plugin is v${environment.bridge.version ?? "?"}, not the shipped version — reload it`
		: "the pi-bridge Tern plugin is not installed in a Tern window (run /tern bridge install)";

	const capability = (
		id: string,
		available: boolean,
		requires: Requirement[],
		reason: string | undefined,
		tool?: string,
		maturity: Maturity = "stable",
	): Capability => ({
		id,
		available,
		requires,
		...(reason ? { reason } : {}),
		...(tool ? { tool } : {}),
		maturity,
	});

	// The 0.9 session verbs. Greying them out with the version in the reason is the difference
	// between "your Tern is too old" and a tool that answers `tern whoami: No such file`.
	// `reason` means "why it is unavailable", so it is only set when the verb cannot run. It used to be
	// computed unconditionally, which meant a working 0.9.8 build reported
	// {available: true, reason: "needs Tern 0.9.0 or newer ... this build is 0.9.8"} on every one of
	// these four capabilities — the exact shape a consumer reads as "broken" on a healthy install.
	const sessionVerbs = environment.tern?.sessionVerbs === true;
	const sessionReason = sessionVerbs
		? undefined
		: !environment.ternCli
			? "Tern CLI unavailable"
			: `needs Tern ${SESSION_VERBS_SINCE} or newer (\`tern whoami\`, \`tern process\`, \`tern pip\`); this build is ${environment.tern?.version ?? "an unreported version"}`;

	// `whoami` is the one 0.9 verb that requires a pane rather than a daemon. Measured on 0.9.8:
	// outside a pane it refuses with "not inside a Tern pane (TERN_PANE_SOCKET and TERN_PANE are
	// unset)", before it even looks for a daemon, while `process`, `pip`, `dock`, `move` and
	// `rename` all answer "no Tern is running" instead — they work from anywhere a daemon serves.
	// So only identity needs `tern-pane`, and only identity is unavailable outside one.
	const identityAvailable = sessionVerbs && hasPane;
	const identityReason = sessionVerbs
		? hasPane
			? undefined
			: "not inside a Tern pane: `tern whoami` reports the identity of the pane it runs in"
		: sessionReason;

	const capabilities: Capability[] = [
		capability("diagram.mermaid", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_diagram"),
		capability("figure.chart", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_chart"),
		// PNG figures do not need Tern: a local rasterizer is enough. So the reason follows the same
		// rule as every other capability here - it describes why it is *unavailable*, which means it
		// is absent when a rasterizer makes the capability work without the CLI. Found by the
		// manifest-wide invariant test, not by reading this line.
		capability(
			"figure.png",
			hasTern || Boolean(environment.rasterizer),
			["tern-cli"],
			hasTern || environment.rasterizer ? undefined : "no Tern CLI and no local rasterizer (rsvg-convert or resvg)",
			"tern_chart",
		),
		capability("browser.pip", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_browser"),
		capability("pane.run", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_run"),
		capability("pane.capture", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_capture"),
		capability("pane.events", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_watch"),
		capability("pane.process", sessionVerbs, ["tern-cli"], sessionReason, "tern_session"),
		capability("session.identity", identityAvailable, ["tern-cli", "tern-pane"], identityReason, "tern_session"),
		// Measured on 0.9.8 headlessly only as far as Tern's own refusals (`powers a second block`,
		// `not a picture in picture`): the arrangement itself was never seen on screen.
		capability("session.layout", sessionVerbs, ["tern-cli"], sessionReason, "tern_session", "experimental"),
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
		capability("data.docs", bridgeReady, ["tern-plugin"], bridgeReady ? undefined : bridgeReason, "tern_doc"),
		capability("data.boards", bridgeReady, ["tern-plugin"], bridgeReady ? undefined : bridgeReason, "tern_board"),
		capability("data.sqlite", bridgeReady, ["tern-plugin"], bridgeReady ? undefined : bridgeReason, "tern_db"),
		capability("carly.ask", bridgeReady, ["tern-plugin"], bridgeReady ? undefined : bridgeReason, "tern_carly"),
		capability("ui.test", hasTern, ["tern-cli"], environment.ternCli ? undefined : "Tern CLI unavailable", "tern_ui_test"),
		capability("shot.golden", hasTern, ["tern-cli"], hasTern ? undefined : "Tern CLI unavailable", "tern_shot"),
		capability("plugin.types", sessionVerbs, ["tern-cli"], sessionReason, "tern_bridge", "experimental"),
		capability("remote.hosts", hasTern, ["tern-cli"], hasTern ? undefined : "Tern CLI unavailable", "tern_remote"),
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
		capability("bell", Boolean(process.env.PI_TERN_BELL), ["pi"], process.env.PI_TERN_BELL ? undefined : "opt-in: PI_TERN_BELL=1"),
	];

	const hello = input.probe.hello as TspHello | null;
	return {
		name: "pi-tern",
		version: input.version,
		contract: CONTRACT_VERSION,
		environment,
		tsp: {
			status: input.probe.status,
			hello: input.probe.hello,
			...(hello ? { negotiation: negotiateHello(hello) } : {}),
		},
		tools: { direct: input.directTools, deferred: input.deferredTools },
		capabilities,
	};
}

/** One line per capability, for `/tern doctor` and bug reports. */
export function renderManifest(manifest: Manifest): string {
	const tern = manifest.environment.tern;
	const identity = tern?.identity ? describeIdentity(tern.identity) : "unknown (this Tern does not answer `whoami --json`)";
	const tsp = manifest.tsp.negotiation
		? `TSP v${manifest.tsp.negotiation.version}${manifest.tsp.negotiation.future ? ` (newer than the v${TSP_KNOWN_MAX} this build speaks)` : ""}`
		: `TSP ${manifest.tsp.status}`;
	const lines: string[] = [
		`pi-tern ${manifest.version} · contract ${manifest.contract}`,
		`tern ${manifest.environment.ternVersion ?? "unavailable"} · ${tsp} · identity ${identity}`,
		`inPane=${manifest.environment.inPane} · multiplexer=${manifest.environment.multiplexer} · ${manifest.environment.platform}`,
		`gh ${manifest.environment.gh.available ? (manifest.environment.gh.authenticated ? "authenticated" : "not authenticated") : "missing"} · bridge ${manifest.environment.bridge.installed ? `${manifest.environment.bridge.upToDate ? "current" : "stale"}${manifest.environment.bridge.status ? ` (${manifest.environment.bridge.status})` : ""}` : "not installed"}`,
		"",
	];
	for (const item of manifest.capabilities) {
		const mark = item.available ? "ok  " : "off ";
		const maturity = item.maturity === "experimental" ? "  [experimental]" : "";
		lines.push(`${mark}${item.id.padEnd(22)} ${item.tool ?? ""}${maturity}${item.available ? "" : `  — ${item.reason ?? "unavailable"}`}`);
	}
	return lines.join("\n");
}

export function readEnvSafe(): TernEnv {
	return readTernEnv();
}
