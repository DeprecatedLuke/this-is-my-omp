-- omp-board: the issues board as a Tern block.
--
-- Every decision about issues lives in TypeScript: this file shells out to
-- `bin/omp-board api <verb>` and draws what comes back, so the block and the
-- terminal board cannot drift apart. It renders a list of groups with a
-- selectable table each, a detail view, and a dock that carries the last
-- action's status text, the key hints and the state legend.
--
-- Live updates chain `api wait --since <fingerprint>` calls: each one blocks
-- until something under `.omp/issues` or the issues inbox changed, then the
-- block applies the snapshot and waits again.

local ui = tern.ui

-- Resolved from the plugin's own directory, never from PATH.
local BIN = tern.plugin.dir .. "/../bin/omp-board"

local SNAPSHOT_TIMEOUT_MS = 15000
local WAIT_TIMEOUT_MS = 25000
local WAIT_PROCESS_TIMEOUT_MS = WAIT_TIMEOUT_MS + 10000
local FILTER_DEBOUNCE_MS = 150
-- Issues a page key jumps. Tern reports no pane height to a block (`cx.rows` is
-- the size the block was created at and never changes), so this is a fixed step.
local PAGE_STEP = 16

-- Style token per board state: every state its own tone, attention states warm.
local STATE_TONES = {
	["needs-you"] = "error",
	["up-next"] = "accent",
	["open"] = "",
	["running"] = "success",
	["awaiting-deploy"] = "info",
	["deferred"] = "muted",
	["done"] = "success",
}

-- Group header and count tones, and the group order the header lists.
local GROUP_TONES = { finished = "warning", active = "accent", deploy = "info", done = "success" }
local GROUP_ORDER = {
	{ id = "finished", title = "Finished" },
	{ id = "active", title = "Active" },
	{ id = "deploy", title = "Awaiting deploy" },
	{ id = "done", title = "Done" },
}

local SEVERITY_TONES = { critical = "error", high = "warning", medium = "info", low = "muted" }

-- Used until the first snapshot names the real states and done statuses.
local FALLBACK_STATES = {
	{ key = "1", id = "needs-you", title = "Needs you" },
	{ key = "2", id = "up-next", title = "Up next" },
	{ key = "3", id = "open", title = "Open" },
	{ key = "4", id = "running", title = "Running" },
	{ key = "5", id = "awaiting-deploy", title = "Awaiting deploy" },
	{ key = "6", id = "deferred", title = "Deferred" },
	{ key = "7", id = "done", title = "Done" },
}

-- The lowest priority hides first when the pane is narrow. The issue cell (state
-- glyph, `#id`, title and badges; see `rowCells`) carries the top priority and is
-- never dropped, so a row always says which issue it is and where it stands. It
-- is the only column that grows (so the table fills the pane) and the only one
-- that truncates. The rest follow in the terminal board's order and go as the
-- pane narrows in the order the board can best afford to lose them: category,
-- age, severity, then the state's label (the issue cell's tooltip still names
-- the state). The heads are hidden by the plugin's CSS, as the terminal board
-- has none.
local COLUMNS = {
	{ id = "title", head = "Issue", grow = 1, truncate = "end", priority = 20 },
	{ id = "state", head = "State", priority = 4 },
	{ id = "severity", head = "Severity", priority = 3 },
	{ id = "category", head = "Category", priority = 1 },
	{ id = "age", head = "Age", align = "end", priority = 2 },
}

-- The row menu, in the order the terminal board offers the same actions.
local MENU_ACTIONS = {
	["Needs you"] = { kind = "state", state = "needs-you" },
	["Up next"] = { kind = "state", state = "up-next" },
	["Open"] = { kind = "state", state = "open" },
	["Running"] = { kind = "state", state = "running" },
	["Awaiting deploy"] = { kind = "state", state = "awaiting-deploy" },
	["Deferred"] = { kind = "state", state = "deferred" },
	["Done · fixed"] = { kind = "done", status = "fixed" },
	["Done · wontfix"] = { kind = "done", status = "wontfix" },
	["Done · duplicate"] = { kind = "done", status = "duplicate" },
	["Reply…"] = { kind = "reply" },
	["Open file"] = { kind = "file" },
	["Open report"] = { kind = "report" },
}

local function rowMenu(row)
	local menu = {
		"Needs you",
		"Up next",
		"Open",
		"Running",
		"Awaiting deploy",
		"Deferred",
		"Done · fixed",
		"Done · wontfix",
		"Done · duplicate",
		"Reply…",
		"Open file",
	}
	if row.report ~= nil then
		menu[#menu + 1] = "Open report"
	end
	return menu
end

local function baseName(path)
	local trimmed = tostring(path or ""):gsub("/+$", "")
	local name = trimmed:match("([^/]+)$")
	return name or trimmed
end

local function rowSig(row)
	return tostring(row.id) .. "|" .. tostring(row.group) .. "|" .. tostring(row.updated)
end

local function indexOf(rows, id)
	for i = 1, #rows do
		if rows[i].id == id then
			return i
		end
	end
	return nil
end

-- The row's state glyph (the API's `glyph`, a Nerd Font icon) as a span in the
-- row's tone, padded with a no-break space (Tern collapses plain spaces).
local function glyphSpan(row, tone)
	return ui.span(tostring(row.glyph or "") .. "\u{00A0}", tone ~= "" and ("glyph " .. tone) or "glyph")
end

local function rowTone(row)
	if row.group == "finished" then
		return "warning"
	end
	if row.group == "done" then
		return row.status == "fixed" and "success" or "muted"
	end
	return STATE_TONES[row.state] or ""
end

local function locationText(location)
	if location == nil then
		return nil
	end
	if type(location) == "table" then
		local parts = {}
		for _, part in ipairs(location) do
			parts[#parts + 1] = tostring(part)
		end
		if #parts == 0 then
			return nil
		end
		return table.concat(parts, ", ")
	end
	return tostring(location)
end

local function isEmptyTracker(message)
	return message ~= nil and string.find(message, "no .omp/issues", 1, true) ~= nil
end

-- Rendering ---------------------------------------------------------------

local function render(state)
	local cx = state.cx
	if cx == nil then
		return
	end
	local ok = pcall(function()
		cx:render()
	end)
	if not ok then
		-- The block is gone: stop the wait chain rather than spin on a dead pane.
		state.alive = false
	end
end

local function setStatus(state, text, tone)
	if text == nil or text == "" then
		return
	end
	state.status = { text = tostring(text), tone = tone or "muted" }
end

local function selectedRow(state)
	local rows = state.rows or {}
	local index = state.selIndex or 1
	return rows[index]
end

local function selectIndex(state, index)
	local rows = state.rows or {}
	if index == nil or index < 1 or index > #rows then
		return false
	end
	local row = rows[index]
	state.selected = row.id
	state.selIndex = index
	state.selSig = rowSig(row)
	return true
end

-- API ---------------------------------------------------------------------

local function parse(result)
	if result == nil then
		return nil, "omp-board api did not run"
	end
	if result.timed_out then
		return nil, "omp-board api timed out"
	end
	local text = result.stdout or ""
	local data = nil
	if #text > 0 then
		local ok, decoded = pcall(tern.json.decode, text)
		if ok then
			data = decoded
		end
	end
	if data == nil then
		local detail = (result.stderr or ""):gsub("%s+$", "")
		if detail == "" then
			detail = "omp-board api exited " .. tostring(result.status)
		end
		return nil, detail
	end
	if data.error ~= nil then
		return nil, tostring(data.error)
	end
	if result.status ~= 0 then
		return nil, "omp-board api exited " .. tostring(result.status)
	end
	return data, nil
end

local function api(state, verb, args, stdin, onResult)
	local argv = { BIN, "api", verb }
	for _, value in ipairs(args or {}) do
		argv[#argv + 1] = value
	end
	argv[#argv + 1] = "--root"
	argv[#argv + 1] = state.path
	local timeout = verb == "wait" and WAIT_PROCESS_TIMEOUT_MS or SNAPSHOT_TIMEOUT_MS
	local ok, failure = pcall(tern.process.run, argv, { stdin = stdin, timeout_ms = timeout }, function(result)
		onResult(result)
	end)
	if not ok then
		onResult({ status = -1, stdout = "", stderr = tostring(failure), timed_out = false })
	end
end

-- Which checkout each board draws -----------------------------------------
--
-- The window half routes `issues://` clicks to a board that is already open for
-- the clicked pane's checkout, and a pane tells it nothing about that. So every
-- board publishes its checkout to the shared kv store, and the window prunes the
-- entries whose pane is gone.

local REGISTRY_KEY = "boards"

local function publishPane(state)
	local cx = state.cx
	if cx == nil then
		return
	end
	local ok, registry = pcall(tern.kv.get, REGISTRY_KEY)
	if not ok or type(registry) ~= "table" then
		registry = {}
	end
	registry[tostring(cx.pane)] = { path = state.path, root = state.root, at = tern.now() }
	pcall(tern.kv.set, REGISTRY_KEY, registry)
end

-- Snapshots ---------------------------------------------------------------

local function snapshotArgs(state)
	local args = {}
	if state.filter ~= "" then
		args[#args + 1] = "--filter"
		args[#args + 1] = state.filter
	end
	if state.allDone then
		args[#args + 1] = "--all-done"
	end
	return args
end

local function visibleRows(snapshot)
	local rows = {}
	for _, group in ipairs(snapshot.groups or {}) do
		for _, row in ipairs(group.rows or {}) do
			rows[#rows + 1] = row
		end
	end
	return rows
end

local loadDetail

local function openDetail(state)
	local row = selectedRow(state)
	if row == nil then
		return
	end
	state.view = "detail"
	state.detail = nil
	state.detailError = nil
	loadDetail(state)
	-- Opening a Finished issue is how the user says they have dealt with it.
	if row.group == "finished" then
		api(state, "seen", { tostring(row.id) }, nil, function(result)
			local data, failure = parse(result)
			if data == nil then
				setStatus(state, failure, "error")
				render(state)
			end
		end)
	end
end

loadDetail = function(state)
	local id = state.selected
	if id == nil then
		return
	end
	api(state, "detail", { tostring(id) }, nil, function(result)
		if state.selected ~= id then
			return
		end
		local data, failure = parse(result)
		if data == nil then
			state.detailError = failure
			state.detail = nil
		else
			state.detail = data
			state.detailError = nil
		end
		render(state)
	end)
end

local function applySnapshot(state, data)
	local previous = state.selected
	local previousSig = state.selSig
	local previousIndex = state.selIndex or 1

	state.snap = data
	state.fingerprint = data.fingerprint
	-- The checkout is only known from the snapshot; publish it the first time.
	if state.root ~= data.root then
		state.root = data.root
		publishPane(state)
	end
	state.empty = nil
	state.loading = false
	state.rows = visibleRows(data)

	local index = previous ~= nil and indexOf(state.rows, previous) or nil
	if index ~= nil and (previousSig == nil or rowSig(state.rows[index]) == previousSig) then
		-- Other rows moved (or this is a restored block): the cursor stays on the issue.
		state.selIndex = index
	else
		-- The issue moved itself (or left): the cursor keeps its row.
		local target = math.min(math.max(previousIndex, 1), math.max(#state.rows, 1))
		index = #state.rows > 0 and target or nil
		state.selIndex = index or 1
	end
	if index ~= nil then
		local row = state.rows[index]
		state.selected = row.id
		state.selSig = rowSig(row)
	else
		state.selected = nil
		state.selSig = nil
		state.selIndex = 1
	end

	-- A link click asked for one issue: select it and show its detail.
	if state.focusIssue ~= nil then
		local wanted = state.focusIssue
		state.focusIssue = nil
		local wantedIndex = indexOf(state.rows, wanted)
		if wantedIndex ~= nil then
			selectIndex(state, wantedIndex)
			openDetail(state)
		else
			setStatus(state, "#" .. tostring(wanted) .. " is not in this board", "error")
		end
	end
end

local function paneAlive(cx)
	if cx == nil then
		return false
	end
	local ok, panes = pcall(tern.pane.list)
	if not ok or type(panes) ~= "table" then
		return true
	end
	for _, pane in ipairs(panes) do
		if pane.pane == cx.pane then
			return true
		end
	end
	return false
end

local waitLoop

waitLoop = function(state, gen)
	if not state.alive or gen ~= state.gen then
		return
	end
	if not paneAlive(state.cx) then
		state.alive = false
		return
	end
	local since = state.fingerprint or ""
	api(state, "wait", { "--since", since, "--timeout-ms", tostring(WAIT_TIMEOUT_MS) }, nil, function(result)
		if not state.alive or gen ~= state.gen then
			return
		end
		local data, failure = parse(result)
		if data == nil then
			-- A failed wait stops the chain; the next key that refreshes starts it again.
			setStatus(state, failure, "error")
			render(state)
			return
		end
		if data.unchanged then
			waitLoop(state, gen)
			return
		end
		applySnapshot(state, data)
		render(state)
		waitLoop(state, gen)
	end)
end

local function refresh(state)
	state.gen = state.gen + 1
	local gen = state.gen
	api(state, "snapshot", snapshotArgs(state), nil, function(result)
		if not state.alive or gen ~= state.gen then
			return
		end
		local data, failure = parse(result)
		if data == nil then
			state.loading = false
			state.snap = nil
			state.rows = {}
			if isEmptyTracker(failure) then
				state.empty = failure
			else
				setStatus(state, failure, "error")
			end
			render(state)
			return
		end
		applySnapshot(state, data)
		render(state)
		waitLoop(state, gen)
	end)
end

-- Actions -----------------------------------------------------------------

local function moveIssue(state, target, doneStatus)
	local id = state.selected
	if id == nil then
		return
	end
	local args = { tostring(id), target }
	if target == "done" then
		if doneStatus == nil then
			setStatus(state, "Done needs a status: fixed, wontfix or duplicate", "error")
			render(state)
			return
		end
		args[#args + 1] = "--status"
		args[#args + 1] = doneStatus
	end
	api(state, "move", args, nil, function(result)
		local data, failure = parse(result)
		if data == nil then
			setStatus(state, failure, "error")
		else
			setStatus(state, data.message, "success")
		end
		render(state)
		refresh(state)
	end)
end

local function sendReply(state, text)
	local id = state.selected
	if id == nil then
		return
	end
	if text == nil or text:gsub("%s", "") == "" then
		setStatus(state, "A reply needs text", "error")
		render(state)
		return
	end
	api(state, "reply", { tostring(id) }, text, function(result)
		local data, failure = parse(result)
		if data == nil then
			setStatus(state, failure, "error")
		else
			setStatus(state, data.message, "success")
		end
		render(state)
		refresh(state)
	end)
end

local function openFile(state, row)
	if row == nil or row.file == nil then
		return
	end
	local cx = state.cx
	if cx == nil then
		return
	end
	pcall(function()
		cx:open(tostring(row.file))
	end)
end

local function openReport(state, row)
	if row == nil or row.report == nil then
		return
	end
	local cx = state.cx
	if cx == nil then
		return
	end
	pcall(function()
		cx:open(tostring(row.report))
	end)
end

local function runMenu(state, act)
	local action = MENU_ACTIONS[act]
	if action == nil then
		return
	end
	if action.kind == "state" then
		moveIssue(state, action.state)
	elseif action.kind == "done" then
		moveIssue(state, "done", action.status)
	elseif action.kind == "reply" then
		state.mode = "reply"
		state.input = ""
		render(state)
	elseif action.kind == "file" then
		openFile(state, selectedRow(state))
	elseif action.kind == "report" then
		openReport(state, selectedRow(state))
	end
end

local function moveSelection(state, delta)
	local rows = state.rows or {}
	if #rows == 0 then
		return
	end
	local index = state.selIndex or 1
	selectIndex(state, math.min(math.max(index + delta, 1), #rows))
end


local function stateForKey(state, key)
	local states = state.snap ~= nil and state.snap.states or FALLBACK_STATES
	for _, entry in ipairs(states or {}) do
		if entry.key == key then
			return entry
		end
	end
	return nil
end

-- Clickable links ---------------------------------------------------------
--
-- Tern's markdown makes only `http(s)` targets clickable, so an `issues://` or
-- `report://` link in a body would be dead text. Both are rewritten to a host
-- nobody can own, which `route.link` maps back to the real scheme; the link text
-- and the rest of the line are untouched.
local SENTINEL = "https://omp-board.invalid"

local function linkable(text)
	local out = text:gsub("%]%(issues://(%d+)%)", "](" .. SENTINEL .. "/issues/%1)")
	out = out:gsub("%]%(report://([%w%-_%./]+)%)", "](" .. SENTINEL .. "/report/%1)")
	return out
end

-- Keys --------------------------------------------------------------------

local function appendInput(state, key)
	local text = key.text
	if key.name == "space" and (text == nil or text == "") then
		text = " "
	end
	if text == nil or text == "" then
		return false
	end
	state.input = state.input .. text
	return true
end

local function filterChanged(state)
	state.filter = state.input
	state.filterGen = (state.filterGen or 0) + 1
	local gen = state.filterGen
	if state.filterTimer ~= nil then
		state.filterTimer:cancel()
		state.filterTimer = nil
	end
	state.filterTimer = tern.timer(FILTER_DEBOUNCE_MS, function()
		if gen ~= state.filterGen then
			return
		end
		state.filterTimer = nil
		refresh(state)
	end)
end

local function inputKey(state, key)
	local name = key.name
	if name == "enter" then
		state.mode = "none"
		return true
	end
	if name == "escape" then
		-- esc drops the filter, not just the prompt.
		state.mode = "none"
		state.input = ""
		state.filter = ""
		refresh(state)
		return true
	end
	if name == "backspace" then
		if #state.input > 0 then
			state.input = state.input:sub(1, #state.input - 1)
			filterChanged(state)
		end
		return true
	end
	if appendInput(state, key) then
		filterChanged(state)
	end
	return true
end

local function replyKey(state, key)
	local name = key.name
	if name == "enter" then
		local text = state.input
		state.mode = "none"
		state.input = ""
		sendReply(state, text)
		return true
	end
	if name == "escape" then
		state.mode = "none"
		state.input = ""
		return true
	end
	if name == "backspace" then
		state.input = state.input:sub(1, math.max(#state.input - 1, 0))
		return true
	end
	appendInput(state, key)
	return true
end

local function doneKey(state, key)
	local name = key.name
	if name == "escape" then
		state.mode = "none"
		return true
	end
	if name == "f" then
		state.mode = "none"
		moveIssue(state, "done", "fixed")
		return true
	end
	if name == "w" then
		state.mode = "none"
		moveIssue(state, "done", "wontfix")
		return true
	end
	if name == "d" then
		state.mode = "none"
		moveIssue(state, "done", "duplicate")
		return true
	end
	return true
end

local function handleKey(state, key)
	if key.ctrl or key.meta or key.alt then
		return false
	end
	local name = key.name

	if state.mode == "filter" then
		return inputKey(state, key)
	end
	if state.mode == "reply" then
		return replyKey(state, key)
	end
	if state.mode == "done" then
		return doneKey(state, key)
	end

	-- Keys that work in both views.
	if name == "r" then
		state.mode = "reply"
		state.input = ""
		return true
	end
	if name == "e" then
		openFile(state, selectedRow(state))
		return true
	end
	local digit = name:match("^([1-7])$")
	if digit ~= nil then
		local entry = stateForKey(state, digit)
		if entry ~= nil then
			if entry.id == "done" then
				state.mode = "done"
			else
				moveIssue(state, entry.id)
			end
			return true
		end
	end
	if name == "escape" then
		if state.filter ~= "" then
			state.filter = ""
			state.input = ""
			refresh(state)
			return true
		end
		if state.view == "detail" then
			state.view = "list"
			return true
		end
		return false
	end

	if state.view == "detail" then
		-- The detail body is one long node and Tern's surface scrolls it, but a
		-- block cannot scroll that surface: `cx:frame` has no scroll op, BlockCx
		-- has no command call, and the window's `scroll_*` actions are no-ops on
		-- a block's surface (they scroll a terminal's scrollback, not this). So
		-- these keys are left to Tern, which currently means the wheel.
		return false
	end

	if name == "j" or name == "down" then
		moveSelection(state, 1)
		return true
	end
	if name == "k" or name == "up" then
		moveSelection(state, -1)
		return true
	end
	if name == "home" then
		selectIndex(state, 1)
		return true
	end
	if name == "end" then
		selectIndex(state, #(state.rows or {}))
		return true
	end
	if name == "g" then
		-- `G` arrives as `g` with shift held.
		selectIndex(state, key.shift and #(state.rows or {}) or 1)
		return true
	end
	if name == "page_down" then
		moveSelection(state, PAGE_STEP)
		return true
	end
	if name == "page_up" then
		moveSelection(state, -PAGE_STEP)
		return true
	end
	if name == "enter" or name == "i" then
		openDetail(state)
		return true
	end
	if name == "/" then
		state.mode = "filter"
		state.input = state.filter
		return true
	end
	if name == "a" then
		state.allDone = not state.allDone
		refresh(state)
		return true
	end
	return false
end

-- Views -------------------------------------------------------------------

-- The terminal board's two header lines: who and where, with the filter and
-- the Done range on the right of the first; each group's count on the second.
local function headerNode(state)
	local snap = state.snap
	local repo = snap ~= nil and snap.repo or baseName(state.path)
	local root = snap ~= nil and snap.root or state.path
	local counts = snap ~= nil and snap.counts or {}

	local identity = {
		ui.span("▌ ", "accent"),
		ui.span("omp-board", "strong"),
		ui.span(" · ", "muted"),
		ui.span(tostring(repo), "strong"),
		ui.span(" " .. tostring(root), "muted"),
	}
	local chips = {}
	if state.filter ~= "" then
		chips[#chips + 1] = ui.span("/" .. state.filter, "accent")
	end
	if state.allDone then
		chips[#chips + 1] = ui.span("done: all", "warning")
	end
	if #chips == 0 then
		local total = 0
		for _, group in ipairs(GROUP_ORDER) do
			total = total + (counts[group.id] or 0)
		end
		chips[#chips + 1] = ui.span(tostring(total) .. (total == 1 and " issue" or " issues"), "muted")
	end
	identity[#identity + 1] = ui.span("   ", "muted")
	for i, chip in ipairs(chips) do
		if i > 1 then
			identity[#identity + 1] = ui.span(" · ", "muted")
		end
		identity[#identity + 1] = chip
	end

	local countSpans = {}
	for i, group in ipairs(GROUP_ORDER) do
		if i > 1 then
			countSpans[#countSpans + 1] = ui.span(" · ", "muted")
		end
		countSpans[#countSpans + 1] = ui.span(group.title .. " ", GROUP_TONES[group.id] or "")
		countSpans[#countSpans + 1] = ui.span(tostring(counts[group.id] or 0), "strong")
	end
	return ui.col({ ui.text(identity), ui.text(countSpans) })
end

-- The row's badges ride in the title cell, right after the text, as the
-- terminal board's coloured words: they cost no column of their own and the
-- title keeps the whole spare width. A Done title recedes, as in the terminal.
local function titleSpans(row)
	local settled = row.group == "done"
	local spans = { ui.span(tostring(row.title or ""), settled and "muted" or nil) }
	local badges = {}
	if (row.replies or 0) > 0 then
		badges[#badges + 1] = ui.span("reply", "warning")
	end
	if row.claim ~= nil then
		-- U+F4E3 nf-oct-hourglass, as `GLYPHS.claim` in src/model.ts.
		badges[#badges + 1] = ui.span("\u{F4E3} " .. tostring(row.claim), "accent")
	end
	if row.report ~= nil then
		badges[#badges + 1] = ui.span("report", "accent")
	end
	for i, badge in ipairs(badges) do
		spans[#spans + 1] = ui.span(i == 1 and "  " or " · ", "muted")
		spans[#spans + 1] = badge
	end
	return spans
end

-- A rule the way the terminal board draws one: the label at the left, then the
-- line to the pane's edge in `tone`. Tern centres a rule's label between two
-- lines of its own colour; the plugin's CSS hides those and cuts this line at the
-- edge instead.
local function ruleNode(label, tone)
	local spans = {}
	for _, span in ipairs(label) do
		spans[#spans + 1] = span
	end
	spans[#spans + 1] = ui.span(" " .. string.rep("─", 400), tone ~= "" and tone or "muted")
	return ui.rule(spans)
end

-- Each group is its own table, and a column is as wide as its widest cell, so
-- cells are padded to the widest value on the whole board for the groups to line
-- up as the terminal board's one list does. The padding is no-break spaces:
-- Tern collapses runs of plain ones.
local function pad(text, width)
	local missing = width - utf8.len(text)
	if missing > 0 then
		return text .. string.rep("\u{00A0}", missing)
	end
	return text
end

local function padStart(text, width)
	local missing = width - utf8.len(text)
	if missing > 0 then
		return string.rep("\u{00A0}", missing) .. text
	end
	return text
end

-- Widest `#id`, state label, category and age on the board.
local function boardWidths(state)
	local widths = { id = 0, label = 0, category = 0, age = 0 }
	for _, row in ipairs(state.rows or {}) do
		widths.id = math.max(widths.id, utf8.len("#" .. tostring(row.id)))
		widths.label = math.max(widths.label, utf8.len(tostring(row.label or "")))
		widths.category = math.max(widths.category, utf8.len(tostring(row.category or "")))
		widths.age = math.max(widths.age, utf8.len(tostring(row.age or "")))
	end
	return widths
end

-- Wide enough for `critical`, as in the terminal board.
local SEVERITY_WIDTH = 8

local function severitySpan(severity)
	if severity == nil then
		return ui.span(pad("—", SEVERITY_WIDTH), "muted")
	end
	local tone = SEVERITY_TONES[severity] or ""
	-- Critical stands out from high, as in the terminal board.
	if severity == "critical" then
		tone = "strong " .. tone
	end
	return ui.span(pad(tostring(severity), SEVERITY_WIDTH), tone)
end

local function rowCells(row, widths)
	local tone = rowTone(row)
	local settled = row.group == "done"
	-- The id leads the text, bold and padded to the widest id so the titles start
	-- in one column; a Done id recedes like its title.
	local text = titleSpans(row)
	table.insert(text, 1, ui.span(pad("#" .. tostring(row.id), widths.id) .. "\u{00A0}", settled and "strong muted" or "strong"))
	-- The state glyph leads the title cell: a cell's text truncates at its end, and
	-- the title column is never dropped, so the glyph shows at any width. The label
	-- is the cell's tooltip and has its own column, which goes before the title
	-- when the pane narrows.
	table.insert(text, 1, glyphSpan(row, tone))
	return {
		{
			text = text,
			title = tostring(row.label or ""),
		},
		{ ui.span(pad(tostring(row.label or ""), widths.label), tone) },
		{ severitySpan(row.severity) },
		{ ui.span(pad(tostring(row.category or ""), widths.category), "muted") },
		{ ui.span(padStart(tostring(row.age or ""), widths.age), "muted") },
	}
end

local function groupTable(state, group)
	local rows = {}
	local widths = boardWidths(state)
	for _, row in ipairs(group.rows or {}) do
		rows[#rows + 1] = {
			id = tostring(row.id),
			cells = rowCells(row, widths),
			menu = rowMenu(row),
			title = tostring(row.title or ""),
		}
	end
	local selected = state.selected ~= nil and tostring(state.selected) or nil
	return ui.table(COLUMNS, rows, {
		selectable = true,
		selected = selected,
		empty = ui.span("none", "muted"),
	})
end

local function listNode(state)
	local children = { headerNode(state) }
	if state.empty ~= nil then
		children[#children + 1] = ui.text({ ui.span("No issues board here", "strong") })
		children[#children + 1] = ui.text({ ui.span(tostring(state.empty), "muted") })
		children[#children + 1] = ui.text({
			ui.span("Open the board from a pane inside a checkout that has .omp/issues, or file one there first.", "muted"),
		})
		return ui.col(children)
	end
	local snap = state.snap
	if snap == nil then
		children[#children + 1] = ui.text({ ui.span(state.loading and "Loading…" or "No snapshot yet", "muted") })
		return ui.col(children)
	end
	local groups = snap.groups or {}
	for _, group in ipairs(groups) do
		local title = tostring(group.title or group.id)
		-- The terminal board's group header: a bar, the title in bold and the
		-- count, on a rule in the group's own colour.
		local tone = GROUP_TONES[group.id] or ""
		children[#children + 1] = ruleNode({
			ui.span("▌ ", tone),
			ui.span(title, "strong " .. tone),
			ui.span(" " .. tostring(#(group.rows or {})), "muted"),
		}, tone)
		children[#children + 1] = groupTable(state, group)
	end
	if #groups == 0 then
		local message = state.filter ~= "" and ("nothing matches " .. state.filter) or "no issues"
		children[#children + 1] = ui.text({ ui.span(message, "muted") })
	end
	return ui.col(children)
end

local function detailNode(state)
	local detail = state.detail
	if detail == nil then
		local text = state.detailError or "Loading issue…"
		local tone = state.detailError ~= nil and "error" or "muted"
		return ui.col({ ui.text({ ui.span(tostring(text), tone) }) })
	end
	local row = detail.row or selectedRow(state) or {}
	local items = {}
	local function add(label, value)
		items[#items + 1] = { ui.span(label, "muted"), value }
	end
	add("id", { ui.span("#" .. tostring(row.id), "mono") })
	add("state", { ui.span(tostring(row.label or ""), rowTone(row)) })
	if row.severity ~= nil then
		add("severity", { ui.span(tostring(row.severity), SEVERITY_TONES[row.severity] or "") })
	end
	add("category", { ui.span(tostring(row.category or ""), "") })
	local location = locationText(detail.location)
	if location ~= nil then
		add("location", { ui.span(location, "mono") })
	end
	if detail.created ~= nil then
		add("created", { ui.span(tostring(detail.created), "muted") })
	end
	if row.updated ~= nil then
		add("updated", { ui.span(tostring(row.updated), "muted") })
	end
	if detail.claimFull ~= nil then
		add("claimed by", { ui.span(tostring(detail.claimFull), "mono") })
	end
	if detail.reportValue ~= nil then
		if row.report ~= nil then
			add("report", { ui.link(tostring(detail.reportValue), tostring(row.report)) })
		else
			add("report", { ui.span(tostring(detail.reportValue), "muted") })
		end
	end
	if row.file ~= nil then
		add("file", { ui.path(tostring(row.file), state.path) })
	end

	-- A card headed by the issue, led by the row's state glyph in the row's tone.
	local tone = rowTone(row)
	local children = {}
	-- The first block above the issue card: a bold title in the block's tone, then
	-- its text below in that tone, one line per written line.
	local function topBlock(title, blockTone, text)
		local style = blockTone ~= "" and ("strong " .. blockTone) or "strong"
		local lines = { ui.text({ ui.span(title, style) }) }
		for line in text:gmatch("[^\r\n]+") do
			lines[#lines + 1] = ui.text({ ui.span(line, blockTone) })
		end
		return ui.col(lines)
	end
	-- An archived issue opens with its closing remarks: how it ended. An active
	-- needs-you issue leads with what it waits on, saying so when no ask was
	-- recorded (set from the board, or by a session older than the field); an
	-- awaiting-deploy issue gets only the roll its `needs` spells out.
	local stage = row.stage
	local remarks = tostring(row.remarks or "")
	if row.archived and remarks:gsub("%s", "") ~= "" then
		children[#children + 1] = topBlock("Closing remarks", tone, remarks)
	elseif not row.archived and (stage == "needs-you" or stage == "awaiting-deploy") then
		local needsTone = STATE_TONES[stage]
		local needs = tostring(row.needs or "")
		if needs:gsub("%s", "") ~= "" then
			children[#children + 1] = topBlock(stage == "awaiting-deploy" and "Deploy" or "Needs you", needsTone, needs)
		elseif stage == "needs-you" then
			children[#children + 1] = ui.col({
				ui.text({ ui.span("Needs you", "strong " .. needsTone) }),
				ui.text({ ui.span("No ask recorded; read the issue below.", "muted") }),
			})
		end
	end
	children[#children + 1] = ui.card(
		{ glyphSpan(row, tone), ui.span("#" .. tostring(row.id) .. " ", "mono"), ui.span(tostring(row.title or ""), "strong") },
		{ ui.kv(items) }
	)
	local replies = detail.replies or {}
	if #replies > 0 then
		children[#children + 1] = ruleNode({ ui.span("pending replies", "warning") }, "muted")
		local lines = {}
		for _, reply in ipairs(replies) do
			lines[#lines + 1] = ui.text({
				ui.span(tostring(reply.at or ""), "muted"),
				ui.span("  " .. tostring(reply.text or "")),
			})
		end
		children[#children + 1] = ui.col(lines)
	end
	children[#children + 1] = ruleNode({ ui.span("body", "muted") }, "muted")
	children[#children + 1] = ui.md(linkable(tostring(detail.body or "")))
	return ui.col(children)
end

local LIST_HINTS = {
	{ keys = { "j", "k" }, label = "move" },
	{ keys = { "g", "G" }, label = "ends" },
	{ keys = { "enter" }, label = "open" },
	{ keys = { "r" }, label = "reply" },
	{ keys = { "e" }, label = "edit" },
	{ keys = { "/" }, label = "filter" },
	{ keys = { "a" }, label = "all done" },
	{ keys = { "1–7" }, label = "state" },
	{ keys = { "esc" }, label = "back" },
}

-- Nothing scrolls the detail from a key (see the detail branch of `handleKey`),
-- so the hints name no scroll keys.
local DETAIL_HINTS = {
	{ keys = { "r" }, label = "reply" },
	{ keys = { "e" }, label = "edit" },
	{ keys = { "1–7" }, label = "state" },
	{ keys = { "esc" }, label = "back" },
}

local function hintsNode(state)
	local hints = state.view == "detail" and DETAIL_HINTS or LIST_HINTS
	local spans = {}
	for i, hint in ipairs(hints) do
		if i > 1 then
			spans[#spans + 1] = ui.span("  ", "muted")
		end
		for j, key in ipairs(hint.keys) do
			if j > 1 then
				spans[#spans + 1] = ui.span(" ", "muted")
			end
			spans[#spans + 1] = ui.span(key, "key")
		end
		spans[#spans + 1] = ui.span(" " .. hint.label, "muted")
	end
	return ui.text(spans)
end

local function legendNode(state)
	local states = state.snap ~= nil and state.snap.states or FALLBACK_STATES
	local spans = {}
	for i, entry in ipairs(states or {}) do
		if i > 1 then
			spans[#spans + 1] = ui.span(" · ", "muted")
		end
		local tone = STATE_TONES[entry.id] or "muted"
		spans[#spans + 1] = ui.span(tostring(entry.key) .. " " .. tostring(entry.title), tone)
	end
	return ui.text(spans)
end

local function dockNode(state)
	local children = {}
	if state.mode == "filter" then
		children[#children + 1] = ui.text({
			ui.span("filter ", "muted"),
			ui.span(state.input),
			ui.span("▏", "accent"),
		})
	elseif state.mode == "reply" then
		children[#children + 1] = ui.text({
			ui.span("reply #" .. tostring(state.selected or "?"), "accent"),
			ui.span("  " .. state.input),
			ui.span("▏", "accent"),
		})
	elseif state.mode == "done" then
		children[#children + 1] = ui.text({
			ui.span("done #" .. tostring(state.selected or "?"), "accent"),
			ui.span("  f fixed · w wontfix · d duplicate · esc cancels", "muted"),
		})
	end
	if state.status ~= nil then
		children[#children + 1] = ui.text({ ui.span(tostring(state.status.text), state.status.tone) })
	end
	children[#children + 1] = hintsNode(state)
	children[#children + 1] = legendNode(state)
	return ui.col(children)
end

-- The block ---------------------------------------------------------------

tern.block.define("board", {
	init = function(cx, args, saved)
		local state = {
			cx = cx,
			path = nil,
			root = nil,
			filter = "",
			allDone = false,
			selected = nil,
			selIndex = 1,
			selSig = nil,
			rows = {},
			snap = nil,
			detail = nil,
			status = nil,
			mode = "none",
			input = "",
			view = "list",
			gen = 0,
			alive = true,
			loading = true,
			focusIssue = nil,
		}
		if type(saved) == "table" then
			if type(saved.path) == "string" and saved.path ~= "" then
				state.path = saved.path
			end
			if type(saved.filter) == "string" then
				state.filter = saved.filter
			end
			state.allDone = saved.allDone == true
			if type(saved.selected) == "number" then
				state.selected = saved.selected
			end
		end

		local issueId = nil
		local i = 1
		while i <= #args do
			local arg = args[i]
			if arg == "--issue" then
				issueId = tonumber(args[i + 1])
				i = i + 2
			else
				if state.path == nil and arg ~= "" and arg:sub(1, 1) ~= "-" then
					state.path = arg
				end
				i = i + 1
			end
		end
		if state.path == nil then
			state.path = cx.cwd or ""
		end
		if issueId ~= nil then
			state.focusIssue = issueId
			state.selected = issueId
		end
		state.input = state.filter

		-- The pane id is only known from `cx`, so the entry is written here and
		-- rewritten with the checkout root once the first snapshot lands.
		state.cx = cx
		publishPane(state)
		refresh(state)
		return state
	end,

	view = function(state, cx)
		state.cx = cx
		local main
		if state.view == "detail" then
			main = detailNode(state)
		else
			main = listNode(state)
		end
		return { main = main, dock = dockNode(state) }
	end,

	title = function(state)
		local repo = state.snap ~= nil and state.snap.repo or baseName(state.path)
		return "Issues · " .. tostring(repo)
	end,

	key = function(state, key, cx)
		state.cx = cx
		return handleKey(state, key)
	end,

	event = function(state, ev, cx)
		state.cx = cx
		if ev.ev == "action" and ev.act == "focus-issue" then
			-- A link click asked this board for an issue: select it and show it.
			local id = tonumber(ev.value)
			if id == nil then
				return
			end
			local index = indexOf(state.rows or {}, id)
			if index ~= nil then
				selectIndex(state, index)
				openDetail(state)
				render(state)
			else
				-- Filtered out, or not in this board yet: the snapshot pass
				-- selects and opens it once the issue arrives.
				state.focusIssue = id
				refresh(state)
			end
			return
		end
		if ev.ev == "select" or ev.ev == "activate" then
			local id = tonumber(ev.item)
			if id ~= nil then
				local index = indexOf(state.rows, id)
				if index ~= nil then
					selectIndex(state, index)
				end
			end
			if ev.ev == "activate" then
				openDetail(state)
			end
			render(state)
			return
		end
		if ev.ev == "action" then
			local id = tonumber(ev.item)
			if id ~= nil then
				local index = indexOf(state.rows, id)
				if index ~= nil then
					selectIndex(state, index)
				end
			end
			runMenu(state, ev.act)
		end
	end,

	font = "mono",

	save = function(state)
		return {
			path = state.path,
			filter = state.filter,
			allDone = state.allDone,
			selected = state.selected,
		}
	end,
})
