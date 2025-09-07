-- on_completion.lua
-- This script makes MPV exit with a special code (99) when the playlist finishes naturally.

local function on_end_file(event)
    -- Check if the file ended because it reached the end (EOF).
    -- We ignore other reasons like 'quit' (user closed window) or 'stop'.
    if event.reason ~= "eof" then
        return
    end

    local pos = mp.get_property_number("playlist-pos")
    local count = mp.get_property_number("playlist-count")

    -- Check if the file that just ended was the last one.
    -- `pos` will be the index of the file that just finished.
    -- So we check if it's the last index (count - 1).
    if pos == (count - 1) then
        -- The playlist has finished naturally. Quit with a special exit code.
        mp.commandv("quit", 99)
    end
end

-- Register the function to be called when a file finishes playing.
mp.register_event("end-file", on_end_file)