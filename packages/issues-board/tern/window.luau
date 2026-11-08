-- omp-board: the palette command that opens the board, and `issues://<N>` clicks.
--
-- Both hand the block the directory they were opened from, so it shows that
-- checkout's tracker.

local BLOCK = "omp-board.board"

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

tern.command({
	id = "open",
	title = "Open issues board",
	group = "Issues",
	keys = CHORDS,
	run = function(cx)
		openBoard(cx, paneCwd(cx, cx.session:focused()), nil)
	end,
})

tern.route.link(function(link, cx)
	local id = link.url:match("^issues://(%d+)/?$")
	if id == nil then
		return nil
	end
	return { block = BLOCK, args = { paneCwd(cx, link.pane), "--issue", id } }
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
