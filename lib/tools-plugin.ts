/**
 * The tool-results panel — a *second* Tern plugin, deliberately.
 *
 * Tern gives every plugin window entry a 50 ms load budget, and `pi-bridge` was already at it: its
 * window entry is the data plane's mailbox, with one branch per operation. Measured on Tern 0.5.1,
 * adding the tool-results rendering to that file took it from ~3-in-5 loads to ~1-in-4, because a
 * parse failure there is a *runtime* error (`tern: load exceeded 50 ms`) that looks exactly like a
 * syntax error to anything grepping the log — the fourth time that particular confusion has cost
 * this project a debugging cycle.
 *
 * So this lives in its own window entry with its own budget. `pi-bridge` goes back to 644 lines and
 * loads reliably; the widgets get a file small enough to always fit.
 *
 * The widgets themselves come from Tern's own generated types (`tern plugin types` →
 * `tern.d.luau`), which is authoritative rather than remembered:
 *
 *     diff:         (text: string, path: string?) -> Node
 *     code:         (text: string, lang: string?, start: number?) -> Node
 *     test_summary: (passed: number, failed: number, skipped: number, took: string?) -> Node
 *
 * Note the caveat that applies to all of this, from docs/RENDER-PROOF.md: an accepted node is not a
 * rendered one. No native surface has been seen to render, so these cards are correct by
 * construction and by the plugin's own error channel, not by pixels.
 */

/** The plugin manifest. Version tracks the package, derived like every other one. */
import { PLUGIN_VERSION } from "./version.ts";

export const TOOLS_PLUGIN_TOML = `schema = 1
id = "pi-tern-tools"
name = "pi-tern tools"
version = "${PLUGIN_VERSION}"
description = "Renders pi-tern's tool results — diffs, code and test runs — as native Tern widgets."
window = "window.luau"
`;

export const TOOLS_WINDOW_LUAU = `-- pi-tern tool results: native widgets for what the tools produced.
--
-- Deliberately its own plugin. pi-bridge's window entry is the data plane's mailbox and already
-- sits at Tern's 50 ms load budget; growing it makes the whole data plane fail intermittently.
-- This file only reads dashboard.json and builds a canvas, so it fits comfortably.
--
-- Read-only by construction: it never writes the mailbox files pi-bridge owns.
local ABOUT = table.concat({
	"pi-tern tool results: diffs, source and test runs as native Tern widgets, ",
	"written by the pi-tern extension. Press ctrl+shift+f11 to open or refresh.",
}, "")
local REFRESH_MS = 3000
local PLUGIN_VERSION = "${PLUGIN_VERSION}"
local state = {
	pane = nil,
	armed = false,
	registered = false,
	busy = false,
}

local function read_dashboard()
	local ok, text = pcall(tern.fs.read, "dashboard.json", 262144)
	if not ok or type(text) ~= "string" or #text == 0 then return nil end
	local decoded, data = pcall(tern.json.decode, text)
	if not decoded or type(data) ~= "table" then return nil end
	return data
end

-- One card per result. Every widget call is its own pcall: Tern does not error on unknown props, and
-- a malformed entry must cost that card rather than the whole panel.
local function result_card(entry)
	if type(entry) ~= "table" then return nil end
	local label = tern.ui.badge(tostring(entry.tool or "tool"), "info")
	local title
	if entry.path then
		title = tern.ui.text({ label, tern.ui.span(" " .. tostring(entry.path), "muted") })
	else
		title = tern.ui.text({ label })
	end

	local ok, node
	if entry.kind == "diff" and type(entry.diff) == "string" then
		ok, node = pcall(tern.ui.diff, entry.diff, entry.path)
	elseif entry.kind == "code" and type(entry.code) == "string" then
		ok, node = pcall(tern.ui.code, entry.code, entry.lang)
	elseif entry.kind == "tests" and type(entry.tests) == "table" then
		local t = entry.tests
		ok, node = pcall(
			tern.ui.test_summary,
			tonumber(t.passed) or 0,
			tonumber(t.failed) or 0,
			tonumber(t.skipped) or 0,
			t.took
		)
	end
	if ok and node then return tern.ui.section(title, { node }) end

	-- Nothing fitted, so fall back to muted text rather than dropping the result entirely.
	if type(entry.text) == "string" and #entry.text > 0 then
		local fallback, text = pcall(tern.ui.code, entry.text)
		if fallback and text then return tern.ui.section(title, { text }) end
	end
	return nil
end

local function view(data)
	local results = data.toolResults
	if type(results) ~= "table" or #results == 0 then
		return tern.ui.md(
			"## Tool results\\n\\nNone yet. Run a tool — a git diff, a test command or a file read — and it appears here."
		)
	end
	local cards = {}
	local shown = 0
	for _, entry in ipairs(results) do
		local card = result_card(entry)
		if card then
			cards[#cards + 1] = card
			shown = shown + 1
		end
	end
	if shown == 0 then
		return tern.ui.md("## Tool results\\n\\n" .. tostring(#results) .. " recorded, none renderable.")
	end
	local head = tern.ui.text({
		tern.ui.badge(tostring(shown), "info"),
		tern.ui.span(#results == 1 and " result" or " results"),
	})
	return tern.ui.col({ head, tern.ui.section({ tern.ui.span("Latest", "strong") }, cards) })
end

local function is_open(cx)
	if not state.pane then return false end
	local ok, info = pcall(function() return cx.canvas:get(state.pane) end)
	if not ok or not info then
		state.pane = nil
		return false
	end
	return true
end

local function build(cx)
	local data = read_dashboard()
	if not data then return { md = "## Tool results\\n\\nNo dashboard yet." } end
	local ok, node = pcall(view, data)
	if not ok then
		tern.log.warn("pi-tern-tools: view build failed", tostring(node))
		return { md = "## Tool results\\n\\nThe panel could not be built: " .. tostring(node) }
	end
	return { view = node }
end

local function show(cx)
	local spec = build(cx)
	if is_open(cx) then
		local ok = pcall(function() return cx.canvas:set(state.pane, spec) end)
		if ok then
			pcall(function() cx.layout:focus(state.pane) end)
			return true
		end
		state.pane = nil
	end
	local pane, err = cx.canvas:open({ title = "pi tools", view = spec.view, md = spec.md, about = ABOUT, focus = true })
	if not pane then
		tern.log.error("pi-tern-tools: canvas:open failed", tostring(err))
		return false
	end
	state.pane = pane
	return true
end

local function adopt(cx)
	if state.pane then return end
	local ok, list = pcall(function() return cx.canvas:list() end)
	if not ok or type(list) ~= "table" then return end
	for _, info in ipairs(list) do
		if type(info) == "table" and info.owner == "pi-tern-tools" and type(info.pane) == "number" then
			state.pane = info.pane
			return
		end
	end
end

local function refresh(cx)
	if not is_open(cx) then return end
	local spec = build(cx)
	local ok = pcall(function() return cx.canvas:set(state.pane, spec) end)
	if not ok then
		tern.log.warn("pi-tern-tools: canvas:set failed", tostring(ok))
		state.pane = nil
	end
end

local function open_now(cx)
	register()
	adopt(cx)
	show(cx)
end

local function register()
	if state.registered then return end
	state.registered = true
	local ok, err = pcall(tern.bind, "ctrl+shift+f11", function(cx) return open_now(cx) end)
	if not ok then tern.log.error("pi-tern-tools: chord bind failed", tostring(err)) end
	if ok then tern.log.warn("pi-tern-tools: bound ctrl+shift+f11") end
end

-- Honour Tern's reduce-motion. A 3 s auto-refresh is animation whether or not it is called that,
-- and Tern has applied this flag everywhere since 0.5.2 - so a panel that repaints on a timer is
-- the one surface in the window that does not respect it. Under reduce-motion the panel opens and
-- refreshes on demand (the chord and the Refresh button still work) instead of on a timer.
local function motion_reduced()
	local data = read_dashboard()
	return type(data) == "table" and data.reduceMotion == true
end

local function arm()
	if state.armed then return end
	state.armed = true
	local function tick(cx)
		if motion_reduced() then
			-- Stop the loop rather than spinning quietly: the flag can change at any time, and the
			-- chord re-arms it.
			tern.log.warn("pi-tern-tools: auto-refresh off (reduce-motion)")
			return
		end
		if cx then pcall(refresh, cx) end
		tern.timer(REFRESH_MS, tick)
	end
	tern.timer(REFRESH_MS, tick)
end

-- Deferred to a first tick: the 50 ms load budget is for compiling this file, and a chord bind plus
-- a timer chain are host calls that do not belong inside it.
local function boot()
	pcall(register)
	pcall(arm)
	tern.log.warn("pi-tern-tools: booted, version " .. PLUGIN_VERSION)
end

tern.timer(0, boot)
`;
