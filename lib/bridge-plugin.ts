/** pi-bridge plugin files, written by the extension on `/tern bridge install`. */

export const BRIDGE_PLUGIN_TOML = `schema = 1
id = "pi-bridge"
name = "pi-bridge"
version = "0.7.0"
description = "Shows the pi-tern dashboard, answers the extension's data requests (SQLite, documents, boards, settings) and exposes pi status to Carly."
window = "window.luau"
`;

export const BRIDGE_WINDOW_LUAU = `-- pi-bridge: the pi-tern dashboard canvas plus a request/response mailbox.
--
-- The extension writes request.json into this plugin's directory; a timer reads it,
-- executes the requested cx.* operation and writes response.json. All operations are
-- Tern window-side (db/docs/board/settings/carly), so nothing here needs a host half.
local ABOUT = table.concat({
	"pi-tern dashboard: model, context, diagrams, shell runs, browser state and a session TOC, ",
	"written by the pi-tern extension. It refreshes every 3 seconds while open. Press ",
	"ctrl+shift+f10 to open or refresh; closing it is final.",
}, "")
local REFRESH_MS = 3000
local MAILBOX_MS = 400
local state = { pane = nil, armed = false, registered = false, busy = false, exported = false }

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

-- ── Mailbox ──────────────────────────────────────────────────────────────────────────────────

local function respond(id, ok, result, err)
	local payload = { id = id, ok = ok }
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
	if not decoded or type(req) ~= "table" then return nil end
	return req
end

local function finish(req, done, ok, result, err)
	respond(tostring(req.id or ""), ok, result, err)
	pcall(tern.fs.remove, "request.json")
	done()
end

-- Runs one request. Every branch must call finish() exactly once.
local function handle(cx, req, done)
	local op = tostring(req.op or "")
	local args = req.args or {}
	local function done_ok(result) finish(req, done, true, result) end
	local function done_err(err) finish(req, done, false, nil, err) end

	if op == "system.ping" then
		return done_ok({ plugin = "pi-bridge", version = "0.7.0" })
	end

	if op == "db.tables" or op == "db.schema" or op == "db.query" or op == "db.exec" then
		local read_only = op ~= "db.exec" or args.allowWrite ~= true
		cx.db:open(tostring(args.path or ""), { read_only = read_only }):next(function(db, err, fresh)
			local ui = fresh or cx
			if not db then return done_err(err or "could not open database") end
			if op == "db.tables" then
				ui.db:tables(db):next(function(tables, err2)
					if not tables then return done_err(err2) end
					done_ok({ tables = tables })
				end)
			elseif op == "db.schema" then
				ui.db:schema(db, tostring(args.table or "")):next(function(schema, err2)
					if not schema then return done_err(err2) end
					done_ok({ schema = schema })
				end)
			elseif op == "db.query" then
				local opts = { limit = tonumber(args.limit) or 200 }
				ui.db:query(db, tostring(args.sql or ""), opts):next(function(result, err2)
					if not result then return done_err(err2) end
					done_ok({ columns = result.columns, rows = result.rows })
				end)
			else
				ui.db:exec(db, tostring(args.sql or "")):next(function(_null, err2)
					if err2 then return done_err(err2) end
					done_ok({ written = true })
				end)
			end
		end)
		return
	end

	if op == "doc.read" or op == "doc.outline" or op == "doc.search" then
		local path = tostring(args.path or "")
		if op == "doc.read" then
			cx.docs:read(path, { from = tonumber(args.from) or 1, lines = tonumber(args.lines) }):next(function(text, err)
				if not text then return done_err(err) end
				done_ok({ text = text })
			end)
		elseif op == "doc.outline" then
			cx.docs:outline(path):next(function(headings, err)
				if not headings then return done_err(err) end
				done_ok({ headings = headings })
			end)
		else
			cx.docs:search(path, tostring(args.query or "")):next(function(matches, err)
				if not matches then return done_err(err) end
				done_ok({ matches = matches })
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
			if not range then return done_err(err) end
			done_ok({ range = range })
		end)
		return
	end

	if op == "doc.newNote" then
		local pane = cx.docs:new_note(tostring(args.title or "pi note"), tostring(args.text or ""))
		return done_ok({ pane = pane })
	end

	if op == "board.read" then
		cx.board:read(args.board, { rows = tonumber(args.rows) or 25 }):next(function(snapshot, err)
			if not snapshot then return done_err(err) end
			done_ok({ snapshot = snapshot })
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
			if not card then return done_err(err) end
			done_ok({ card = card })
		end)
		return
	end

	if op == "board.move" then
		cx.board:move(tostring(args.card or ""), tostring(args.lane or ""), { position = tonumber(args.position) }):next(function(ok, err)
			if err then return done_err(err) end
			done_ok({ moved = ok })
		end)
		return
	end

	if op == "board.check" then
		cx.board:check(tostring(args.card or ""), args.done ~= false):next(function(ok, err)
			if err then return done_err(err) end
			done_ok({ checked = ok })
		end)
		return
	end

	if op == "board.addLane" then
		cx.board:add_lane(args.board, { title = tostring(args.title or "New lane"), position = tonumber(args.position) }):next(function(lane, err)
			if not lane then return done_err(err) end
			done_ok({ lane = lane })
		end)
		return
	end

	if op == "settings.list" then
		return done_ok({ settings = cx.settings:list(args.prefix and tostring(args.prefix) or nil) })
	end
	if op == "settings.get" then
		return done_ok({ value = cx.settings:get(tostring(args.key or "")) })
	end
	if op == "settings.describe" then
		return done_ok({ description = cx.settings:describe(tostring(args.key or "")) })
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
			if not range then return done_err(err) end
			done_ok({ range = range })
		end)
		return
	end

	if op == "notebook.read" then
		local read = cx.session:read(tonumber(args.pane) or tostring(args.pane or ""))
		if type(read) ~= "table" or read.kind ~= "notebook" then
			return done_err("pane is not an open notebook block")
		end
		return done_ok(read)
	end

	if op == "carly.ask" then
		cx:ask_carly(tostring(args.text or ""))
		return done_ok({ asked = true })
	end
	if op == "carly.schedule" then
		local id = tern.carly.schedule({
			title = tostring(args.title or "pi-tern task"),
			when = args.when and tostring(args.when) or nil,
			on = args.on and tostring(args.on) or nil,
			prompt = args.prompt and tostring(args.prompt) or nil,
		})
		return done_ok({ id = id })
	end
	if op == "carly.tasks" then
		return done_ok({ tasks = tern.carly.tasks() })
	end
	if op == "carly.cancel" then
		return done_ok({ cancelled = tern.carly.cancel(tonumber(args.id) or -1) })
	end

	done_err("unknown op: " .. op)
end

local function mailbox_tick(cx)
	if cx and not state.busy then
		local req = read_request()
		if req then
			state.busy = true
			local ran, err = pcall(handle, cx, req, function() state.busy = false end)
			if not ran then
				respond(tostring(req.id or ""), false, nil, err)
				pcall(tern.fs.remove, "request.json")
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
