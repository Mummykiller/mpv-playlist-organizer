local utils = require 'mp.utils'
local url_options = {}
local id_options = {}
local indexed_options = {}
local primed_resume_time = nil

-- Store initial global states
local initial_ua = mp.get_property("user-agent") or "libmpv"
local initial_referrer = mp.get_property("referrer") or ""
local initial_ytdl_raw = mp.get_property("ytdl-raw-options") or ""
local initial_ytdl_format = mp.get_property("ytdl-format") or ""
local initial_max_bytes = mp.get_property("demuxer-max-bytes")
local initial_max_back_bytes = mp.get_property("demuxer-max-back-bytes")
local initial_cache_secs = mp.get_property("cache-secs")
local initial_readahead = mp.get_property("demuxer-readahead-secs")
local initial_stream_buffer = mp.get_property("stream-buffer-size")
local initial_lavf_opts = mp.get_property("demuxer-lavf-o") or ""

local function debug_log(msg)
    mp.msg.info("AdaptiveHeaders: " .. msg)
end

local function url_decode(str)
    if not str or str == "" then return "" end
    return str:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
end

-- Register options from Python
mp.register_script_message("set_url_options", function(url, options_json, index)
    local ok, options = pcall(utils.parse_json, options_json)
    if ok and options then
        url_options[url] = options
        local d_url = url_decode(url)
        if d_url ~= "" then url_options[d_url] = options end
        if options.id then id_options[options.id] = options end
        if index and index ~= "" then indexed_options[tonumber(index)] = options end
    end
end)

mp.register_script_message("primed_resume_time", function(time)
    primed_resume_time = tonumber(time)
    debug_log("Primed resume time received: " .. tostring(primed_resume_time))
end)

local function apply_adaptive_settings()
    local path = mp.get_property("path")
    if not path or path == "" then return end

    -- 1. Extract Solid ID
    local solid_id = path:match("[#&]mpv_organizer_id=([^#&]+)")
    if solid_id then mp.set_property_native("user-data/id", solid_id) end

    -- 2. Hot-Swap / Race Condition Recovery
    local hs_json = mp.get_property("user-data/hot-swap-options")
    local is_first_load = (hs_json and hs_json ~= "")
    if is_first_load then
        local ok, hs_opts = pcall(utils.parse_json, hs_json)
        if ok and hs_opts then
            if hs_opts.id then id_options[hs_opts.id] = hs_opts end
            url_options[path] = hs_opts
        else
            mp.msg.error("AdaptiveHeaders: Failed to parse hot-swap-options: " .. tostring(hs_opts))
        end
        mp.set_property_native("user-data/hot-swap-options", nil)
    end

    -- 3. Clean up previous state (Full Reset to Initial Defaults)
    mp.set_property("user-agent", initial_ua)
    mp.set_property("referrer", initial_referrer)
    mp.set_property("http-header-fields", "")
    mp.set_property("cookies-file", "")
    
    -- Only reset ytdl settings if this is NOT the initial hot-swap load.
    -- This prevents race conditions where the initial launch flags are cleared too early.
    if not is_first_load then
        mp.set_property("ytdl-raw-options", initial_ytdl_raw)
        mp.set_property("ytdl-format", initial_ytdl_format)
    end

    mp.set_property("demuxer-lavf-o", initial_lavf_opts)
    
    -- Reset metadata strictly
    mp.set_property_native("user-data/original-url", nil)
    mp.set_property("user-data/is-youtube", "no")
    mp.set_property("user-data/marked-as-watched", "no")

    -- Reset Buffering to Launch Defaults
    mp.set_property("demuxer-max-bytes", initial_max_bytes)
    mp.set_property("demuxer-max-back-bytes", initial_max_back_bytes)
    mp.set_property("cache-secs", initial_cache_secs)
    mp.set_property("demuxer-readahead-secs", initial_readahead)
    mp.set_property("stream-buffer-size", initial_stream_buffer)
    mp.set_property("cache", "auto")

    -- 4. Resolve Options
    local item_id = mp.get_property("user-data/id")
    local pos = mp.get_property_number("playlist-pos")
    local stripped_path = path:gsub("[#&]mpv_organizer_id=[^#&]+", "")
    
    local opts = (item_id and id_options[item_id]) or 
                 (pos and indexed_options[pos]) or 
                 url_options[stripped_path] or url_options[path]

    if not opts then
        debug_log("No options found for path: " .. path .. " (ID: " .. tostring(item_id) .. ", Pos: " .. tostring(pos) .. ")")
    else
        debug_log("Resolved options for " .. (opts.title or path))
    end

    -- 4b. Explicit YouTube Check (Always useful)
    local is_yt = path:find("youtube%.com") or path:find("youtu%.be")
    if is_yt then
        debug_log("YouTube detected, enforcing ytdl=yes")
        mp.set_property("ytdl", "yes")
        mp.set_property("user-data/is-youtube", "yes")
    end

    if not opts and not primed_resume_time then return end

    -- 5. Always apply UI/State features (Titles & Resume)
    if opts and opts.title and opts.title ~= "" then
        mp.set_property("title", opts.title)
        mp.set_property("force-media-title", opts.title)
    end

    -- Priority: 1. Primed time from Python message, 2. Item-specific resume_time
    local effective_resume = primed_resume_time or (opts and tonumber(opts.resume_time))
    if effective_resume and effective_resume > 0 then
        mp.set_property_number("file-local-options/start", effective_resume)
        mp.set_property("file-local-options/resume-playback", "no")
        debug_log("Applied resume time: " .. tostring(effective_resume))
        primed_resume_time = nil -- Consume it
    end

    if not opts then return end

    -- 6. ALWAYS apply Authentication Headers (Essential for connection)
    if opts.headers then
        local h_list = {}
        for k, v in pairs(opts.headers) do
            local kl = k:lower()
            if kl == "user-agent" then mp.set_property("user-agent", v)
            elseif kl == "referer" then mp.set_property("referrer", v)
            else table.insert(h_list, k .. ": " .. v) end
        end
        if #h_list > 0 then mp.set_property_native("http-header-fields", h_list) end
    end

    -- 7. TARGETED BYPASS CHECK
    local targeted = opts.targeted_defaults or "none"
    local is_yt = path:find("youtube%.com") or path:find("youtu%.be")
    local bypass_active = false

    if targeted == 'animepahe' and (path:find("kwik%.cx") or path:find("owocdn%.top") or path:find("uwucdn%.top")) then
        bypass_active = true
    elseif targeted == 'all-none-yt' and not is_yt then
        bypass_active = true
    end

    if bypass_active then
        debug_log("True Native Bypass active. Using native MPV networking for speed.")
        -- Apply Reconnect and Persistence for stability
        local persistence = "1"
        if opts.http_persistence == "off" then persistence = "0"
        elseif opts.http_persistence == "auto" and opts.disable_http_persistent then persistence = "0" end
        local reconnect_val = (opts.enable_reconnect ~= false) and "1" or "0"
        local r_delay = tonumber(opts.reconnect_delay) or 4
        
        -- Use robust reconnect flags (excluding at_eof to avoid VOD loops)
        local lp = string.format("http_persistent=%s,reconnect=%s,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=%d", persistence, reconnect_val, r_delay)
        mp.set_property("demuxer-lavf-o", lp)
    else
        -- 8. Apply "Turbo" Networking Overrides (Only if NOT bypassed)
        local ytdl_opts = opts.ytdl_raw_options or initial_ytdl_raw
        
        -- If browser cookies are requested, append them to raw options
        if opts.cookies_browser and opts.cookies_browser ~= "" and opts.cookies_browser ~= "None" then
            local browser_flag = "cookies-from-browser=" .. opts.cookies_browser
            if ytdl_opts == "" then
                ytdl_opts = browser_flag
            elseif not ytdl_opts:find("cookies%-from%-browser") then
                ytdl_opts = ytdl_opts .. "," .. browser_flag
            end
        end

        if opts.cookies_file and opts.cookies_file ~= "" then 
            mp.set_property("cookies-file", opts.cookies_file) 
        end
        
        if ytdl_opts ~= "" then
            mp.set_property("ytdl-raw-options", ytdl_opts)
        end

        if opts.ytdl_format then mp.set_property("ytdl-format", opts.ytdl_format) end

        -- Apply Buffering & Cache
        if opts.enable_cache == false then
            mp.set_property("cache", "no")
            debug_log("Buffering disabled by user setting.")
        else
            if opts.demuxer_max_bytes then mp.set_property("demuxer-max-bytes", opts.demuxer_max_bytes) end
            if opts.demuxer_max_back_bytes then mp.set_property("demuxer-max-back-bytes", opts.demuxer_max_back_bytes) end
            if opts.cache_secs then mp.set_property("cache-secs", tostring(opts.cache_secs)) end
            if opts.demuxer_readahead_secs then mp.set_property("demuxer-readahead-secs", tostring(opts.demuxer_readahead_secs)) end
            if opts.stream_buffer_size then mp.set_property("stream-buffer-size", opts.stream_buffer_size) end
        end

        if not opts.disable_network_overrides then
            local persistence = "1"
            if opts.http_persistence == "off" then persistence = "0"
            elseif opts.http_persistence == "auto" and opts.disable_http_persistent then persistence = "0" end
            local reconnect_val = (opts.enable_reconnect ~= false) and "1" or "0"
            local r_delay = tonumber(opts.reconnect_delay) or 4
            local lp = string.format("http_persistent=%s,reconnect=%s,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=%d", persistence, reconnect_val, r_delay)
            mp.set_property("demuxer-lavf-o", lp)
        end
    end

    -- 9. Misc context
    if opts.project_root then mp.set_property("user-data/project-root", opts.project_root) end
    if opts.cookies_browser then mp.set_property("user-data/cookies-browser", opts.cookies_browser) end
    if opts.original_url then mp.set_property_native("user-data/original-url", opts.original_url) end
end

mp.add_hook("on_load", 0, function()
    local ok, err = pcall(apply_adaptive_settings)
    if not ok then
        mp.msg.error("AdaptiveHeaders: Error in on_load hook: " .. tostring(err))
    end
end)
