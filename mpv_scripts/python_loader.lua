local utils = require 'mp.utils'

-- Fallback Trackers
local last_heartbeat = 0
local session_duration = 0
local last_time_pos = nil
local playback_active = false
local fallback_attempted = false
local fallback_skip_notified = false

-- Dedicated debug log
local function debug_log(msg)
    mp.msg.info("PythonLoader: " .. msg)
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
        -- If manager is alive, block fallback sync unless forced
        if not params.force and time_since_hb < 12 then return end
    end

    -- Unmanaged (Disconnected) Session Isolation:
    -- ONLY allowed to mark-as-watched. Block all other sync actions.
    if is_unmanaged and not params.mark_watched then
        return 
    end

    local project_root = clean_value(mp.get_property("user-data/project-root"))
    local folder_id = clean_value(mp.get_property("user-data/folder-id"))
    local item_id = clean_value(mp.get_property("user-data/id"))

    if not project_root or not folder_id or not item_id then return end

    local script_path = utils.join_path(project_root, "utils/fallback_sync.py")
    local python_bin = (package.config:sub(1,1) == [[\]]) and "python" or "python3"

    -- Build arguments
    local args = {python_bin, script_path, "--folder", folder_id, "--item", item_id}
    
    if params.time then table.insert(args, "--time") table.insert(args, tostring(params.time)) end
    if params.last_played then table.insert(args, "--last-played") end
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
        end
    end

    local cmd = {
        name = "subprocess",
        args = args,
        playback_only = false,
        detach = true -- Critical for shutdown sync
    }
    
    mp.command_native_async(cmd, function() end)
end

-- 1. On File Start: Update 'Last Played' highlight
mp.register_event("start-file", function()
    session_duration = 0
    last_time_pos = nil
    playback_active = true
    fallback_attempted = false
    fallback_skip_notified = false
    
    -- Sync IDs immediately so tracker is ready
    local fid = clean_value(mp.get_property("user-data/folder-id"))
    local iid = clean_value(mp.get_property("user-data/id"))
    
    mp.add_timeout(0.2, function()
        run_fallback_sync({last_played = true})
    end)
end)

-- 2. During Playback: Periodic Time Sync & Mark Watched
mp.observe_property("time-pos", "number", function(name, val)
    if not val or not playback_active then return end
    
    if last_time_pos then
        local delta = val - last_time_pos
        if delta > 0 and delta < 2 then
            session_duration = session_duration + delta
            
            -- Periodic Time Save (Every 10s)
            if math.floor(session_duration) % 10 == 0 and math.floor(session_duration) ~= math.floor(session_duration - delta) then
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
    local time = mp.get_property_number("time-pos")
    
    if event.reason == "eof" then
        -- REMOVED force=true: We trust the primary Python tracker to handle EOF if active.
        -- If Python is dead (hb > 12s), fallback will still trigger.
        run_fallback_sync({mark_watched = true, time = 0}) 
    elseif event.reason == "stop" or event.reason == "quit" then
        run_fallback_sync({time = time, force = true})
    end
end)

-- 4. Fast Shutdown Signal: Block browser retries instantly
mp.register_event("quit", function()
    debug_log("Shutdown detected. Signaling browser...")
    mp.commandv("script-message", "mpv_quitting")
end)

debug_log("Python interaction script loaded.")

-- Monitor logs for yt-dlp and ffmpeg errors
mp.enable_messages("info")
local reconnect_counter = 0
local total_reconnects = 0
local last_reconnect_offset = ""

mp.register_event("start-file", function()
    session_duration = 0
    last_time_pos = nil
    playback_active = true
    fallback_attempted = false
    fallback_skip_notified = false
    reconnect_counter = 0
    total_reconnects = 0
    last_reconnect_offset = ""
    
    -- Sync IDs immediately so tracker is ready
    local fid = clean_value(mp.get_property("user-data/folder-id"))
    local iid = clean_value(mp.get_property("user-data/id"))
    
    mp.add_timeout(0.2, function()
        run_fallback_sync({last_played = true})
    end)
end)

mp.register_event("log-message", function(e)
    if e.prefix == "ytdl_hook" then
        if e.text:find("Requested format is not available") or 
           e.text:find("youtube-dl failed") or
           e.text:find("Sign in to confirm your age") or
           e.text:find("confirm you’re not a bot") or
           e.text:find("403: Forbidden") then
            
            debug_log("Detected YTDL Error: " .. e.text)
            mp.commandv("script-message", "ytdl_error_detected", e.text)
        end
    elseif e.prefix == "ffmpeg" then
        -- Pattern: https: Will reconnect at 192888 in 1 second(s).
        local offset = e.text:match("Will reconnect at (%d+)")
        if offset then
            total_reconnects = total_reconnects + 1
            if offset == last_reconnect_offset then
                reconnect_counter = reconnect_counter + 1
            else
                reconnect_counter = 1
                last_reconnect_offset = offset
            end

            -- Trigger if we see 3 attempts at the same offset OR 10 total for the file
            if reconnect_counter >= 3 or total_reconnects >= 10 then
                debug_log(string.format("Detected ffmpeg Reconnect Loop (count=%d, total=%d) at offset %s", reconnect_counter, total_reconnects, offset))
                mp.commandv("script-message", "ffmpeg_reconnect_loop_detected", e.text)
                -- Reset so we don't spam if reload fails to fix it immediately
                reconnect_counter = 0
                total_reconnects = 0
            end
        end
    end
end)
