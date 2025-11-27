-- on_completion.lua
-- This script makes MPV exit with a special code (99) when the playlist finishes naturally.
-- It uses the 'end-file' event, which is the most direct way to detect when a file finishes.

local function to_number(v, default)
    if v == nil then return default end
    local n = tonumber(v)
    return (n ~= nil) and n or default
end

local function on_end_file(event)
    -- Only care about natural EOF
    if event.reason ~= "eof" then
        return
    end

    -- Prefer the event's playlist position when provided, fall back to property
    local pos = to_number(event.playlist_pos, nil)
    if pos == nil then
        pos = to_number(mp.get_property("playlist-pos"), -1)
    end

    local count = to_number(mp.get_property("playlist-count"), 0)

    -- Validate values
    if pos < 0 or count <= 0 then
        return
    end

    -- Don't quit if playlist looping is enabled
    local loop = mp.get_property("loop-playlist") or mp.get_property("loop") or "no"
    if loop == "inf" or loop == "always" or loop == "yes" or loop == "1" then
        return
    end

    -- If this was the last item, quit with code 99
    if pos == (count - 1) then
        mp.commandv("quit", "99")
    end
end

-- Register the function to be called whenever a file finishes playing.
mp.register_event("end-file", on_end_file)