/** pi-bridge plugin files, written by the extension on `/tern bridge install`. */

export const BRIDGE_PLUGIN_TOML = `schema = 1
id = "pi-bridge"
name = "pi-bridge"
version = "0.3.0"
description = "Shows the pi-tern dashboard (model, context, diagrams, shell runs, browser) in a native Markdown canvas."
window = "window.luau"
`;

export const BRIDGE_WINDOW_LUAU = `-- pi-bridge: a native Tern canvas showing the dashboard the pi-tern extension writes.
-- The extension writes dashboard.md next to this file; the canvas is a Markdown render, so
-- tables and Mermaid fences render natively. No auto-open: the chord is the entry point.
local ABOUT = table.concat({
	"pi-tern dashboard: model, context, diagrams, shell runs and browser state, written by the ",
	"pi-tern extension. It refreshes every 3 seconds while open. Press ctrl+shift+f10 to open or ",
	"refresh; closing it is final.",
}, "")
local REFRESH_MS = 3000
local state = { pane = nil, armed = false, registered = false }

local function dashboard()
	local ok, md = pcall(tern.fs.read, "dashboard.md", 262144)
	if ok and type(md) == "string" and #md > 0 then
		return md
	end
	return "# pi\\n\\nNo dashboard yet. In pi, run \`/tern bridge install\`."
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

local function show(cx)
	if is_open(cx) then
		local ok = pcall(function()
			cx.canvas:set(state.pane, { title = "pi", md = dashboard(), about = ABOUT })
		end)
		if ok then
			pcall(function() cx.layout:focus(state.pane) end)
			return true
		end
		state.pane = nil
	end
	local pane, err = cx.canvas:open({ title = "pi", md = dashboard(), about = ABOUT, focus = true })
	if not pane then
		tern.log.error("pi-bridge: canvas:open failed", tostring(err))
		return false
	end
	state.pane = pane
	return true
end

-- Adopt a canvas this plugin already opened (after a reload, state.pane is gone but the pane
-- exists), so a reload never opens a second one.
local function adopt(cx)
	if state.pane then return end
	local ok, list = pcall(function() return cx.canvas:list() end)
	if not ok or type(list) ~= "table" then return end
	for _, info in ipairs(list) do
		if type(info) == "table" and info.owner == "pi-bridge" and type(info.pane) == "number" then
			state.pane = info.pane
			return
		end
	end
end

-- Refresh only: a refresh never creates a canvas, so a closed canvas stays closed.
local function refresh(cx)
	if not is_open(cx) then return end
	local ok, err = pcall(function()
		cx.canvas:set(state.pane, { title = "pi", md = dashboard(), about = ABOUT })
	end)
	if not ok then
		tern.log.warn("pi-bridge: canvas:set failed", tostring(err))
		state.pane = nil
	end
end

local function arm()
	if state.armed then return end
	state.armed = true
	local function tick(cx)
		if cx then pcall(refresh, cx) end
		tern.timer(REFRESH_MS, tick)
	end
	tern.timer(REFRESH_MS, tick)
end

local function open_now(cx)
	arm()
	pcall(adopt, cx)
	show(cx)
end

-- tern.bind APPENDS a binding, so guard registration; bind is the only reliable entry point on
-- Tern 0.4.5 (tern.command registers no reachable action).
local function register()
	if state.registered then return end
	state.registered = true
	local ok, err = pcall(tern.bind, "ctrl+shift+f10", function(cx) return open_now(cx) end)
	if not ok then tern.log.error("pi-bridge: chord bind failed", tostring(err)) end
	if ok then tern.log.warn("pi-bridge: bound ctrl+shift+f10") end
end

register()
`;
