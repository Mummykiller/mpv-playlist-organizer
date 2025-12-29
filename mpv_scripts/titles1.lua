local titles = {}

-- Function to update playlist titles based on stored titles
local function update_playlist_titles()
    local count = mp.get_property_number("playlist-count", 0)
    if not count then return end

    for i = 0, count - 1 do
        local filename = mp.get_property("playlist/" .. i .. "/filename")
        
        if filename and titles[filename] then
            local current_title = mp.get_property("playlist/" .. i .. "/title")
            local new_title = titles[filename]
            
            if current_title ~= new_title then
                mp.set_property("playlist/" .. i .. "/title", new_title)
                mp.msg.info("Set playlist title: " .. new_title)
            end
        end
    end
end

-- Listen for messages from the Python script to register titles for URLs
mp.register_script_message("set_title", function(url, title)
    titles[url] = title
    local path = mp.get_property("path")
    if path == url then
        mp.set_property("force-media-title", title)
    end
    update_playlist_titles()
end)

-- When a file is loaded, check if we have a title for it and apply it
mp.add_hook("on_load", 10, function()
    local path = mp.get_property("path")
    if titles[path] then
        mp.set_property("force-media-title", titles[path])
    end
end)

-- Observe playlist changes to apply titles to new items
local timer = nil
mp.observe_property("playlist", "native", function()
    if timer then timer:kill() end
    timer = mp.add_timeout(0.05, update_playlist_titles)
end)