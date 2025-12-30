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
    
    -- (rest of the apply logic)
    
    -- (We'll re-fetch opts to avoid duplicating the apply logic here for the 'if opts' block)
    opts = url_options[path]

    if opts then
        -- Apply HTTP Headers
        if opts.headers then
            local header_list = {}
            for k, v in pairs(opts.headers) do
                -- Sanitize value (remove commas)
                local clean_v = tostring(v):gsub(",", "")
                table.insert(header_list, k .. ": " .. clean_v)
            end
            if #header_list > 0 then
                local headers_str = table.concat(header_list, ",")
                debug_log("AdaptiveHeaders: Applying headers: " .. headers_str)
                mp.set_property("http-header-fields", headers_str)
                -- Also set UA and Referer directly as fallback
                if opts.headers["User-Agent"] then mp.set_property("user-agent", opts.headers["User-Agent"]) end
                if opts.headers["Referer"] then mp.set_property("referrer", opts.headers["Referer"]) end
            end
        else
            debug_log("AdaptiveHeaders: No per-URL headers, keeping current.")
        end

        -- Apply YTDL Raw Options
        if opts.ytdl_raw_options then
            debug_log("AdaptiveHeaders: Applying per-URL ytdl-raw-options: " .. opts.ytdl_raw_options)
            mp.set_property("ytdl-raw-options", opts.ytdl_raw_options)
        else
            debug_log("AdaptiveHeaders: No per-URL ytdl-raw-options, keeping current.")
        end

        -- Store original URL for other scripts (e.g. thumbnailer fix)
        if opts.original_url then
            mp.set_property("user-data/original-url", opts.original_url)
        end
        
        last_applied_url = path
    end
    
    -- Check current properties AFTER applying
    local final_headers = mp.get_property("http-header-fields")
    local final_ytdl_opts = mp.get_property("ytdl-raw-options")
    debug_log("AdaptiveHeaders: Final properties AFTER apply: Headers=" .. tostring(final_headers) .. ", YTDL-Opts=" .. tostring(final_ytdl_opts))
end)
