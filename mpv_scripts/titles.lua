local titles = {}

local function update_playlist_titles()
    local count = mp.get_property_number("playlist-count", 0)
    if not count then return end

    for i = 0, count - 1 do
        local filename = mp.get_property("playlist/" .. i .. "/filename")
        if filename and titles[filename] then
            -- Always set, do not compare
            mp.set_property("playlist/" .. i .. "/title", titles[filename])
        end
    end
end

-- Receive title from Python
mp.register_script_message("set_title", function(url, title)
    titles[url] = title
    update_playlist_titles()
end)

-- Apply titles when a file loads
mp.add_hook("on_load", 10, function()
    update_playlist_titles()
end)

-- Apply titles when playlist changes
local timer = nil
mp.observe_property("playlist", "native", function()
    if timer then timer:kill() end
    timer = mp.add_timeout(0.05, update_playlist_titles)
end)