local utils = require 'mp.utils'
local url_options = {}
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

-- Register options from Python
mp.register_script_message("set_url_options", function(url, options_json)
    local ok, options = pcall(utils.parse_json, options_json)
    if ok and options then
        local d_url = url_decode(url)
        if not url_options[url] and not (d_url ~= "" and url_options[d_url]) then
            table.insert(url_history, url)
        end
        url_options[url] = options
        if d_url ~= "" then url_options[d_url] = options end
        debug_log("Registered options for " .. url)

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
    
    -- 1. CAPTURE PERSISTENT PROPERTIES
    local hot_swap_json = mp.get_property("user-data/hot-swap-options") or ""
    local original_url = mp.get_property("user-data/original-url") or ""
    local item_id = mp.get_property("user-data/id") or ""
    
    -- Clear the hot-swap manifest immediately
    mp.set_property("user-data/hot-swap-options", "")

    -- 2. ABSOLUTE RESET (Global reset for maximum authority)
    -- Note: ytdl is NOT reset here; it's handled at the end of this function.
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

    local opts = nil

    -- 3. RESOLVE OPTIONS
    if hot_swap_json ~= "" then
        local ok, hot_opts = pcall(utils.parse_json, hot_swap_json)
        if ok and hot_opts then
            debug_log("Using Hot Swap manifest.")
            opts = hot_opts
        end
    end

    if not opts then
        -- Robust matching: try original, decoded, and stripped versions
        opts = url_options[path] or url_options[d_path] or 
               (original_url ~= "" and url_options[original_url]) or 
               (original_url ~= "" and url_options[url_decode(original_url)])
        
        if not opts and path:find("?") then
            local stripped_path = path:gsub("%?.*$", "")
            opts = url_options[stripped_path]
        end
    end

    -- 4. APPLY OPTIONS
    local use_ytdl = "no"
    local is_yt = path:find("youtube%.com") or path:find("youtu%.be") or 
                  original_url:find("youtube%.com") or original_url:find("youtu%.be")
    
    local is_pahe = path:find("owocdn%.top") or path:find("kwik%.cx") or
                    original_url:find("owocdn%.top") or original_url:find("kwik%.cx")

    if is_yt then 
        use_ytdl = "yes"
        debug_log("YouTube detected. Defaulting ytdl=yes")
    end

    if opts then
        debug_log("Applying settings for " .. path)
        
        if opts.title and opts.title ~= "" then
            debug_log("Setting title: " .. opts.title)
            mp.set_property("title", opts.title)
            mp.set_property("force-media-title", opts.title)
        end

        local h_list = {}
        if opts.headers then
            for k, v in pairs(opts.headers) do
                local kl = k:lower()
                if kl == "user-agent" then 
                    mp.set_property("user-agent", v)
                elseif kl == "referer" then 
                    mp.set_property("referrer", v)
                end
                
                -- IMPORTANT: DO NOT escape commas when using mp.set_property_native with a table.
                -- MPV handles the separation automatically.
                table.insert(h_list, k .. ": " .. v)
            end
        end

        -- If no Referer was provided but it's a known Pahe link, add the standard one
        if is_pahe and (not opts.headers or not opts.headers["Referer"]) then
            mp.set_property("referrer", "https://kwik.cx/")
            table.insert(h_list, "Referer: https://kwik.cx/")
            debug_log("Auto-added Referer for Animepahe link.")
        end

        if #h_list > 0 then
            mp.set_property_native("http-header-fields", h_list)
        end

        if opts.use_ytdl_mpv == true then 
            use_ytdl = "yes"
            debug_log("use_ytdl_mpv=true found in options. Setting ytdl=yes")
        end
        
        if opts.ytdl_format then mp.set_property("ytdl-format", opts.ytdl_format) end
        
        if opts.ytdl_raw_options then
            local ytdl_opts = opts.ytdl_raw_options
            if not ytdl_opts:find("ignore%-config") then
                ytdl_opts = ytdl_opts .. (ytdl_opts == "" and "" or ",") .. "ignore-config="
            end
            if opts.ffmpeg_path and not ytdl_opts:find("ffmpeg%-location") then
                ytdl_opts = ytdl_opts .. "," .. "ffmpeg-location=" .. opts.ffmpeg_path
            end
            mp.set_property("ytdl-raw-options", ytdl_opts)
        end

        -- Networking overrides
        if not opts.disable_network_overrides then
            local persistence = "1"
            if opts.http_persistence == "off" then persistence = "0"
            elseif opts.http_persistence == "auto" and opts.disable_http_persistent then persistence = "0" end
            
            local lavf_str = "http_persistent=" .. persistence .. ",reconnect=" .. ((opts.enable_reconnect ~= false) and "1" or "0") .. ",reconnect_at_eof=1,reconnect_streamed=1,reconnect_delay_max=" .. tostring(opts.reconnect_delay or 4)
            mp.set_property("demuxer-lavf-o", lavf_str)
        end

        if opts.cookies_file then mp.set_property("cookies-file", opts.cookies_file) end
        if opts.title then mp.set_property("force-media-title", opts.title) end
        if opts.resume_time and tonumber(opts.resume_time) > 0 then
            mp.set_property("file-local-options/start", opts.resume_time)
        end
    end

    -- Finish by setting ytdl state
    debug_log("Final ytdl state for this file: " .. use_ytdl)
    mp.set_property("ytdl", use_ytdl)
    
    -- Restore metadata for current session visibility
    if item_id ~= "" then mp.set_property("user-data/id", item_id) end
    if original_url ~= "" then mp.set_property("user-data/original-url", original_url) end
end

-- Hook at priority 10 (Early, but after initial property set)
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
