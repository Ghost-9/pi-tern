/**
 * Loader transform: after pi-tui's terminal.js loads, wrap ProcessTerminal.write
 * so that in native mode every frame goes to the TSP sink instead of stdout.
 * Fail-open: any sink error falls back to the original ANSI write.
 */
const backendUrl = new URL("./backend.mjs", import.meta.url).href;

const PATCH = `
import { createNativeSink as __createNativeSink } from ${JSON.stringify(backendUrl)};
if (process.env.PI_TERN_NATIVE === "1" && typeof ProcessTerminal === "function") {
  const __hello = (() => { try { return JSON.parse(process.env.PI_TERN_HELLO || "{}"); } catch { return {}; } })();
  const __sink = __createNativeSink({ hello: __hello, recordPath: process.env.PI_TERN_TSP_RECORD });
  const __origWrite = ProcessTerminal.prototype.write;
  ProcessTerminal.prototype.write = function (data) {
    try {
      __sink.feed(String(data));
    } catch {
      __sink.active = false;
      return __origWrite.call(this, data);
    }
  };
  process.once("exit", () => { try { __sink.close(); } catch {} });
}
`;

export async function load(url, context, next) {
	const result = await next(url, context);
	if (url.includes("/@earendil-works/pi-tui/dist/terminal.js") && result.format === "module") {
		return { ...result, source: `${String(result.source)}\n${PATCH}` };
	}
	return result;
}
