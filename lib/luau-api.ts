/**
 * Read Tern's plugin API declaration and check the Luau this extension ships against it.
 *
 * `tern plugin types DIR` writes `DIR/tern.d.luau`: the authoritative contract for the `tern` module
 * and the `cx` value a window plugin is given. Before 1.2 nothing compared pi-tern's Luau with it —
 * the plugin was written against 0.5.x by hand and a renamed method would only show up as a panel
 * that silently stopped updating, because a window entry that throws is caught by Tern and reported
 * where nobody looks. Two measured facts make a static check worth having:
 *
 *   - the vocabulary *did* drift (0.5.x → 0.9.8 lost `program-palette`, added `row`/`media`), so
 *     "the API is stable" is not an assumption this project can make;
 *   - `tern plugin reload` reports `status: "ready"` for a window entry it has not compiled (a
 *     window start is what compiles it), so the load status is not evidence either.
 *
 * The parser is deliberately small and shape-aware rather than a Luau parser: it reads the two
 * declaration forms Tern emits (`declare tern: { … }` and `declare extern type NAME with … end`),
 * ignoring `---` doc comments, and it only needs to answer "is this member declared".
 */

/** Members of `cx` and the extern type each one is, as declared in `declare extern type WindowCx`. */
const CX_TYPES: Record<string, string> = {
	session: "SessionCx",
	sessions: "SessionsCx",
	hosts: "HostsCx",
	layout: "LayoutCx",
	canvas: "CanvasCx",
	whiteboard: "WhiteboardCx",
	docs: "DocsCx",
	board: "BoardCx",
	browser: "BrowserCx",
	db: "DbCx",
	settings: "SettingsCx",
	git: "GitCx",
	notebook: "NotebookCx",
	actions: "ActionsCx",
	agents: "AgentsCx",
	procs: "ProcsCx",
	screen: "ScreenCx",
};

export interface DeclaredApi {
	/** Dotted paths inside `declare tern`, e.g. `tern.ui`, `tern.ui.bars`, `tern.carly.export`. */
	tern: string[];
	/** `tern.ui`'s and `tern.carly`'s members are covered by the dotted paths; these are the extern types. */
	externTypes: Record<string, string[]>;
}

export interface UsedSymbols {
	/** Dotted `tern.*` paths the Luau refers to. */
	tern: string[];
	/** `cx` member → the methods it calls (empty when it only passes the table along). */
	cx: Record<string, string[]>;
}

/** Strip Luau line comments so prose about `cx.*` cannot be read as a call. */
function stripComments(source: string): string {
	return source
		.split("\n")
		.map((line) => {
			const index = line.indexOf("--");
			return index === -1 ? line : line.slice(0, index);
		})
		.join("\n");
}

/**
 * Extract the declared API from a `tern.d.luau`.
 *
 * Comments are removed first: `--- …` lines carry prose (`{label, value}` pairs, `cx` and `tern.fs`
 * mentions) that would otherwise open a table or be read as a member.
 */
export function extractDeclaredApi(typesSource: string): DeclaredApi {
	const text = typesSource.replace(/^\s*---.*$/gm, "");
	const ternStart = text.indexOf("declare tern:");
	const body = ternStart === -1 ? "" : text.slice(ternStart);

	const tern = new Set<string>();
	const stack: string[] = [];
	let pending: string | null = null;
	let paren = 0;
	let i = 0;
	const here = () => stack.join(".");
	while (i < body.length) {
		const ch = body[i] as string;
		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < body.length && /[A-Za-z0-9_]/.test(body[j] as string)) j += 1;
			if (paren === 0) pending = body.slice(i, j);
			i = j;
			continue;
		}
		if (ch === "(") {
			paren += 1;
			i += 1;
			continue;
		}
		if (ch === ")") {
			paren = Math.max(0, paren - 1);
			i += 1;
			continue;
		}
		if (ch === "{") {
			// `role: { … }` opens a namespace; a function type's braces are balanced on one line.
			if (pending) {
				stack.push(pending);
				tern.add(here());
			} else {
				stack.push("?");
			}
			pending = null;
			i += 1;
			continue;
		}
		if (ch === "}") {
			stack.pop();
			pending = null;
			i += 1;
			continue;
		}
		if (ch === ":") {
			if (pending && paren === 0 && stack.length > 0) tern.add(`${here()}.${pending}`);
			i += 1;
			continue;
		}
		if (ch === ",") {
			pending = null;
			i += 1;
			continue;
		}
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		pending = null;
		i += 1;
	}

	// `declare extern type NAME with` … `end`: members are `name: Type` or `function name(self, …)`.
	const externTypes: Record<string, string[]> = {};
	const lines = text.split("\n");
	for (let n = 0; n < lines.length; n += 1) {
		const header = (lines[n] as string).match(/^declare extern type (\w+) with\s*$/);
		if (!header) continue;
		const members = new Set<string>();
		for (let k = n + 1; k < lines.length; k += 1) {
			const line = lines[k] as string;
			if (/^end\s*$/.test(line)) break;
			const member = line.match(/^\t(?:function )?([a-z_][a-z0-9_]*)/);
			if (member?.[1]) members.add(member[1]);
		}
		externTypes[header[1] as string] = [...members].sort();
	}

	return { tern: [...tern].sort(), externTypes };
}

/** The `tern.*` paths and `cx` members a Luau source uses. */
export function extractUsedSymbols(luauSource: string): UsedSymbols {
	const source = stripComments(luauSource);
	const tern = new Set<string>();
	for (const match of source.matchAll(/\btern\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g)) {
		tern.add(match[2] ? `tern.${match[1]}.${match[2]}` : `tern.${match[1]}`);
	}
	const cx: Record<string, string[]> = {};
	for (const match of source.matchAll(/\bcx\.([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_][A-Za-z0-9_]*))?/g)) {
		const member = match[1] as string;
		const methods = cx[member] ?? [];
		if (match[2] && !methods.includes(match[2])) methods.push(match[2]);
		cx[member] = methods;
	}
	for (const member of Object.keys(cx)) cx[member] = (cx[member] as string[]).sort();
	return { tern: [...tern].sort(), cx };
}

export interface ApiCheck {
	/** Symbols the Luau uses that the declaration does not contain. */
	missing: string[];
	used: number;
	declaredTern: number;
	declaredTypes: number;
}

/**
 * Compare one or more Luau sources against a declaration.
 *
 * A `tern.ui.<x>` path is satisfied by `tern.ui` itself *and* by an exact member, because the
 * declaration writes some UI helpers as nested tables and others as function members. Members are
 * checked exactly: a renamed `bars` is the failure this exists to catch.
 */
export function checkApi(typesSource: string, luauSources: string[]): ApiCheck {
	return checkAgainst(extractDeclaredApi(typesSource), luauSources);
}

/** The same comparison against an already-extracted declaration (a cached fixture, say). */
export function checkAgainst(declared: DeclaredApi, luauSources: string[]): ApiCheck {
	const ternDeclared = new Set(declared.tern);
	const missing: string[] = [];
	let used = 0;

	for (const source of luauSources) {
		const symbols = extractUsedSymbols(source);
		for (const path of symbols.tern) {
			used += 1;
			// Members are declared as `name: (…) -> …` and are in `ternDeclared`; a nested table with
			// no members (`tern.ui: { }`) satisfies `tern.ui` and nothing below it, which is correct.
			if (ternDeclared.has(path)) continue;
			missing.push(path);
		}
		for (const [member, methods] of Object.entries(symbols.cx)) {
			used += 1;
			const typeName = CX_TYPES[member];
			const members = typeName ? declared.externTypes[typeName] : undefined;
			if (!members) {
				missing.push(`cx.${member}`);
				continue;
			}
			for (const method of methods) {
				used += 1;
				if (!members.includes(method)) missing.push(`cx.${member}:${method}`);
			}
		}
	}

	return {
		missing: [...new Set(missing)].sort(),
		used,
		declaredTern: declared.tern.length,
		declaredTypes: Object.keys(declared.externTypes).length,
	};
}
