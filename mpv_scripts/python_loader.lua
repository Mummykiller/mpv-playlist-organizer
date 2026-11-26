local utils = require 'mp.utils'

-- Fallback Trackers
local last_heartbeat = 0
local session_duration = 0
local last_sync_time = 0
local last_time_pos = nil
local playback_active = false
local fallback_attempted = false
local current_item_id = nil

-- Dedicated debug log
local function debug_log(msg)
    mp.msg.info("PythonLoader: " .. msg)
end

local function safe_read_file(path)
    if utils.read_file then
        local content = utils.read_file(path)
        if content then return content end
    end
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*all")
    f:close()
    return content
end

-- Read Metadata Handshake
local function load_handshake()
    local handshake_path = mp.get_opt("mpv_organizer-handshake")
    if handshake_path and handshake_path ~= "" then
        local content = safe_read_file(handshake_path)
        if content then
            local ok, data = pcall(utils.parse_json, content)
            if ok and data then
                return data
            end
        end
    end
    return nil
end

local handshake_data = load_handshake()

local function get_python_executable()
    local candidates = {
        handshake_data and handshake_data.python_executable or nil,
        mp.get_property("user-data/python-executable"),
        mp.get_opt("python_executable") or mp.get_opt(mp.get_script_name() .. "-python_executable"),
    }
    for _, candidate in ipairs(candidates) do
        if type(candidate) == "string" then
            local trimmed = candidate:gsub("^%s*(.-)%s*$", "%1")
            local lower = trimmed:lower()
            if trimmed ~= "" and lower ~= "null" and lower ~= "nil" and lower ~= "undefined" then
                return trimmed
            end
        end
    end
    return (package.config:sub(1,1) == [[\]]) and "python" or "python3"
end

-- Nuclear String Cleaner: Strips all literal quotes and handles "null"
local function clean_value(val)
    if val == nil then return nil end
    local s = tostring(val)
    s = s:gsub('"', ''):gsub("'", "")
    s = s:gsub("^%s*(.-)%s*$", "%1")
    if s == "" or s:lower() == "null" or s:lower() == "nil" or s:lower() == "undefined" then 
        return nil 
    end
    return s
end

-- Heartbeat from Python tracker
mp.register_script_message("tracker_heartbeat", function()
    last_heartbeat = mp.get_time()
end)

-- Logging from Python tracker
mp.register_script_message("python_log", function(msg)
    if msg then debug_log(msg) end
end)

-- Central Sync Trigger (Dumb Trigger, Smart Python)
local function run_fallback_sync(params)
    local is_unmanaged_raw = mp.get_property("user-data/is-unmanaged")
    local is_unmanaged = clean_value(is_unmanaged_raw) == "yes"
    local ipc_server = mp.get_property("input-ipc-server")
    local has_ipc = ipc_server and ipc_server ~= ""

    -- Managed Session Logic
    if has_ipc and not is_unmanaged then
        -- Check if primary Python manager is active (within last 12 seconds)
        local time_since_hb = mp.get_time() - last_heartbeat
        -- If manager is alive, block fallback sync
        if time_since_hb < 12 then return end
    end

    -- Unmanaged (Disconnected) Session Isolation:
    -- ONLY allowed to mark-as-watched. Block all other sync actions.
    if is_unmanaged and not params.mark_watched then
        return 
    end

    local project_root = clean_value(mp.get_property("user-data/project-root"))
    local folder_id = clean_value(mp.get_property("user-data/folder-id"))
    local item_id = params.item_id or current_item_id or clean_value(mp.get_property("user-data/id"))

    if not project_root or not folder_id or not item_id then return end

    local script_path = utils.join_path(project_root, "utils/fallback_sync.py")
    local python_bin = get_python_executable()

    -- Build arguments
    local args = {python_bin, script_path, "--folder", folder_id, "--item", item_id}
    
    if not is_unmanaged then
        if params.time then table.insert(args, "--time") table.insert(args, tostring(params.time)) end
        if params.last_played then table.insert(args, "--last-played") end
    end
    if params.mark_watched then
        local url = clean_value(mp.get_property("user-data/original-url")) or clean_value(mp.get_property("path"))
        local cookies = clean_value(mp.get_property("cookies-file"))
        local browser = clean_value(mp.get_property("user-data/cookies-browser"))
        local ua = clean_value(mp.get_property("user-agent"))
        
        if url and (cookies or browser) then
            table.insert(args, "--mark-watched")
            table.insert(args, "--url") table.insert(args, url)
            table.insert(args, "--cookies") table.insert(args, cookies or browser)
            if ua then table.insert(args, "--ua") table.insert(args, ua) end
        elseif is_unmanaged then
            return
        end
    end

    local cmd = {
        name = "subprocess",
        args = args,
        playback_only = false,
        detach = true -- Critical for shutdown sync
    }
    
    mp.command_native_async(cmd, function(success, result, err)
        if not success then
            mp.msg.warn("PythonLoader: fallback_sync.py launch failed: " .. tostring(err))
        elseif result and result.status and result.status ~= 0 then
            local detail = (result.error_string and result.error_string ~= "")
                and (" (" .. tostring(result.error_string) .. ")") or ""
            mp.msg.warn("PythonLoader: fallback_sync.py exited with status " .. tostring(result.status) .. detail)
        end
    end)
end

mp.register_event("file-loaded", function()
    current_item_id = clean_value(mp.get_property("user-data/id"))
end)

-- 1. On File Start: Update 'Last Played' highlight
mp.register_event("start-file", function()
    session_duration = 0
    last_sync_time = 0
    last_time_pos = nil
    playback_active = true
    fallback_attempted = false
    
    mp.add_timeout(0.2, function()
        run_fallback_sync({last_played = true})
    end)
end)

-- 2. During Playback: Periodic Time Sync & Mark Watched
mp.observe_property("time-pos", "number", function(_name, val)
    if not val or not playback_active then return end
    
    if last_time_pos then
        local delta = val - last_time_pos
        if delta > 0 and delta < 2 then
            session_duration = session_duration + delta
            
            -- Periodic Time Save (Every 10s)
            if session_duration - last_sync_time >= 10 then
                last_sync_time = session_duration
                run_fallback_sync({time = val})
            end

            -- Mark Watched Threshold
            if session_duration >= 30 and not fallback_attempted then
                fallback_attempted = true
                run_fallback_sync({mark_watched = true, time = val})
            end
        end
    end
    last_time_pos = val
end)

-- 3. On File End / Shutdown: Final Time Sync
mp.register_event("end-file", function(event)
    playback_active = false
    local time = mp.get_property_number("time-pos") or last_time_pos
    local target_id = current_item_id
    current_item_id = nil
    
    if event.reason == "eof" then
        -- We trust the primary Python tracker to handle EOF if active.
        -- If Python is dead (hb > 12s), fallback will still trigger.
        run_fallback_sync({mark_watched = true, time = 0, item_id = target_id}) 
    elseif event.reason == "stop" or event.reason == "quit" then
        -- Rely on heartbeat check so we don't race PlaylistTracker's own shard commit;
        -- if Python is dead/absent (hb > 12s), fallback will still trigger.
        run_fallback_sync({time = time, item_id = target_id})
    end
end)

debug_log("Python interaction script loaded.")

-- Monitor logs for yt-dlp errors
mp.enable_messages("info")
mp.register_event("log-message", function(e)
    if e.prefix == "ytdl_hook" then
        if e.text:find("Requested format is not available", 1, true) or
           e.text:find("youtube-dl failed", 1, true) or
           e.text:find("Sign in to confirm your age", 1, true) or
           e.text:find("confirm you're not a bot", 1, true) or
           e.text:find("confirm you’re not a bot", 1, true) or
           e.text:find("403: Forbidden", 1, true) then
            
            debug_log("Detected YTDL Error: " .. e.text)
            mp.commandv("script-message", "ytdl_error_detected", e.text)
        end
    end
end)
