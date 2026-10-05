/** pi-bridge plugin files, written by the extension on `/tern bridge install`. */

export const BRIDGE_PLUGIN_TOML = `schema = 1
id = "pi-bridge"
name = "pi-bridge"
version = "0.8.0"
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
local PLUGIN_VERSION = "0.8.0"
local state = {
	pane = nil,
	armed = false,
	registered = false,
	busy = false,
	exported = false,
	dbs = {},
	claim = tostring(math.random(1, 1000000000)),
}

-- ── Dashboard ────────────────────────────────────────────────────────────────────────────────

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
			local ran, err = pcall(handle, cx, req, function() state.busy = false end)
			if not ran then
				respond(tostring(req.id), false, nil, err)
				pcall(tern.fs.remove, "request.json")
				pcall(tern.fs.remove, "claim.json")
				state.busy = false
			end
		end
	end
	tern.timer(MAILBOX_MS, mailbox_tick)
end

register()
arm()
register_export()
tern.timer(MAILBOX_MS, mailbox_tick)
`;
