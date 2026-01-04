local mp = require 'mp'
local utils = require 'mp.utils'

-- Dedicated debug log
local function log(msg)
    mp.msg.info("on_completion_lua: " .. msg)
end

-- Function to get the reliable flag directory
local function get_flag_dir()
    -- 1. Try script-opts passed from Python (highest priority)
    local opt_dir = mp.get_opt("flag_dir")
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
        local home = os.getenv('HOME')
        if home then
            return home .. "/.local/share/MPVPlaylistOrganizer/flags/"
        end
    end
    
    return "/tmp/mpv_playlist_organizer_flags/"
end

local function write_completion_flag(reason)
    local flag_dir = get_flag_dir()
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
        return false
    end
end

local manual_quit = false
mp.register_script_message("manual_quit_initiated", function()
    manual_quit = true
    log("Manual quit initiated from controller. Disabling natural completion flag.")
end)

local function handle_natural_completion(reason)
    if manual_quit then
        log("handle_natural_completion called but manual_quit is true. Aborting.")
        return
    end
    log("Natural completion detected (" .. (reason or "unknown") .. "). Preparing to exit.")
    
    -- Write flag IMMEDIATELY so Python can see it
    write_completion_flag(reason)
    
    -- Set exit code property if supported
    pcall(function() mp.set_property("exit-code", 99) end)
    
    -- Small delay to ensure the flag is on disk before the process dies
    mp.add_timeout(0.5, function()
        mp.command("quit 99")
    end)
end

function on_end_file(event)
    local pos = mp.get_property_number("playlist-pos")
    local count = mp.get_property_number("playlist-count", 0)
    
    log("File ended. Reason: " .. tostring(event.reason) .. ", pos: " .. tostring(pos) .. ", count: " .. tostring(count))

    if event.reason == 'eof' or event.reason == 'idle' then
        -- We use a tiny timeout to check if MPV is ACTUALLY idle or just switching
        mp.add_timeout(0.1, function()
            local is_idle = mp.get_property_bool("idle-active", false)
            if is_idle then
                log("MPV is idle after end-file. Triggering completion handler.")
                handle_natural_completion("Reached end of playlist")
            end
        end)
    end
end

mp.register_event("end-file", on_end_file)
log("Script loaded and listening for end-file events.")