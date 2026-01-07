local utils = require 'mp.utils'
local url_options = {}
local last_applied_url = nil

-- Store initial global states to restore them between files
local initial_ytdl_raw = mp.get_property("ytdl-raw-options") or ""
local initial_ytdl_format = mp.get_property("ytdl-format") or ""

-- Dedicated debug log for AdaptiveHeaders
local function debug_log(msg)
    mp.msg.info(msg)
end

debug_log("AdaptiveHeaders: Script loaded and initializing...")

-- Allow Python to print logs to the MPV terminal for visibility
mp.register_script_message("python_log", function(msg)
    debug_log(msg)
end)

-- Receive per-URL options directly from Python
mp.register_script_message("set_url_options", function(url, options_json)
    local ok, options = pcall(utils.parse_json, options_json)
    if ok then
        debug_log("AdaptiveHeaders: Registered options for " .. url)
        url_options[url] = options
    else
        debug_log("AdaptiveHeaders: Failed to parse options JSON for " .. url)
    end
end)

-- Helper to split strings (needed for merging options)
local function split(s, sep)
    local res = {}
    for part in s:gmatch("([^" .. sep .. "]+)") do
        table.insert(res, part)
    end
    return res
end

-- Function to merge two ytdl-raw-options strings
local function merge_raw_options(old, new)
    if old == "" then return new end
    if new == "" then return old end
    
    local merged_map = {}
    
    local function parse_into_map(s)
        -- Improved split: find commas NOT preceded by a backslash
        local last_pos = 1
        while true do
            local comma_pos = s:find("[^\\],", last_pos)
            local part
            if not comma_pos then
                part = s:sub(last_pos)
            else
                part = s:sub(last_pos, comma_pos)
            end
            
            if part and part ~= "" then
                part = part:gsub("^%s*(.-)%s*$", "%1") -- trim
                local key, val = part:match("([^=]+)=(.*)")
                if key then
                    merged_map[key:lower()] = val
                else
                    -- Boolean flag with no =
                    merged_map[part:lower()] = ""
                end
            end
            
            if not comma_pos then break end
            last_pos = comma_pos + 2
        end
    end
    
    parse_into_map(old)
    parse_into_map(new)
    
    local final_parts = {}
    for k, v in pairs(merged_map) do
        if v == "" then
            table.insert(final_parts, k .. "=")
        else
            table.insert(final_parts, k .. "=" .. v)
        end
    end
    return table.concat(final_parts, ",")
end

-- Apply headers and YTDL Options just-in-time when a file starts loading
-- Priority 1 to ensure it runs before ytdl_hook (usually priority 10)
mp.add_hook("on_load", 1, function()
    local path = mp.get_property("path")
    if not path then return end

    debug_log("AdaptiveHeaders: on_load for " .. path)
    
    -- TRY 1: Direct path match
    local opts = url_options[path]
    
    -- TRY 2: check if we have an original URL stored in user-data
    if not opts then
        local original_url = mp.get_property("user-data/original-url")
        if original_url and url_options[original_url] then
            debug_log("AdaptiveHeaders: Using options from original-url: " .. original_url)
            opts = url_options[original_url]
        end
    end
    
    -- TRY 3: Fuzzy match
    if not opts then
        for k, v in pairs(url_options) do
            if path:find(k, 1, true) or k:find(path, 1, true) then
                debug_log("AdaptiveHeaders: Fuzzy match found for '" .. k .. "'")
                opts = v
                break
            end
        end
    end

    -- DEFAULT STATE
    local use_ytdl = "no"
    local local_raw_options = ""
    local ytdl_format = initial_ytdl_format

    -- Reset dynamic properties for every file load to prevent leakage
    mp.set_property("http-header-fields", "")
    mp.set_property("user-agent", "")
    mp.set_property("referrer", "")
    mp.set_property("cookies-file", "")
    mp.set_property("ytdl-raw-options", initial_ytdl_raw)
    mp.set_property("ytdl-format", initial_ytdl_format)

    -- SAFETY: If the path is a YouTube URL, we MUST use ytdl
    if path:find("youtube%.com") or path:find("youtu%.be") then
        use_ytdl = "yes"
    end

    if opts then
        debug_log("AdaptiveHeaders: Found registered options.")
        
        -- Apply HTTP Headers
        if opts.headers then
            local header_list = {}
            for k, v in pairs(opts.headers) do
                -- Sanitize: remove commas and newlines
                local clean_v = v:gsub(",", ""):gsub("[\r\n]", "")
                table.insert(header_list, k .. ": " .. clean_v)
            end
            local header_str = table.concat(header_list, ",")
            debug_log("AdaptiveHeaders: Setting http-header-fields: " .. header_str)
            mp.set_property("http-header-fields", header_str)
            
            if opts.headers["User-Agent"] then
                mp.set_property("user-agent", opts.headers["User-Agent"])
            end
            if opts.headers["Referer"] then
                mp.set_property("referrer", opts.headers["Referer"])
            end
        end

        -- Determine YTDL state from options
        if opts.ytdl_raw_options then
            local_raw_options = opts.ytdl_raw_options
        end

        -- Always ignore local yt-dlp config for consistency
        if not local_raw_options:find("ignore%-config") then
            if local_raw_options == "" then local_raw_options = "ignore-config=" 
            else local_raw_options = local_raw_options .. ",ignore-config=" end
        end

        -- Inject FFmpeg location if provided
        if opts.ffmpeg_path and opts.ffmpeg_path ~= "" then
            if not local_raw_options:find("ffmpeg%-location") then
                local_raw_options = local_raw_options .. ",ffmpeg-location=" .. opts.ffmpeg_path
            end
        end

        if opts.use_ytdl_mpv == true then
            use_ytdl = "yes"
        end
        if opts.ytdl_format then
            ytdl_format = opts.ytdl_format
        end

        -- Networking & Reconnect
        if not opts.disable_network_overrides then
            local network_threads = tostring(opts.ytdlp_concurrent_fragments or 4)
            
            local persistence_val = "1"
            if opts.http_persistence == "off" then
                persistence_val = "0"
            elseif opts.http_persistence == "on" then
                persistence_val = "1"
            else
                -- 'auto': follow the site-specific recommendation (e.g. False for YouTube)
                persistence_val = opts.disable_http_persistent and "0" or "1"
            end

            local lavf_dict = {
                hls_segment_parallel_downloads = network_threads,
                http_persistent = persistence_val
            }

            if opts.enable_reconnect ~= false then
                lavf_dict.reconnect = "1"
                lavf_dict.reconnect_at_eof = "1"
                lavf_dict.reconnect_streamed = "1"
                lavf_dict.reconnect_delay_max = tostring(opts.reconnect_delay or 4)
            end
            
            local lavf_pairs = {}
            for k, v in pairs(lavf_dict) do table.insert(lavf_pairs, k .. "=" .. v) end
            mp.set_property("demuxer-lavf-o", table.concat(lavf_pairs, ","))
        end

        -- Apply cookies file
        if opts.cookies_file and opts.cookies_file ~= "" then
            mp.set_property("cookies-file", opts.cookies_file)
        end

        -- Store metadata
        if opts.original_url then mp.set_property("user-data/original-url", opts.original_url) end
        if opts.id then mp.set_property("user-data/id", opts.id) end
    end

    -- Apply YTDL changes
    if mp.get_property("ytdl") ~= use_ytdl then
        mp.set_property("ytdl", use_ytdl)
    end

    -- Final merge with global command-line options
    local current_global_raw = mp.get_property("ytdl-raw-options") or ""
    local final_raw = merge_raw_options(current_global_raw, local_raw_options)
    
    if final_raw ~= "" and mp.get_property("ytdl-raw-options") ~= final_raw then
        debug_log("AdaptiveHeaders: Applying merged ytdl-raw-options=" .. final_raw)
        mp.set_property("ytdl-raw-options", final_raw)
    end

    if ytdl_format ~= "" and mp.get_property("ytdl-format") ~= ytdl_format then
        mp.set_property("ytdl-format", ytdl_format)
    end
end)