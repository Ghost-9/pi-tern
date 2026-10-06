/**
 * Loader transform (native mode only).
 *  - pi-tui terminal.js: wrap ProcessTerminal.write into the TSP sink and
 *    filter TSP `e` events out of pty input.
 *  - pi-tui editor.js / pi custom-editor.js: register the editor classes so the
 *    sink can capture the live composer and publish a native `editor` node.
 * Fail-open: any sink error falls back to the original ANSI write.
 */
const backendUrl = new URL("./backend.mjs", import.meta.url).href;

const TERMINAL_PATCH = `
import { createNativeSink as __createNativeSink } from ${JSON.stringify(backendUrl)};
if (process.env.PI_TERN_NATIVE === "1" && typeof ProcessTerminal === "function") {
  const __hello = (() => { try { return JSON.parse(process.env.PI_TERN_HELLO || "{}"); } catch { return {}; } })();
  const __sink = __createNativeSink({
    hello: __hello,
    recordPath: process.env.PI_TERN_TSP_RECORD,
    adopt: process.env.PI_TERN_ADOPT === "1",
    surfaceId: process.env.PI_TERN_SURFACE_ID || undefined,
  });
  const __origWrite = ProcessTerminal.prototype.write;
  ProcessTerminal.prototype.write = function (data) {
    // 'active === false' means the surface was handed back (wrong block kind, or a sink failure):
    // pi's own ANSI must reach the grid again, or the pane stays blank forever.
    if (__sink.active === false) return __origWrite.call(this, data);
    try {
      __sink.feed(String(data));
    } catch {
      __sink.active = false;
      return __origWrite.call(this, data);
    }
  };
  const __origStart = ProcessTerminal.prototype.start;
  ProcessTerminal.prototype.start = function (onInput, onResize) {
    const wrapped = (data) => {
      if (typeof data !== "string" || __sink.active === false) return onInput(data);
      let rest = data;
      try { rest = __sink.handleInput(data); } catch { rest = data; }
      if (rest) onInput(rest);
    };
    return __origStart.call(this, wrapped, onResize);
  };
  globalThis.__piTernNative = {
    state: () => __sink.nativeState(),
    suspend: () => __sink.suspend(),
    resume: () => __sink.resume(),
    /**
     * Give the pane back to pi's own TUI and stop drawing a surface.
     *
     * This is the escape hatch for the one case that used to fail silently: Tern only DISPLAYS a TSP
     * surface in an *agent* block. In a shell block the frames are accepted and the surface
     * materialises, but nothing is ever drawn — so the pane goes blank with no error anywhere. The
     * extension detects that (via the plugin's pane kind) and calls this, which puts pi's ANSI back
     * on the grid so the session is usable and the warning is readable.
     */
    fallback: (reason) => {
      try { __sink.close(); } catch {}
      __sink.active = false;
      globalThis.__piTernNativeFellBack = reason || "native surfaces are not displayed here";
      return true;
    },
  };
  process.once("exit", () => { try { __sink.close(); } catch {} });
}
`;

const EDITOR_CAPTURE = `
try { globalThis.__piTernEditorBase = Editor; } catch {}
`;

const CUSTOM_EDITOR_CAPTURE = `
try { globalThis.__piTernEditorClass = CustomEditor; } catch {}
`;

export async function load(url, context, next) {
	const result = await next(url, context);
	if (result.format !== "module") return result;
	const source = String(result.source);
	if (url.includes("/@earendil-works/pi-tui/dist/terminal.js")) {
		return { ...result, source: `${source}\n${TERMINAL_PATCH}` };
	}
	if (url.includes("/@earendil-works/pi-tui/dist/components/editor.js")) {
		return { ...result, source: `${source}\n${EDITOR_CAPTURE}` };
	}
	if (url.includes("/pi-coding-agent/dist/modes/interactive/components/custom-editor.js")) {
		return { ...result, source: `${source}\n${CUSTOM_EDITOR_CAPTURE}` };
	}
	return result;
}
