local utils = require 'mp.utils'
local url_options = {}
local last_applied_url = nil

-- Dedicated debug log for AdaptiveHeaders
local function debug_log(msg)
    mp.msg.info(msg)
end

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

local function to_hex(s)
    if not s then return "nil" end
    return (s:gsub('.', function (c)
        return string.format('%02X ', string.byte(c))
    end))
end

-- Apply headers and YTDL Options just-in-time when a file starts loading
-- Priority 1 to ensure it runs before ytdl_hook (usually priority 10)
mp.add_hook("on_load", 1, function()
    local path = mp.get_property("path")
    if not path then return end

    debug_log("AdaptiveHeaders: on_load for " .. path .. " (len: " .. #path .. ")")
    
    -- Check current properties BEFORE applying
    local current_headers = mp.get_property("http-header-fields")
    local current_ytdl_opts = mp.get_property("ytdl-raw-options")
    debug_log("AdaptiveHeaders: Current properties BEFORE apply: Headers=" .. tostring(current_headers) .. ", YTDL-Opts=" .. tostring(current_ytdl_opts))

    local opts = url_options[path]
    
    if not opts then
        -- Fallback: check if we have an original URL stored in user-data
        local original_url = mp.get_property("user-data/original-url")
        if original_url and url_options[original_url] then
            debug_log("AdaptiveHeaders: Using options from original-url: " .. original_url)
            opts = url_options[original_url]
        end
    end

    if opts then
        debug_log("AdaptiveHeaders: Found registered options for " .. path)
    else
        -- Item has no registered options. 
        debug_log("AdaptiveHeaders: No options found for " .. path .. ". Keeping current properties.")
        debug_log("AdaptiveHeaders: Path Hex: " .. to_hex(path))
        
        -- DIAGNOSTIC: Count and list registered URLs
        local count = 0
        for _ in pairs(url_options) do count = count + 1 end
        debug_log("AdaptiveHeaders: Total registered URLs: " .. count)
        if count > 0 then
            debug_log("AdaptiveHeaders: Registered keys:")
            for k, _ in pairs(url_options) do
                debug_log("  - '" .. k .. "' (len: " .. #k .. ")")
                debug_log("    Hex: " .. to_hex(k))
            end
        end
    end
    
    -- (We'll re-fetch opts to avoid duplicating the apply logic here for the 'if opts' block)
    opts = url_options[path]

    -- DEFAULT STATE: Assume we handle resolution externally unless told otherwise
    local use_ytdl = "no"
    local raw_options = ""

    if opts then
                        -- Apply HTTP Headers
                        if opts.headers then
                            local header_list = {}
                            local has_any_custom_headers = false
                            
                            -- Set UA and Referer using specific properties to preserve commas/special chars
                            if opts.headers["User-Agent"] and mp.get_property("user-agent") ~= opts.headers["User-Agent"] then 
                                debug_log("AdaptiveHeaders: Setting user-agent: " .. opts.headers["User-Agent"])
                                mp.set_property("user-agent", opts.headers["User-Agent"]) 
                            end
                            if opts.headers["Referer"] and mp.get_property("referrer") ~= opts.headers["Referer"] then 
                                debug_log("AdaptiveHeaders: Setting referrer: " .. opts.headers["Referer"])
                                mp.set_property("referrer", opts.headers["Referer"]) 
                            end
                
                            -- Only add OTHER headers to http-header-fields
                            for k, v in pairs(opts.headers) do
                                if k ~= "User-Agent" and k ~= "Referer" then
                                    -- Sanitize value (remove commas for other headers if needed, 
                                    -- though usually Origin/X-Requested-With don't have them)
                                    local clean_v = tostring(v):gsub(",", "")
                                    table.insert(header_list, k .. ": " .. clean_v)
                                    has_any_custom_headers = true
                                end
                            end
                
                            -- Apply global http-header-fields if we have custom headers.
                            if has_any_custom_headers then
                                local headers_str = table.concat(header_list, ",")
                                if mp.get_property("http-header-fields") ~= headers_str then
                                    debug_log("AdaptiveHeaders: Applying custom headers: " .. headers_str)
                                    mp.set_property("http-header-fields", headers_str)
                                end
                            else
                                if mp.get_property("http-header-fields") ~= "" then
                                    debug_log("AdaptiveHeaders: Clearing custom headers.")
                                    mp.set_property("http-header-fields", "")
                                end
                            end
                        else
                            debug_log("AdaptiveHeaders: No per-URL headers, keeping current.")
                        end
                
                        -- Determine YTDL state from options
                        if opts.ytdl_raw_options then
                            raw_options = opts.ytdl_raw_options
                        end
                        if opts.use_ytdl_mpv == true then
                            use_ytdl = "yes"
                        end
                
        -- Reconnect and HTTP Persistent settings
        -- We add reconnect options for direct streams to handle transient errors
        local lavf_dict = {
            reconnect = "1",
            reconnect_at_eof = "1",
            reconnect_streamed = "1",
            reconnect_delay_max = "5"
        }
        
        if opts.disable_http_persistent then
            lavf_dict.http_persistent = "0"
        end
        
        local lavf_pairs = {}
        for k, v in pairs(lavf_dict) do
            table.insert(lavf_pairs, k .. "=" .. v)
        end
        local lavf_opts = table.concat(lavf_pairs, ",")
        
        if mp.get_property("demuxer-lavf-o") ~= lavf_opts then
            debug_log("AdaptiveHeaders: Setting demuxer-lavf-o: " .. lavf_opts)
            mp.set_property("demuxer-lavf-o", lavf_opts)
        end
                

        -- Apply cookies file if provided
        local cookies_file = opts.cookies_file or ""
        if mp.get_property("cookies-file") ~= cookies_file then
            debug_log("AdaptiveHeaders: Applying cookies-file: " .. cookies_file)
            mp.set_property("cookies-file", cookies_file)
        end

        -- Store original URL and ID for other scripts and deduplication
        if opts.original_url then
            mp.set_property("user-data/original-url", opts.original_url)
        end
        if opts.id then
            mp.set_property("user-data/id", opts.id)
        end
        
        last_applied_url = path
    end

    -- ALWAYS set these properties to ensure we don't leak state between files
    -- and to ensure resolved URLs don't trigger edl://
    if mp.get_property("ytdl") ~= use_ytdl then
        debug_log("AdaptiveHeaders: Setting ytdl=" .. use_ytdl)
        mp.set_property("ytdl", use_ytdl)
    end
    if mp.get_property("ytdl-raw-options") ~= raw_options then
        debug_log("AdaptiveHeaders: Setting ytdl-raw-options=" .. raw_options)
        mp.set_property("ytdl-raw-options", raw_options)
    end
    
    -- Check current properties AFTER applying
    local final_headers = mp.get_property("http-header-fields")
    local final_ytdl_opts = mp.get_property("ytdl-raw-options")
    debug_log("AdaptiveHeaders: Final properties AFTER apply: Headers=" .. tostring(final_headers) .. ", YTDL-Opts=" .. tostring(final_ytdl_opts))
end)
