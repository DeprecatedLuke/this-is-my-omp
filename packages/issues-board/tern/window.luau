-- omp-board: the palette command that opens the board, and the link clicks.
--
-- `issues://<N>` opens the board for the clicked pane's checkout, with that
-- issue selected and its detail open: in a board block that is already open for
-- that checkout (reused, not stacked), or in a new block beside the pane when
-- there is none.
--
-- `report://<project>/<slug>` is resolved to the report site's URL by
-- `omp-board api report-url` and opened in Tern's browser. Resolution is async,
-- so the click is claimed and the URL is opened from the process callback.
-- Plain `http(s)` links are left to Tern.

local BLOCK = "omp-board.board"
local BIN = tern.plugin.dir .. "/../bin/omp-board"
local REPORT_TIMEOUT_MS = 10000

-- The board asks for `ctrl+alt+i`, which the preset leaves free (`ctrl+shift+i`
-- is the inbox and `ctrl+shift+b` opens a browser block). A chord the preset
-- takes is dropped, so a user keymap can rebind it without breaking the plugin.
local CHORDS = { "ctrl+alt+i" }

local function paneCwd(cx, pane)
	if pane == nil then
		return ""
	end
	local info = cx.session:pane(pane)
	if info == nil or info.cwd == nil then
		return ""
	end
	return info.cwd
end

local function paneInfo(cx, pane)
	if pane == nil then
		return nil
	end
	local ok, info = pcall(function()
		return cx.session:pane(pane)
	end)
	if not ok then
		return nil
	end
	return info
end

local function isBoard(info)
	if info == nil then
		return false
	end
	if info.block ~= nil then
		return info.block == BLOCK
	end
	return info.kind == "plugin"
end

-- Panes of this window that are board blocks, from `cx.session:panes`.
local function boardPanes(cx)
	local panes = {}
	local ok, list = pcall(function()
		return cx.session:panes()
	end)
	if not ok or type(list) ~= "table" then
		return panes
	end
	for _, info in ipairs(list) do
		if isBoard(info) then
			panes[info.pane] = true
		end
	end
	return panes
end

-- Every board writes its checkout into the shared kv store on start, because a
-- pane's own `cwd` is all the window knows of it and that does not say which
-- checkout the board is drawing.
local function boardFor(cx, clicked)
	local clickedInfo = paneInfo(cx, clicked)
	if isBoard(clickedInfo) then
		return clicked
	end
	local cwd = paneCwd(cx, clicked)
	if cwd == "" then
		return nil
	end
	local ok, registry = pcall(tern.kv.get, "boards")
	if not ok or type(registry) ~= "table" then
		return nil
	end
	local live = boardPanes(cx)
	for key, entry in pairs(registry) do
		local pane = tonumber(key)
		if pane ~= nil and live[pane] == true and type(entry) == "table" then
			local root = entry.root or entry.path
			if type(root) == "string" and root ~= "" then
				local inside = cwd == root
					or cwd:sub(1, #root + 1) == root .. "/"
					or root:sub(1, #cwd + 1) == cwd .. "/"
				if inside then
					return pane
				end
			end
		end
	end
	return nil
end

-- Select `id` and open its detail in an open board.
local function reveal(cx, pane, id)
	pcall(function()
		cx.layout:focus(pane)
	end)
	pcall(function()
		cx.session:event(pane, { ev = "action", id = "board", act = "focus-issue=" .. tostring(id) })
	end)
end

local function openBoard(cx, cwd, issue)
	local args = {}
	if cwd ~= nil and cwd ~= "" then
		args[#args + 1] = cwd
	end
	if issue ~= nil then
		args[#args + 1] = "--issue"
		args[#args + 1] = tostring(issue)
	end
	local pane = cx:new_block(BLOCK, args, "beside")
	if pane == nil then
		cx:toast("error", "Issues board is not available here", "the omp-board plugin's board block is not ready on this host")
	end
	return pane
end

-- `report-url` prints one JSON object: `{url}` or `{error}`.
local function reportTarget(result)
	if result == nil then
		return nil, "omp-board api did not run"
	end
	if result.timed_out then
		return nil, "omp-board api timed out"
	end
	local text = result.stdout or ""
	if #text > 0 then
		local ok, data = pcall(tern.json.decode, text)
		if ok and type(data) == "table" then
			if type(data.url) == "string" and data.url ~= "" then
				return data.url, nil
			end
			if data.error ~= nil then
				return nil, tostring(data.error)
			end
		end
	end
	local detail = (result.stderr or ""):gsub("%s+$", "")
	if detail == "" then
		detail = "omp-board api exited " .. tostring(result.status)
	end
	return nil, detail
end

local function openReport(cx, pane, value)
	local root = paneCwd(cx, pane)
	if root == "" then
		root = tern.plugin.dir
	end
	local argv = { BIN, "api", "report-url", value, "--root", root }
	tern.process.run(argv, { timeout_ms = REPORT_TIMEOUT_MS }, function(result, wcx)
		local url, failure = reportTarget(result)
		if url == nil then
			wcx:toast("error", "Report link did not resolve", failure)
			return
		end
		wcx:open(url)
	end)
end

tern.command({
	id = "open",
	title = "Open issues board",
	group = "Issues",
	keys = CHORDS,
	run = function(cx)
		openBoard(cx, paneCwd(cx, cx.session:focused()), nil)
	end,
})

-- The host rewrites `issues://` and `report://` links in a body to this host, so
-- Tern's markdown makes them clickable at all.
local SENTINEL = "^https://omp%-board%.invalid"

tern.route.link(function(link, cx)
	local issue = link.url:match("^issues://(%d+)/?$") or link.url:match(SENTINEL .. "/issues/(%d+)$")
	if issue ~= nil then
		local pane = boardFor(cx, link.pane)
		if pane ~= nil then
			reveal(cx, pane, issue)
			return { handled = true }
		end
		return { block = BLOCK, args = { paneCwd(cx, link.pane), "--issue", issue } }
	end
	local report = link.url:match("^report://%S+$") or link.url:match(SENTINEL .. "/report/([%w%-_%./]+)$")
	if report ~= nil then
		openReport(cx, link.pane, report:sub(1, 7) == "report:" and report or ("report://" .. report))
		return { handled = true }
	end
	return nil
end)

-- Say once per window which chord the board actually got.
tern.on("window_start", function(cx)
	local keys = cx.actions:keys()
	for _, chord in ipairs(CHORDS) do
		local bound = false
		local ids = keys[chord]
		if ids ~= nil then
			for _, id in ipairs(ids) do
				if id == "plugin.omp-board.open" then
					bound = true
				end
			end
		end
		tern.log.info("omp-board: " .. chord .. (bound and " opens the issues board" or " is taken; the board opens from the palette"))
	end
end)
