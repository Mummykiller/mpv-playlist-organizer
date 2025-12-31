local mp = require 'mp'
local utils = require 'mp.utils'

-- Dedicated debug log
local function log(msg)
    mp.msg.info("on_completion_lua: " .. msg)
end

-- Function to get the IPC directory path
local function get_ipc_dir()
    local ipc_path = mp.get_property('input-ipc-server')
    if ipc_path and ipc_path ~= "" then
        -- On Linux, this is something like /home/user/.mpv_playlist_organizer_ipc/mpv-socket-PID
        -- We need the directory part.
        local dir = ipc_path:match("(.*/)")
        if dir then
            return dir
        end
    end

    -- Fallback to known location
    local home = os.getenv('HOME')
    if home then
        return home .. '/.mpv_playlist_organizer_ipc/'
    end
    return '/tmp/'
end

local function write_completion_flag()
    local ipc_dir = get_ipc_dir()
    -- Ensure trailing slash
    if ipc_dir:sub(-1) ~= "/" then ipc_dir = ipc_dir .. "/" end
    
    local flag_file_path = ipc_dir .. 'mpv_natural_completion.flag'
    
    log("Attempting to write flag to: " .. flag_file_path)
    
    local file, err = io.open(flag_file_path, "w")
    if file then
        file:write("completed")
        file:close()
        log("Successfully wrote completion flag.")
        return true
    else
        log("Failed to write flag: " .. (err or "unknown error"))
        return false
    end
end

local function handle_natural_completion()
    log("Natural completion detected. Preparing to exit with code 99.")
    write_completion_flag()
    
    -- Set exit code property if supported
    pcall(function() mp.set_property("exit-code", 99) end)
    
    -- Small delay to ensure the flag is on disk before the process dies
    mp.add_timeout(0.2, function()
        mp.command("quit 99")
    end)
end

function on_end_file(event)
    local pos = mp.get_property_number("playlist-pos")
    local count = mp.get_property_number("playlist-count", 0)
    
    log("File ended. Reason: " .. tostring(event.reason) .. ", pos: " .. tostring(pos) .. ", count: " .. tostring(count))

    if event.reason == 'eof' or event.reason == 'idle' then
        -- Completion cases:
        -- 1. pos is nil or -1 (playlist ended and MPV is moving to idle)
        -- 2. pos is the last index
        -- 3. playlist is empty
        local is_last = (not pos) or (pos < 0) or (count > 0 and pos == count - 1)
        
        if is_last then
            handle_natural_completion()
        end
    end
end

mp.register_event("end-file", on_end_file)
log("Script loaded and listening for end-file events.")