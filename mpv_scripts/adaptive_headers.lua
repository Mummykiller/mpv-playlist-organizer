local utils = require 'mp.utils'
local url_options = {}
local id_options = {}
local indexed_options = {}
local session_timestamps = {} -- Internal memory for the current session
local unmanaged_fallback_opts = nil -- Global fallback for disconnected launches
local has_started = false
local handshake_processed = false -- Flag to ensure handshake is only processed once

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

local function set_property_if_diff(name, val)
    local current = mp.get_property(name)
    if tostring(current) ~= tostring(val) then
        mp.set_property(name, val)
    end
end

local function url_decode(str)
    if not str or str == "" then return "" end
    return str:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
end

local function save_current_position()
    local path = mp.get_property("path")
    if not path or path == "" then return end
    
    local time = mp.get_property_number("time-pos")
    if time and time > 5 then -- Only save if we are at least 5s in
        local id = mp.get_property("user-data/id")
        if id and id ~= "" then
            session_timestamps[id] = time
        end
        session_timestamps[path] = time
        debug_log("Saved position: " .. tostring(time) .. " for " .. path)
    end
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

local function safe_read_file(path)
    if utils.read_file then
        return utils.read_file(path)
    end
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*all")
    f:close()
    return content
end

local function apply_adaptive_settings()
    local path = mp.get_property("path")
    if not path or path == "" then return end

    -- 0. Metadata Handshake (Primary initialization source)
    if not handshake_processed then
        local handshake_path = mp.get_opt("mpv_organizer-handshake")
        if handshake_path and handshake_path ~= "" then
            local content = safe_read_file(handshake_path)
            if content and content ~= "" then
                local ok, data = pcall(utils.parse_json, content)
                if ok and data then
                    local opts = data.lua_options
                    if opts then
                        if opts.id then id_options[opts.id] = opts end
                        url_options[path] = opts
                        unmanaged_fallback_opts = opts -- Set global fallback
                        
                        -- NEW: Extract resume time from handshake to override MPV memory immediately
                        if opts.resume_time then
                            primed_resume_time = tonumber(opts.resume_time)
                            debug_log("Handshake resume time found: " .. tostring(primed_resume_time))
                        end

                        debug_log("Handshake successful. Project root: " .. (data.project_root or "unknown"))
                        
                        -- Populate unmanaged context if needed
                        if data.project_root then mp.set_property("user-data/project-root", data.project_root) end
                        if data.folder_id then mp.set_property("user-data/folder-id", data.folder_id) end
                        if data.original_url then mp.set_property_native("user-data/original-url", data.original_url) end
                        if data.cookies_browser then mp.set_property("user-data/cookies-browser", data.cookies_browser) end
                        if data.is_unmanaged ~= nil then mp.set_property("user-data/is-unmanaged", data.is_unmanaged and "yes" or "no") end
                        
                        -- Clear the handshake option so we don't re-process it for subsequent files
                        mp.set_property("opt-mpv_organizer-handshake", "")
                    end
                end
            end
        end
        handshake_processed = true
    end

    -- 1. Extract Solid ID
    local solid_id = path:match("[#&]mpv_organizer_id=([^#&]+)")
    if solid_id then mp.set_property_native("user-data/id", solid_id) end

    -- 2. Hot-Swap / Race Condition Recovery
    local hs_json = mp.get_property("user-data/hot-swap-options")
    local is_hot_swap = (hs_json and hs_json ~= "" and hs_json ~= "nil" and hs_json ~= "null" and hs_json ~= "undefined")
    
    if is_hot_swap then
        local ok, hs_opts = pcall(utils.parse_json, hs_json)
        if ok and hs_opts then
            if hs_opts.id then id_options[hs_opts.id] = hs_opts end
            url_options[path] = hs_opts
        else
            mp.msg.error("AdaptiveHeaders: Failed to parse hot-swap-options. Raw value: '" .. tostring(hs_json) .. "'. Error: " .. tostring(hs_opts))
        end
        mp.set_property("user-data/hot-swap-options", "")
    end

    -- 3. Clean up previous state (Full Reset to Initial Defaults)
    -- ONLY reset if this is NOT the very first load of the process, 
    -- or if we are performing a hot-swap (item change).
    -- This prevents wiping out command-line cookies/headers on startup.
    if has_started or is_hot_swap then
        set_property_if_diff("user-agent", initial_ua)
        set_property_if_diff("referrer", initial_referrer)
        set_property_if_diff("http-header-fields", "")
        set_property_if_diff("cookies-file", "")
        set_property_if_diff("ytdl-raw-options", initial_ytdl_raw)
        set_property_if_diff("ytdl-format", initial_ytdl_format)
        set_property_if_diff("demuxer-lavf-o", initial_lavf_opts)
        
        -- Reset metadata strictly
        mp.set_property_native("user-data/original-url", nil)
        set_property_if_diff("user-data/is-youtube", "no")
        set_property_if_diff("user-data/marked-as-watched", "no")

        -- Reset Buffering to Launch Defaults
        set_property_if_diff("demuxer-max-bytes", initial_max_bytes)
        set_property_if_diff("demuxer-max-back-bytes", initial_max_back_bytes)
        set_property_if_diff("cache-secs", tostring(initial_cache_secs))
        set_property_if_diff("demuxer-readahead-secs", tostring(initial_readahead))
        set_property_if_diff("stream-buffer-size", initial_stream_buffer)
        set_property_if_diff("cache", "auto")
    end

    has_started = true

    -- 4. Resolve Options
    local item_id = mp.get_property("user-data/id")
    local pos = mp.get_property_number("playlist-pos")
    local stripped_path = path:gsub("[#&]mpv_organizer_id=[^#&]+", "")
    
    -- Strictly use ID or URL. Fallback to unmanaged_fallback_opts for unmanaged instances.
    local opts = (item_id and id_options[item_id]) or 
                 url_options[stripped_path] or 
                 url_options[path] or 
                 unmanaged_fallback_opts

    if not opts then
        debug_log("No options found for path: " .. path .. " (ID: " .. tostring(item_id) .. ")")
    else
        debug_log("Resolved options for " .. (opts.title or path))
    end

    -- --- NEW: ITEM-SPECIFIC RESUME LOGIC ---
    local final_resume_time = nil

    -- Priority 1: Synchronous Primed Resume Time (from Python IPC)
    -- This property is set by the backend just before 'loadfile'
    local sync_primed = mp.get_property("user-data/primed-resume-time")
    if sync_primed and sync_primed ~= "" then
        -- Strip literal double quotes if they exist
        sync_primed = sync_primed:gsub('^"', ''):gsub('"$', '')
        final_resume_time = tonumber(sync_primed)
        
        -- Consume it immediately so it doesn't leak to next file
        mp.set_property("user-data/primed-resume-time", "")
        if final_resume_time then
            debug_log("Sync primed resume time found: " .. tostring(final_resume_time))
        end
    end

    -- Priority 2: Session Memory (If we've played this EXACT file earlier in this instance)
    if final_resume_time == nil then
        local session_time = (item_id and session_timestamps[item_id]) or session_timestamps[path]
        if session_time then
            final_resume_time = session_time
            debug_log("Session memory found: resuming at " .. tostring(session_time))
        end
    end
    
    -- Priority 3: Global Handshake Resume Time (One-time use)
    if final_resume_time == nil and primed_resume_time then
        final_resume_time = primed_resume_time
        primed_resume_time = nil -- Consume it immediately
        debug_log("Handshake resume time applied and cleared: " .. tostring(final_resume_time))
    end

    -- Priority 4: Metadata Registry (From 'set_url_options' batch sync)
    if final_resume_time == nil and opts and opts.resume_time then
        final_resume_time = tonumber(opts.resume_time)
        if final_resume_time then
            debug_log("Metadata resume time found: " .. tostring(final_resume_time))
        end
    end

    -- Priority 4: Handshake/Default
    -- If we still have nothing, force 0 to override MPV's internal memory
    if final_resume_time == nil then
        final_resume_time = 0
    end

    -- 5. Apply UI/State features (Titles & Resume)
    if opts and opts.title and opts.title ~= "" then
        set_property_if_diff("title", opts.title)
        set_property_if_diff("force-media-title", opts.title)
    end

    -- Priority: ONLY use final_resume_time. 
    -- We check if final_resume_time is NOT nil, allowing 0 to be a valid forced start.
    if final_resume_time ~= nil then
        -- CRITICAL: Force MPV to ignore its own watch-later files for this specific load
        mp.set_property("file-local-options/resume-playback", "no")
        -- Use the global 'start' property because 'file-local-options/start' is unreliable during on_load
        mp.set_property("start", final_resume_time)
        debug_log("Applied final resume time: " .. tostring(final_resume_time))
    else
        -- CRITICAL: Reset start time to 'none' (default) so we don't leak the previous file's start time
        -- Since 'start' is a global option, it persists across files if not reset.
        mp.set_property("start", "none")
    end

    if not opts then return end

    -- 6. ALWAYS apply Authentication Headers (Essential for connection)
    if opts.headers then
        local h_list = {}
        for k, v in pairs(opts.headers) do
            local kl = k:lower()
            if kl == "user-agent" then set_property_if_diff("user-agent", v)
            elseif kl == "referer" then set_property_if_diff("referrer", v)
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
        local lp = string.format("http_persistent=%s,reconnect=%s,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=%d,analyzeduration=%s,probesize=%s", 
                                 persistence, reconnect_val, r_delay, tostring(opts.analyzeduration or 0), tostring(opts.probesize or 32))
        set_property_if_diff("demuxer-lavf-o", lp)
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
            set_property_if_diff("cookies-file", opts.cookies_file) 
        end
        
        if ytdl_opts ~= "" then
            set_property_if_diff("ytdl-raw-options", ytdl_opts)
        end

        if opts.ytdl_format then set_property_if_diff("ytdl-format", opts.ytdl_format) end

        -- Apply Buffering & Cache
        if opts.enable_cache == false then
            set_property_if_diff("cache", "no")
            debug_log("Buffering disabled by user setting.")
        else
            if opts.demuxer_max_bytes then set_property_if_diff("demuxer-max-bytes", opts.demuxer_max_bytes) end
            if opts.demuxer_max_back_bytes then set_property_if_diff("demuxer-max-back-bytes", opts.demuxer_max_back_bytes) end
            if opts.cache_secs then set_property_if_diff("cache-secs", tostring(opts.cache_secs)) end
            if opts.demuxer_readahead_secs then set_property_if_diff("demuxer-readahead-secs", tostring(opts.demuxer_readahead_secs)) end
            if opts.stream_buffer_size then set_property_if_diff("stream-buffer-size", opts.stream_buffer_size) end
        end

        if not opts.disable_network_overrides then
            local persistence = "1"
            if opts.http_persistence == "off" then persistence = "0"
            elseif opts.http_persistence == "auto" and opts.disable_http_persistent then persistence = "0" end
            local reconnect_val = (opts.enable_reconnect ~= false) and "1" or "0"
            local r_delay = tonumber(opts.reconnect_delay) or 4
            local lp = string.format("http_persistent=%s,reconnect=%s,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=%d", persistence, reconnect_val, r_delay)
            set_property_if_diff("demuxer-lavf-o", lp)
        end
    end

    -- 9. Misc context
    if opts.project_root then set_property_if_diff("user-data/project-root", opts.project_root) end
    if opts.folder_id then set_property_if_diff("user-data/folder-id", opts.folder_id) end
    if opts.is_unmanaged ~= nil then set_property_if_diff("user-data/is-unmanaged", opts.is_unmanaged and "yes" or "no") end
    if opts.cookies_browser then set_property_if_diff("user-data/cookies-browser", opts.cookies_browser) end
    if opts.original_url then mp.set_property_native("user-data/original-url", opts.original_url) end
end

mp.add_hook("on_load", -10, function()
    local ok, err = pcall(apply_adaptive_settings)
    if not ok then
        mp.msg.error("AdaptiveHeaders: Error in on_load hook: " .. tostring(err))
    end
end)

mp.register_event("end-file", save_current_position)
