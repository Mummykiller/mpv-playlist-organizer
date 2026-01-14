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
    -- Remove all literal double and single quotes from anywhere in the string
    s = s:gsub('"', ''):gsub("'", "")
    -- Trim whitespace
    s = s:gsub("^%s*(.-)%s*$", "%1")
    -- Handle common "empty" indicators
    if s == "" or s:lower() == "null" or s:lower() == "nil" or s:lower() == "undefined" then 
        return nil 
    end
    return s
end

-- Heartbeat from Python tracker
mp.register_script_message("tracker_heartbeat", function()
    last_heartbeat = mp.get_time()
end)

-- Handle logs from Python
mp.register_script_message("python_log", function(msg)
    mp.msg.info(msg)
end)

-- Mark as Watched Fallback
local function trigger_fallback_mark_watched(reason)
    if fallback_attempted then return end

    -- 1. Check if already marked
    local marked = clean_value(mp.get_property("user-data/marked-as-watched"))
    if marked == "yes" then 
        fallback_attempted = true 
        return 
    end

    -- 2. Check if this is a YouTube video
    local is_yt = clean_value(mp.get_property("user-data/is-youtube"))
    local url = clean_value(mp.get_property("user-data/original-url")) or clean_value(mp.get_property("path"))
    
    if not is_yt and url then
        if url:find("youtube.com") or url:find("youtu.be") then
            is_yt = "yes"
        end
    end

    if is_yt ~= "yes" and is_yt ~= "true" and is_yt ~= "1" then
        if not fallback_skip_notified then
            debug_log("Fallback: Not a YouTube video (is-yt=" .. tostring(is_yt) .. "), skipping.")
            fallback_skip_notified = true
        end
        return
    end

    -- 3. Check if Python is active
    local time_since_heartbeat = mp.get_time() - last_heartbeat
    if time_since_heartbeat < 12 then
        return
    end

    local cookies = clean_value(mp.get_property("cookies-file"))
    local browser = clean_value(mp.get_property("user-data/cookies-browser"))
    local ua = clean_value(mp.get_property("user-agent"))
    local project_root = clean_value(mp.get_property("user-data/project-root"))

    -- Emergency Root Detection: If Python didn't send it, guess it from our script path
    if not project_root then
        local script_dir = mp.get_script_directory()
        if script_dir then
            -- Use double brackets [[ ]] to avoid escape sequence issues
            project_root = script_dir:gsub([[([/\\\])mpv_scripts$]], "")
            project_root = project_root:gsub([[([/\\\])mpv_scripts[/\\]$]], "")
            debug_log("Guessed project root: " .. project_root)
        end
    end

    -- We need a URL, a Project Root, and EITHER a cookie file OR a browser name
    local has_cookies = cookies or browser

    if not url or not project_root or not has_cookies then
        debug_log(string.format("Fallback CANNOT start: Missing info. URL=%s, Root=%s, HasCookies=%s", 
            tostring(url), tostring(project_root), tostring(has_cookies ~= nil)))
        fallback_attempted = true 
        return
    end

    local cookies_arg = cookies or browser
    if not cookies then
        debug_log("Using browser name for fallback: " .. tostring(browser))
    end

    fallback_attempted = true 
    debug_log("Triggering Lua fallback for Mark-as-Watched (Reason: " .. (reason or "threshold") .. ") for: " .. url)
    mp.osd_message("YouTube: Marking as watched (Lua Fallback)...", 3)

    local script_path = utils.join_path(project_root, "utils/youtube_history.py")
    
    local python_bin = "python3"
    -- Correctly check for Windows backslash using double brackets
    if package.config:sub(1,1) == [[\]] then python_bin = "python" end

    local cmd = {
        name = "subprocess",
        args = {python_bin, script_path, url, cookies_arg, ua},
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true
    }
    
    debug_log("Executing: " .. table.concat(cmd.args, " "))

    mp.command_native_async(cmd, function(success, result, error) 
        if success and result.status == 0 then
            debug_log("Fallback mark-watched successful.")
            mp.set_property_native("user-data/marked-as-watched", "yes")
            mp.osd_message("YouTube: Marked as watched", 2)
        else
            local err_msg = (result and result.stderr) or error or "Unknown error"
            debug_log("Fallback mark-watched failed: " .. err_msg)
            if result and result.stdout then debug_log("STDOUT: " .. result.stdout) end
            mp.osd_message("YouTube: Mark watched failed (Lua Fallback)", 3)
        end
    end)
end

-- Reset on new file
mp.register_event("start-file", function()
    session_duration = 0
    last_time_pos = nil
    playback_active = true
    fallback_attempted = false
    fallback_skip_notified = false
end)

-- Track playback time for fallback
mp.observe_property("time-pos", "number", function(name, val)
    if not val or not playback_active then return end
    if last_time_pos then
        local delta = val - last_time_pos
        if delta > 0 and delta < 2 then
            session_duration = session_duration + delta
            if math.floor(session_duration) % 10 == 0 and math.floor(session_duration) ~= math.floor(session_duration - delta) then
                debug_log(string.format("Fallback Progress: %.1fs/30s", session_duration))
            end
            if session_duration >= 30 then
                trigger_fallback_mark_watched("threshold (30s)")
            end
        end
    end
    last_time_pos = val
end)

-- EOF trigger
mp.register_event("end-file", function(event) 
    playback_active = false
    if event.reason == 'eof' then
        trigger_fallback_mark_watched("EOF")
    end
end)

debug_log("Python interaction script loaded.")