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

-- Central Sync Trigger (Dumb Trigger, Smart Python)
local function run_fallback_sync(params)
    -- Check if Python manager is active (within last 12 seconds)
    local time_since_hb = mp.get_time() - last_heartbeat
    
    -- Shutdown Shield: Always allow if forced (used for shutdown/emergency)
    if not params.force and time_since_hb < 12 then return end

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
        run_fallback_sync({mark_watched = true, time = 0, force = true}) -- Reset time on completion
    elseif event.reason == "stop" or event.reason == "quit" then
        run_fallback_sync({time = time, force = true})
    end
end)

debug_log("Python interaction script loaded.")
