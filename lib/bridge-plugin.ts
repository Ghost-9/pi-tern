/** pi-bridge plugin files, written by the extension on \`/tern bridge install\`. */

export const BRIDGE_PLUGIN_TOML = `schema = 1
id = "pi-bridge"
name = "pi-bridge"
version = "1.1.7"
description = "Shows the pi-tern dashboard, answers batched data requests (SQLite, documents, boards, settings) and exposes pi status to Carly."
window = "window.luau"
`;

export const BRIDGE_WINDOW_LUAU = `-- pi-bridge: the pi-tern dashboard canvas plus a batched request/response mailbox.
--
-- The extension writes request.json into this plugin's directory; a timer reads it,
-- executes the requested cx.* operations and writes response.json. All operations are
-- Tern window-side (db/docs/board/settings/carly), so nothing here needs a host half.
local ABOUT = table.concat({
	"pi-tern dashboard: model, context, diagrams, shell runs, browser state and a session TOC, ",
	"written by the pi-tern extension. It refreshes every 3 seconds while open. Press ",
	"ctrl+shift+f10 to open or refresh; closing it is final.",
}, "")
local REFRESH_MS = 3000
local MAILBOX_MS = 250
local MAILBOX_FAST_MS = 100
local PLUGIN_VERSION = "1.1.7"
local state = {
	pane = nil,
	armed = false,
	registered = false,
	busy = false,
	exported = false,
	dbs = {},
	fast_until = 0,
	claim = tostring(math.random(1, 1000000000)),
}

-- ── Dashboard ────────────────────────────────────────────────────────────────────────────────
--
-- The panel is a \`tern.ui\` view rather than plain markdown, because that is what gives us
-- clickable file paths (\`tern.ui.path\` links to the file), a real button (\`tern.ui.el\` with
-- the HTML-subset \`button\` tag) and a native bar chart (\`tern.ui.bars\`). Plain markdown can
-- only carry \`file://\` links, which open a full file block instead of the small preview.

local function read_dashboard()
	local ok, text = pcall(tern.fs.read, "dashboard.json", 262144)
	if not ok or type(text) ~= "string" or #text == 0 then return nil end
	local decoded, data = pcall(tern.json.decode, text)
	if not decoded or type(data) ~= "table" then return nil end
	return data
end

local function markdown_fallback()
	local ok, md = pcall(tern.fs.read, "dashboard.md", 262144)
	if ok and type(md) == "string" and #md > 0 then return md end
	return "# pi\\n\\nNo dashboard yet. In pi, run '/tern bridge install'."
end

--- A button that reports \`act\` back through the canvas action handler.
local function button(label, act, tone)
	local s = "small"
	if tone == "primary" then s = "small strong" end
	return tern.ui.el("button", {
		class = "tn-btn",
		id = act,
		text = label,
		attrs = { ["data-act"] = act, role = "button" },
	}, { tern.ui.span(label, s) })
end

local function file_row(entry)
	local cwd = entry.cwd and tostring(entry.cwd) or nil
	local spans = { tern.ui.path(tostring(entry.path or "?"), cwd) }
	if entry.line then spans[#spans + 1] = tern.ui.span(":" .. tostring(entry.line), "muted") end
	if entry.exists == false then spans[#spans + 1] = tern.ui.span(" (missing)", "muted") end
	return tern.ui.row(spans)
end

local function view(data)
	local parts = {}

	-- identity line
	local head = {}
	if data.title then head[#head + 1] = tern.ui.badge(tostring(data.title), "info") end
	if data.model then head[#head + 1] = tern.ui.span(tostring(data.model), "strong") end
	if data.context then head[#head + 1] = tern.ui.span(" · " .. tostring(data.context) .. " context", "muted") end
	if data.dir then head[#head + 1] = tern.ui.span(" · " .. tostring(data.dir), "muted") end
	if #head > 0 then parts[#parts + 1] = tern.ui.text(head) end

	-- native bar chart (tern.ui.bars takes {label, value} pairs)
	local chart = data.chart
	if type(chart) == "table" and type(chart.series) == "table" and #chart.series > 0 then
		if chart.title then parts[#parts + 1] = tern.ui.text({ tern.ui.span(tostring(chart.title), "strong") }) end
		local bars = {}
		for _, point in ipairs(chart.series) do
			if type(point) == "table" and point.label ~= nil then
				bars[#bars + 1] = { label = tostring(point.label), value = tonumber(point.value) or 0 }
			end
		end
		if #bars > 0 then
			local ok, node = pcall(tern.ui.bars, bars)
			if ok then parts[#parts + 1] = node end
		end
	end

	-- clickable file references: tern.ui.path links straight to the file
	local files = data.files
	if type(files) == "table" and #files > 0 then
		local rows = {}
		local shown = math.min(#files, 12)
		for i = 1, shown do
			if type(files[i]) == "table" then rows[#rows + 1] = file_row(files[i]) end
		end
		if #files > shown then rows[#rows + 1] = tern.ui.text({ tern.ui.span("… " .. tostring(#files - shown) .. " more", "muted") }) end
		parts[#parts + 1] = tern.ui.section({ tern.ui.span("Files mentioned", "strong") }, rows)
	end

	-- markdown body (links inside are clickable too)
	if type(data.markdown) == "string" and #data.markdown > 0 then
		local ok, node = pcall(tern.ui.md, data.markdown)
		if ok then parts[#parts + 1] = node end
	end

	-- buttons: a real control, not a link
	parts[#parts + 1] = tern.ui.row({
		button("Refresh", "refresh", "primary"),
		button("Preview", "open-preview"),
		button("Open in split", "open-split"),
		button("Copy paths", "copy-paths"),
	})

	return tern.ui.col(parts)
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

--- Prefer the structured view; fall back to markdown when dashboard.json is absent.
local function panel(cx)
	local data = read_dashboard()
	if not data then return { md = markdown_fallback() } end
	local ok, node = pcall(view, data)
	if not ok then
		tern.log.warn("pi-bridge: view build failed", tostring(node))
		return { md = markdown_fallback() }
	end
	return { view = node }
end

local function show(cx)
	local spec = panel(cx)
	if is_open(cx) then
		local ok = pcall(function()
			cx.canvas:set(state.pane, { title = "pi", view = spec.view, md = spec.md, about = ABOUT })
		end)
		if ok then
			pcall(function() cx.layout:focus(state.pane) end)
			return true
		end
		state.pane = nil
	end
	local pane, err = cx.canvas:open({ title = "pi", view = spec.view, md = spec.md, about = ABOUT, focus = true })
	if not pane then
		tern.log.error("pi-bridge: canvas:open failed", tostring(err))
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
		if type(info) == "table" and info.owner == "pi-bridge" and type(info.pane) == "number" then
			state.pane = info.pane
			return
		end
	end
end

local function refresh(cx)
	if not is_open(cx) then return end
	local spec = panel(cx)
	local ok, err = pcall(function()
		cx.canvas:set(state.pane, { title = "pi", view = spec.view, md = spec.md, about = ABOUT })
	end)
	if not ok then
		tern.log.warn("pi-bridge: canvas:set failed", tostring(err))
		state.pane = nil
	end
end

-- ── Canvas buttons ──────────────────────────────────────────────────────────────────────────
--
-- Clicking a canvas node delivers a CanvasAction to the owner: \`{pane, act, text, node, …}\`.
-- The first click also logs the raw event, so the exact field carrying the action name is
-- verified by observation rather than assumed — the same discipline used for the TSP encodings.

local function first_file(data)
	local files = data and data.files
	if type(files) ~= "table" then return nil end
	for _, entry in ipairs(files) do
		if type(entry) == "table" and entry.path and entry.exists ~= false then return entry end
	end
	return nil
end

local logged_action = false
local function on_canvas(ev, cx)
	local act = nil
	if type(ev) == "table" then act = ev.act end
	if not logged_action then
		logged_action = true
		pcall(function() tern.log.warn("pi-bridge: canvas action", tern.json.encode(ev, false)) end)
	end
	if act == nil then return false end
	if act == "refresh" then
		pcall(refresh, cx)
		return true
	end
	local data = read_dashboard()
	local entry = first_file(data)
	if act == "open-split" and entry and entry.path then
		pcall(function() cx:open(tostring(entry.path), "split") end)
		return true
	end
	if act == "open-preview" and entry and entry.path then
		pcall(function() cx:open(tostring(entry.path), "preview") end)
		return true
	end
	if act == "copy-paths" then
		local paths = {}
		for _, item in ipairs((data and data.files) or {}) do
			if type(item) == "table" and item.path then paths[#paths + 1] = tostring(item.path) end
		end
		pcall(tern.fs.write, "paths.txt", table.concat(paths, "\\n"))
		return true
	end
	return false
end

local function register_canvas_actions()
	if state.canvas_actions then return end
	state.canvas_actions = true
	local ok, err = pcall(tern.on, "canvas_action", on_canvas)
	if not ok then tern.log.warn("pi-bridge: canvas_action registration failed", tostring(err)) end
end

-- ── Link routing: a file link opens in the small preview, not a full block ──────────
--
-- \`tern.route.link\` may claim a link click and answer with \`{path, how}\` (or \`{handled=true}\`).
-- Tern's default for a \`file://\` link is a full file block; sending \`how = "preview"\` instead
-- means a clicked reference lands in the tab's preview block, which is small and keeps the
-- focus. Holding shift asks for the split, so the full view is still one gesture away.

local function file_path_from_url(url)
	if type(url) ~= "string" then return nil end
	if url:sub(1, 7) ~= "file://" then return nil end
	local rest = url:sub(8)
	if rest:sub(1, 1) ~= "/" then rest = "/" .. rest end
	local out, i = {}, 1
	while i <= #rest do
		local c = rest:sub(i, i)
		if c == "%" and i + 2 <= #rest then
			local hex = rest:sub(i + 1, i + 2)
			local n = tonumber(hex, 16)
			if n then
				out[#out + 1] = string.char(n)
				i = i + 3
			else
				out[#out + 1] = c
				i = i + 1
			end
		else
			out[#out + 1] = c
			i = i + 1
		end
	end
	return table.concat(out)
end

local function on_link(link, _cx)
	local path = file_path_from_url(type(link) == "table" and link.url or nil)
	if not path then return nil end
	local shift = type(link) == "table" and type(link.mods) == "table" and link.mods.shift
	return { path = path, how = shift and "split" or "preview" }
end

local function register_links()
	if state.links then return end
	state.links = true
	local ok, err = pcall(function()
		tern.route.link(function(link, cx) return on_link(link, cx) end)
	end)
	if not ok then tern.log.warn("pi-bridge: link route registration failed", tostring(err)) end
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
	register_canvas_actions()
	register_links()
	pcall(adopt, cx)
	show(cx)
end

local function register()
	if state.registered then return end
	state.registered = true
	local ok, err = pcall(tern.bind, "ctrl+shift+f10", function(cx) return open_now(cx) end)
	if not ok then tern.log.error("pi-bridge: chord bind failed", tostring(err)) end
	if ok then tern.log.warn("pi-bridge: bound ctrl+shift+f10") end
end

-- Expose a short pi status string to Carly so it can answer questions about pi.
local function register_export()
	if state.exported then return end
	state.exported = true
	local ok, err = pcall(tern.carly.export, "pi_tern", {
		sig = "pi_tern() -> status string",
		doc = "Current pi-tern session status: model, context, mirror, diagrams, shell runs and browser tabs.",
	}, function()
		local read_ok, md = pcall(tern.fs.read, "dashboard.md", 4000)
		if read_ok and type(md) == "string" and #md > 0 then return string.sub(md, 1, 400) end
		return "pi-tern: no dashboard yet"
	end)
	if not ok then tern.log.warn("pi-bridge: carly export failed", tostring(err)) end
	if ok then tern.log.warn("pi-bridge: carly export pi_tern registered") end
end

-- ── Operations ───────────────────────────────────────────────────────────────────────────────

-- Runs one operation and calls cb(ok, result, err) exactly once.
local function run_op(cx, op, args, cb)
	if op == "system.ping" then
		return cb(true, { plugin = "pi-bridge", version = PLUGIN_VERSION })
	end

	-- What kind of Tern block is a pane? 'terminal' for a shell block, 'agent' for an agent block.
	-- The extension asks this at session start because Tern only DISPLAYS a TSP surface in an agent
	-- block: in a shell block the frames are accepted and nothing is drawn, which reads as a blank
	-- pane. 'cx.session:panes()' is the only place the kind is exposed — 'tern inspect --json' carries
	-- client kinds only and 'tern whoami' carries just the identity chain.
	if op == "pane.kind" then
		local wanted = tonumber(args.pane) or tostring(args.pane or "")
		local panes = cx.session:panes()
		for _, p in ipairs(panes or {}) do
			if tostring(p.pane) == tostring(wanted) or (p.id ~= nil and tostring(p.id) == tostring(wanted)) then
				return cb(true, { pane = p.pane, kind = p.kind, program = p.program, title = p.title, running = p.running and p.running.line or nil })
			end
		end
		return cb(false, nil, "no pane " .. tostring(wanted) .. " in this window")
	end

	if op == "db.tables" or op == "db.schema" or op == "db.query" or op == "db.exec" then
		local read_only = op ~= "db.exec" or args.allowWrite ~= true
		local key = (read_only and "ro:" or "rw:") .. tostring(args.path or "")
		local function work(db, ui, open_err)
			if not db then return cb(false, nil, open_err or "could not open database") end
			if op == "db.tables" then
				ui.db:tables(db):next(function(value, err)
					if not value then return cb(false, nil, err) end
					cb(true, { tables = value })
				end)
			elseif op == "db.schema" then
				ui.db:schema(db, tostring(args.table or "")):next(function(value, err)
					if not value then return cb(false, nil, err) end
					cb(true, { schema = value })
				end)
			elseif op == "db.query" then
				ui.db:query(db, tostring(args.sql or ""), { limit = tonumber(args.limit) or 200 }):next(function(value, err)
					if not value then return cb(false, nil, err) end
					cb(true, { columns = value.columns, rows = value.rows })
				end)
			else
				ui.db:exec(db, tostring(args.sql or "")):next(function(_null, err)
					if err then return cb(false, nil, err) end
					cb(true, { written = true })
				end)
			end
		end
		local cached = state.dbs[key]
		if cached then return work(cached, cx) end
		cx.db:open(tostring(args.path or ""), { read_only = read_only }):next(function(db, err, fresh)
			local ui = fresh or cx
			if not db then return work(nil, ui, err) end
			local count = 0
			for _ in pairs(state.dbs) do count = count + 1 end
			if count >= 8 then state.dbs = {} end
			state.dbs[key] = db
			work(db, ui)
		end)
		return
	end

	if op == "doc.read" or op == "doc.outline" or op == "doc.search" then
		local path = tostring(args.path or "")
		if op == "doc.read" then
			cx.docs:read(path, { from = tonumber(args.from) or 1, lines = tonumber(args.lines) }):next(function(text, err)
				if not text then return cb(false, nil, err) end
				cb(true, { text = text })
			end)
		elseif op == "doc.outline" then
			cx.docs:outline(path):next(function(headings, err)
				if not headings then return cb(false, nil, err) end
				cb(true, { headings = headings })
			end)
		else
			cx.docs:search(path, tostring(args.query or "")):next(function(matches, err)
				if not matches then return cb(false, nil, err) end
				cb(true, { matches = matches })
			end)
		end
		return
	end

	if op == "doc.append" or op == "doc.write" then
		local path = tostring(args.path or "")
		local text = tostring(args.text or "")
		local call = op == "doc.append" and function() return cx.docs:append(path, text) end
			or function() return cx.docs:write(path, text) end
		call():next(function(range, err)
			if not range then return cb(false, nil, err) end
			cb(true, { range = range })
		end)
		return
	end

	if op == "doc.edit" then
		local path = tostring(args.path or "")
		local spec
		if args.find ~= nil then
			spec = { find = tostring(args.find), replace = tostring(args.replace or ""), all = args.all }
		elseif args.line ~= nil then
			spec = { line = tonumber(args.line) or 1, insert = tostring(args.insert or "") }
		else
			spec = { heading = tostring(args.heading or ""), append = tostring(args.append or "") }
		end
		cx.docs:edit(path, spec):next(function(range, err)
			if not range then return cb(false, nil, err) end
			cb(true, { range = range })
		end)
		return
	end

	if op == "doc.newNote" then
		local pane = cx.docs:new_note(tostring(args.title or "pi note"), tostring(args.text or ""))
		return cb(true, { pane = pane })
	end

	if op == "board.read" then
		cx.board:read(args.board, { rows = tonumber(args.rows) or 25 }):next(function(snapshot, err)
			if not snapshot then return cb(false, nil, err) end
			cb(true, { snapshot = snapshot })
		end)
		return
	end

	if op == "board.add" then
		cx.board:add(args.board, {
			lane = tostring(args.lane or ""),
			text = tostring(args.text or ""),
			tags = args.tags,
			due = args.due,
		}):next(function(card, err)
			if not card then return cb(false, nil, err) end
			cb(true, { card = card })
		end)
		return
	end

	if op == "board.move" then
		cx.board:move(tostring(args.card or ""), tostring(args.lane or ""), { position = tonumber(args.position) }):next(function(moved, err)
			if err then return cb(false, nil, err) end
			cb(true, { moved = moved })
		end)
		return
	end

	if op == "board.check" then
		cx.board:check(tostring(args.card or ""), args.done ~= false):next(function(checked, err)
			if err then return cb(false, nil, err) end
			cb(true, { checked = checked })
		end)
		return
	end

	if op == "board.addLane" then
		cx.board:add_lane(args.board, { title = tostring(args.title or "New lane"), position = tonumber(args.position) }):next(function(lane, err)
			if not lane then return cb(false, nil, err) end
			cb(true, { lane = lane })
		end)
		return
	end

	if op == "settings.list" then
		return cb(true, { settings = cx.settings:list(args.prefix and tostring(args.prefix) or nil) })
	end
	if op == "settings.get" then
		return cb(true, { value = cx.settings:get(tostring(args.key or "")) })
	end
	if op == "settings.describe" then
		return cb(true, { description = cx.settings:describe(tostring(args.key or "")) })
	end

	if op == "notebook.read" then
		local read = cx.session:read(tonumber(args.pane) or tostring(args.pane or ""))
		if type(read) ~= "table" or read.kind ~= "notebook" then
			return cb(false, nil, "pane is not an open notebook block")
		end
		return cb(true, read)
	end

	if op == "carly.ask" then
		cx:ask_carly(tostring(args.text or ""))
		return cb(true, { asked = true })
	end
	if op == "carly.schedule" then
		local id = tern.carly.schedule({
			title = tostring(args.title or "pi-tern task"),
			when = args.when and tostring(args.when) or nil,
			on = args.on and tostring(args.on) or nil,
			prompt = args.prompt and tostring(args.prompt) or nil,
		})
		return cb(true, { id = id })
	end
	if op == "carly.tasks" then
		return cb(true, { tasks = tern.carly.tasks() })
	end
	if op == "carly.cancel" then
		return cb(true, { cancelled = tern.carly.cancel(tonumber(args.id) or -1) })
	end

	cb(false, nil, "unknown op: " .. op)
end

-- ── Mailbox ──────────────────────────────────────────────────────────────────────────────────

local function respond(id, ok, result, err)
	local payload = { id = id, ok = ok, v = PLUGIN_VERSION }
	if ok then
		payload.result = result
	else
		payload.error = tostring(err or "error")
	end
	local wrote, write_err = pcall(tern.fs.write, "response.json", tern.json.encode(payload, false))
	if not wrote then
		tern.log.warn("pi-bridge: response write failed", tostring(write_err))
	end
end

local function read_request()
	local exists = false
	pcall(function() exists = tern.fs.exists("request.json") end)
	if not exists then return nil end
	local ok, text = pcall(tern.fs.read, "request.json", 262144)
	if not ok or type(text) ~= "string" or #text == 0 then return nil end
	local decoded, req = pcall(tern.json.decode, text)
	if not decoded or type(req) ~= "table" or req.id == nil then return nil end
	return req
end

local function handle(cx, req, done)
	local function finish(ok, result, err)
		respond(tostring(req.id), ok, result, err)
		pcall(tern.fs.remove, "request.json")
		pcall(tern.fs.remove, "claim.json")
		done()
	end
	if req.op == "batch" then
		local ops = (req.args and req.args.ops) or {}
		local results = {}
		local function step(index)
			if index > #ops then return finish(true, { results = results }) end
			local item = ops[index]
			run_op(cx, tostring(item.op or ""), item.args or {}, function(ok, result, err)
				results[#results + 1] = { ok = ok, result = result, error = err }
				step(index + 1)
			end)
		end
		step(1)
		return
	end
	run_op(cx, tostring(req.op or ""), req.args or {}, function(ok, result, err)
		finish(ok, result, err)
	end)
end

-- Best-effort single-owner claim so two windows never run the same request twice.
local function claimed()
	local token = state.claim .. ":" .. tostring(tern.now())
	local wrote = pcall(tern.fs.write, "claim.json", token)
	if not wrote then return true end
	local read_ok, current = pcall(tern.fs.read, "claim.json", 256)
	return read_ok and current == token
end

local function mailbox_tick(cx)
	if cx and not state.busy then
		local req = read_request()
		if req and claimed() then
			state.busy = true
			state.fast_until = tern.now() + 5000
			local ran, err = pcall(handle, cx, req, function() state.busy = false end)
			if not ran then
				respond(tostring(req.id), false, nil, err)
				pcall(tern.fs.remove, "request.json")
				pcall(tern.fs.remove, "claim.json")
				state.busy = false
			end
		end
	end
	local interval = tern.now() < state.fast_until and MAILBOX_FAST_MS or MAILBOX_MS
	tern.timer(interval, mailbox_tick)
end

register()
register_canvas_actions()
register_links()
arm()
register_export()
tern.timer(MAILBOX_MS, mailbox_tick)
`;
