local mp = require 'mp'
local utils = require 'mp.utils'

-- Dedicated debug log
local function log(msg)
    mp.msg.info("on_completion_lua: " .. msg)
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
        log("Loading handshake from: " .. handshake_path)
        local content = safe_read_file(handshake_path)
        if content then
            local ok, data = pcall(utils.parse_json, content)
            if ok and data then
                log("Handshake successful. Root: " .. (data.project_root or "unknown"))
                return data
            end
        end
    end
    return nil
end

local handshake_data = load_handshake()

-- Function to get the reliable flag directory
local function get_flag_dir()
    -- 1. Try handshake data first (highest priority)
    if handshake_data and handshake_data.flag_dir and handshake_data.flag_dir ~= "" then
        local opt_dir = handshake_data.flag_dir
        if not opt_dir:match("[/\\]$") then
            opt_dir = opt_dir .. "/"
        end
        return opt_dir
    end

    -- 2. Try script-opts passed from Python (legacy priority)
    local script_name = mp.get_script_name()
    local opt_dir = mp.get_opt("flag_dir") or mp.get_opt(script_name .. "-flag_dir")
    
    if opt_dir and opt_dir ~= "" then
        -- Ensure trailing slash
        if not opt_dir:match("[/\\]$") then
            opt_dir = opt_dir .. "/"
        end
        return opt_dir
    end

    -- 2. Fallback to platform-specific guesses
    local is_windows = package.config:sub(1,1) == "\\"
    if is_windows then
        local appdata = os.getenv('APPDATA')
        if appdata then
            return appdata .. "\\MPVPlaylistOrganizer\\flags\\"
        end
    else
        -- Check XDG_DATA_HOME first, then fallback to HOME
        local data_home = os.getenv('XDG_DATA_HOME')
        if data_home and data_home ~= "" then
            return data_home .. "/MPVPlaylistOrganizer/flags/"
        end
        
        local home = os.getenv('HOME')
        if home then
            return home .. "/.local/share/MPVPlaylistOrganizer/flags/"
        end
    end
    
    return "/tmp/mpv_playlist_organizer_flags/"
end

-- Read clear_on_item_finish preference
local function get_clear_on_item_finish()
    local script_name = mp.get_script_name()
    local opt = mp.get_opt("clear_on_item_finish") or mp.get_opt(script_name .. "-clear_on_item_finish")
    return opt == "yes"
end

local clear_on_item_finish = get_clear_on_item_finish()
log("Option clear_on_item_finish: " .. (clear_on_item_finish and "yes" or "no"))

-- Ensure the directory exists before writing
local function ensure_dir(path)
    -- Remove trailing slash for directory check/creation
    local dir = path:gsub("[/\\]$", "")
    local is_windows = package.config:sub(1,1) == "\\"
    
    if is_windows then
        os.execute('mkdir "' .. dir .. '" >nul 2>nul')
    else
        os.execute('mkdir -p "' .. dir .. '" >/dev/null 2>&1')
    end
end

local function write_completion_flag(reason)
    local flag_dir = get_flag_dir()
    ensure_dir(flag_dir)
    
    local pid = utils.getpid()
    local flag_file_path = flag_dir .. 'mpv_natural_completion_' .. pid .. '.flag'
    
    log("Attempting to write flag to: " .. flag_file_path)
    
    local file, err = io.open(flag_file_path, "w")
    if file then
        file:write(reason or "completed")
        file:close()
        log("Successfully wrote completion flag with reason: " .. (reason or "none"))
        return true
    else
        log("Failed to write flag: " .. (err or "unknown error"))
        -- Try a desperate fallback to /tmp if the main path failed
        local fallback_path = "/tmp/mpv_natural_completion_" .. pid .. ".flag"
        log("Trying fallback path: " .. fallback_path)
        local f2, e2 = io.open(fallback_path, "w")
        if f2 then
            f2:write(reason or "completed_fallback")
            f2:close()
            return true
        end
        return false
    end
end

local manual_quit = false
mp.register_script_message("manual_quit_initiated", function()
    manual_quit = true
    log("Manual quit initiated from controller. Disabling natural completion flag.")
end)

local completion_triggered = false
local has_started = false
local last_error = false
local max_playback_time = 0
local playing_pos = nil
local playing_id = nil

-- Track max playback time to prevent reset race conditions at EOF
mp.observe_property("playback-time", "number", function(_, val)
    if val and val > max_playback_time then
        max_playback_time = val
    end
end)

-- Monitor start-file to ensure we don't trigger completion before anything even played
mp.register_event("start-file", function()
    completion_triggered = false
    last_error = false
    max_playback_time = 0
    playing_pos = mp.get_property_number("playlist-pos")
    playing_id = mp.get_property("user-data/id")
    
    log(string.format("File started (pos=%s, id=%s). Resetting error state.", 
        tostring(playing_pos), tostring(playing_id)))
        
    if not has_started then
        log("First file started. Watch history tracking active.")
        has_started = true
    end
end)

local function handle_natural_completion(reason)
    if not has_started then
        log("handle_natural_completion called but has_started is false. Ignoring.")
        return
    end

    -- Protection: Ensure we've actually played for a bit (Threshold: 5s)
    if max_playback_time < 5 then
        log("handle_natural_completion ignored: playback time too short (" .. tostring(max_playback_time) .. "s). Likely a load failure or skip.")
        return
    end

    if manual_quit then
        log("handle_natural_completion called but manual_quit is true. Aborting.")
        return
    end

    if last_error then
        log("handle_natural_completion called but last_error is true. Aborting.")
        return
    end
    
    if completion_triggered then
        return
    end
    
    completion_triggered = true
    log("Natural completion detected (" .. (reason or "unknown") .. "). Preparing to exit.")
    
    -- Write flag IMMEDIATELY so Python can see it
    write_completion_flag(reason)
    
    -- Delay to ensure the flag is flushed to disk before the process dies (User requested 0.5s)
    mp.add_timeout(0.5, function()
        log("Exiting with code 99.")
        mp.command("quit 99")
    end)
end

function on_end_file(event)
    -- Use playlist-pos-1 as a fallback for the item that just finished if pos is gone
    local pos = mp.get_property_number("playlist-pos")
    local count = mp.get_property_number("playlist-count", 0)
    
    log(string.format("File ended. Reason: %s, pos: %s, count: %d (playing_pos: %s)", tostring(event.reason), tostring(pos), count, tostring(playing_pos)))

    if event.reason == 'error' then
        last_error = true
        log("File ended with error. Natural completion disabled for this file.")
        return
    end

    -- Case 1: The file finished naturally
    if event.reason == 'eof' then
        -- Always notify Python that THIS item finished if it was natural
        -- We use the ID and POS captured at start-file to avoid the race condition
        -- where MPV has already advanced to the next item.
        if playing_id and playing_id ~= "" then
            log("Item finished (EOF). Notifying Python for ID: " .. playing_id)
            mp.commandv("script-message", "item_natural_completion_by_id", playing_id)
        elseif playing_pos then
            log("Item finished (EOF). Notifying Python for captured pos: " .. tostring(playing_pos))
            mp.commandv("script-message", "item_natural_completion", tostring(playing_pos))
        else
            -- Ultimate fallback if start-file somehow missed it
            local effective_pos = pos
            if not effective_pos or effective_pos < 0 or effective_pos >= count then
                 effective_pos = count - 1
            end
            if effective_pos >= 0 then
                log("Item finished (EOF). Notifying Python for fallback pos: " .. tostring(effective_pos))
                mp.commandv("script-message", "item_natural_completion", tostring(effective_pos))
            end
        end

        -- If we just finished the last item in the playlist
        -- We trigger completion ONLY if pos is nil (nothing next) 
        -- and we are not looping the playlist.
        local loop_playlist = mp.get_property("loop-playlist")
        if (not pos or pos < 0) and loop_playlist == "no" then
            handle_natural_completion("Reached end of playlist (EOF on last item)")
        end
    
    -- Case 2: The player went idle (usually happens after EOF with --idle=yes)
    elseif event.reason == 'idle' then
        handle_natural_completion("MPV entered idle state")
    end
end

-- Also observe idle-active as a fallback
mp.observe_property("idle-active", "bool", function(name, val)
    if val == true and has_started then
        log("Property change: idle-active is true. Checking for completion.")
        -- Use a tiny delay to allow other properties (like playlist-pos) to settle
        mp.add_timeout(0.1, function()
            if last_error then
                log("Idle active but last_error is true. Skipping completion.")
                return
            end
            
            local pos = mp.get_property_number("playlist-pos")
            local count = mp.get_property_number("playlist-count", 0)
            
            -- Trigger completion if we are idle and either:
            -- 1. We have no active position (finished or empty)
            -- 2. The playlist is empty
            if not pos or pos < 0 or count == 0 then
                handle_natural_completion("Idle property triggered completion (pos=" .. tostring(pos) .. ", count=" .. count .. ")")
            end
        end)
    end
end)

mp.register_event("end-file", on_end_file)
log("Script loaded (" .. mp.get_script_name() .. "). Listening for completion events.")