local utils = require 'mp.utils'
local url_options = {}
local indexed_options = {}
local playlist_id_options = {}
local url_history = {}
local MAX_ENTRIES = 100

-- Store initial global states
local initial_ytdl_raw = mp.get_property("ytdl-raw-options") or ""
local initial_ytdl_format = mp.get_property("ytdl-format") or ""
local initial_ua = mp.get_property("user-agent") or "libmpv"
local initial_referrer = mp.get_property("referrer") or ""

-- Dedicated debug log
local function debug_log(msg)
    mp.msg.info("AdaptiveHeaders: " .. msg)
end

-- Helper to decode percent-encoded URLs
local function url_decode(str)
    if not str or str == "" then return "" end
    return str:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
end

-- Promotion logic: Map index-based options to sticky MPV playlist IDs
local function promote_indices()
    local playlist = mp.get_property_native("playlist")
    if not playlist then return end
    
    for index, options in pairs(indexed_options) do
        -- MPV native playlist is a 1-indexed table in Lua
        local item = playlist[index + 1]
        if item then
            playlist_id_options[item.id] = options
            indexed_options[index] = nil
        end
    end
end

-- Register options from Python
mp.register_script_message("set_url_options", function(url, options_json, index)
    local ok, options = pcall(utils.parse_json, options_json)
    if ok and options then
        local d_url = url_decode(url)
        if not url_options[url] and not (d_url ~= "" and url_options[d_url]) then
            table.insert(url_history, url)
        end
        url_options[url] = options
        if d_url ~= "" then url_options[d_url] = options end
        
        if index and index ~= "" then
            indexed_options[tonumber(index)] = options
            promote_indices()
        else
            debug_log("Registered options for " .. url)
        end

        if #url_history > MAX_ENTRIES then
            local oldest = table.remove(url_history, 1)
            url_options[oldest] = nil
        end
    end
end)

-- Main logic to apply settings
local function apply_adaptive_settings()
    local path = mp.get_property("path")
    if not path then return end

    local d_path = url_decode(path)
    local playlist_id = mp.get_property_number("playlist-id")
    local pos = mp.get_property_number("playlist-pos")
    
    -- Ensure all pending indices are promoted before lookup
    promote_indices()

    -- 1. CAPTURE PERSISTENT PROPERTIES
    local hot_swap_json = mp.get_property("user-data/hot-swap-options") or ""
    local captured_orig = mp.get_property("user-data/original-url") or ""
    
    -- Clear the hot-swap manifest immediately
    mp.set_property_native("user-data/hot-swap-options", nil)

    -- 2. ABSOLUTE RESET (Global reset for maximum authority)
    mp.set_property("user-agent", initial_ua)
    mp.set_property("referrer", initial_referrer)
    mp.set_property("http-header-fields", "")
    mp.set_property("cookies-file", "")
    mp.set_property("ytdl-raw-options", initial_ytdl_raw)
    mp.set_property("ytdl-format", initial_ytdl_format)
    mp.set_property("demuxer-lavf-o", "")
    
    -- Reset titles so they don't leak from previous files
    mp.set_property("title", "")
    mp.set_property("force-media-title", "")
    
    -- Reset metadata strictly
    mp.set_property_native("user-data/id", nil)
    mp.set_property_native("user-data/original-url", nil)
    mp.set_property("user-data/is-youtube", "no")
    mp.set_property("user-data/marked-as-watched", "no")
    
    -- Preserve sticky info (project-root and cookies-browser) 
    -- unless the new 'opts' specifically overrides them.
    if not (opts and opts.cookies_browser) then
        -- Keep existing or set to empty if nothing exists yet
        local current = mp.get_property("user-data/cookies-browser")
        if not current or current == "" then mp.set_property("user-data/cookies-browser", "") end
    end

    local opts = nil
    local item_id = ""
    local original_url = ""

    -- 3. RESOLVE OPTIONS
    if hot_swap_json ~= "" then
        local ok, hot_opts = pcall(utils.parse_json, hot_swap_json)
        if ok and hot_opts then
            opts = hot_opts
        end
    end

    if not opts then
        opts = (playlist_id and playlist_id_options[playlist_id]) or
               (pos and indexed_options[pos]) or 
               url_options[path] or url_options[d_path] or 
               (captured_orig ~= "" and url_options[captured_orig]) or 
               (captured_orig ~= "" and url_options[url_decode(captured_orig)])
        
        if not opts and path:find("?") then
            local stripped_path = path:gsub("%?.*$", "")
            opts = url_options[stripped_path]
        end
    end

    -- 4. APPLY OPTIONS
    local use_ytdl = "no"
    local is_yt = path:find("youtube%.com") or path:find("youtu%.be")
    
    if opts and opts.original_url then
        if opts.original_url:find("youtube%.com") or opts.original_url:find("youtu%.be") then
            is_yt = true
        end
    end

    if is_yt then 
        use_ytdl = "yes"
        mp.set_property("user-data/is-youtube", "yes")
    end

    if opts then
        debug_log("Applying settings for " .. path)
        
        if opts.id then item_id = opts.id end
        if opts.original_url then original_url = opts.original_url end

        -- Sticky promotion
        if playlist_id and not playlist_id_options[playlist_id] then
            playlist_id_options[playlist_id] = opts
        end

        if opts.title and opts.title ~= "" then
            mp.set_property("title", opts.title)
            mp.set_property("force-media-title", opts.title)
        end

        local h_list = {}
        if opts.headers then
            for k, v in pairs(opts.headers) do
                local kl = k:lower()
                if kl == "user-agent" then mp.set_property("user-agent", v)
                elseif kl == "referer" then mp.set_property("referrer", v) end
                table.insert(h_list, k .. ": " .. v)
            end
        end

        if #h_list > 0 then
            mp.set_property_native("http-header-fields", h_list)
        end

        if opts.use_ytdl_mpv == true then use_ytdl = "yes" end
        if opts.ytdl_format then mp.set_property("ytdl-format", opts.ytdl_format) end
        if opts.ytdl_raw_options then mp.set_property("ytdl-raw-options", opts.ytdl_raw_options) end

        -- Networking overrides
        if not opts.disable_network_overrides then
            local persistence = "1"
            if opts.http_persistence == "off" then persistence = "0"
            elseif opts.http_persistence == "auto" and opts.disable_http_persistent then persistence = "0" end
            local lavf_str = "http_persistent=" .. persistence .. ",reconnect=" .. ((opts.enable_reconnect ~= false) and "1" or "0") .. ",reconnect_at_eof=1,reconnect_streamed=1,reconnect_delay_max=" .. tostring(opts.reconnect_delay or 4)
            mp.set_property("demuxer-lavf-o", lavf_str)
        end

        if opts.cookies_file then mp.set_property("cookies-file", opts.cookies_file) end
        if opts.resume_time and tonumber(opts.resume_time) > 0 then
            mp.set_property("file-local-options/start", opts.resume_time)
        end

        -- Fallback Sync (Properties needed by python.lua)
        if opts.project_root then mp.set_property("user-data/project-root", opts.project_root) end
        if opts.cookies_browser then mp.set_property("user-data/cookies-browser", opts.cookies_browser) end
        if opts.marked_as_watched == true then mp.set_property("user-data/marked-as-watched", "yes") end
    end

    -- Finish by setting ytdl state
    mp.set_property("ytdl", use_ytdl)
    
    -- Restore metadata for current session visibility
    if item_id ~= "" then mp.set_property_native("user-data/id", item_id) end
    if original_url ~= "" then mp.set_property_native("user-data/original-url", original_url) end
end

-- Hook at priority 10
mp.add_hook("on_load", 10, apply_adaptive_settings)

-- Error reporting
mp.register_event("end-file", function(event)
    if event.reason == 'error' then
        local ytdl_err = mp.get_property("ytdl-error")
        if ytdl_err and ytdl_err ~= "" then
            mp.commandv("script-message", "ytdl_error_detected", ytdl_err)
        end
    end
end)
