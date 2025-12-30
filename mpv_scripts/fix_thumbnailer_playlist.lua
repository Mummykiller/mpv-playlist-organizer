-- fix_thumbnailer_playlist.lua
-- This script patches the mp.command_native subprocess call to fix a bug in the thumbnailer script
-- where it passes --playlist=... after the '--' separator, causing mpv to fail.

local mp = require 'mp'
local msg = require 'mp.msg'
local utils = require 'mp.utils'

-- Function to fix the --playlist syntax error
local function fix_args(args)
    if not args then return false end
    local has_separator = false
    local separator_index = -1
    
    -- 1. Fix the '--' separator issue
    for i, arg in ipairs(args) do
        if arg == "--" then
            has_separator = true
            separator_index = i
            break
        end
    end
    
    if has_separator and separator_index ~= -1 then
        for i = separator_index + 1, #args do
            local arg = args[i]
            if type(arg) == "string" and arg:find("^%-%-playlist=") then
                msg.info("Fixing thumbnailer command: moving " .. arg .. " before '--' separator.")
                local val = table.remove(args, i)
                table.insert(args, separator_index, val)
                return true
            end
        end
    end

    -- 2. Fix the 'sb0' format error for yt-dlp (storyboards)
    -- If yt-dlp is called with --format sb0 on a resolved stream URL, it fails.
    -- We replace the resolved URL with the original YouTube URL.
    for i, arg in ipairs(args) do
        if arg == "sb0" and args[i-1] == "--format" then
            local original_url = mp.get_property("user-data/original-url")
            if original_url then
                msg.info("Fixing storyboard request: using original URL " .. original_url)
                -- The URL is usually the last argument after '--'
                if args[#args-1] == "--" then
                    args[#args] = original_url
                else
                    -- Search for the URL argument (anything that looks like a URL)
                    for j = #args, 1, -1 do
                        if type(args[j]) == "string" and args[j]:find("://") then
                            args[j] = original_url
                            break
                        end
                    end
                end
            end
            break
        end
    end

    return false
end

-- Patch mp.command_native
local original_command_native = mp.command_native
mp.command_native = function(t, def)
    if t and t.name == "subprocess" and t.args then
        fix_args(t.args)
    end
    return original_command_native(t, def)
end

-- Patch mp.command_native_async
local original_command_native_async = mp.command_native_async
mp.command_native_async = function(t, fn)
    if t and t.name == "subprocess" and t.args then
        fix_args(t.args)
    end
    return original_command_native_async(t, fn)
end

-- Patch utils.subprocess (some scripts use this directly)
local original_utils_subprocess = utils.subprocess
utils.subprocess = function(t)
    if t and t.args then
        fix_args(t.args)
    end
    return original_utils_subprocess(t)
end

msg.info("Thumbnailer playlist fix script loaded (v3: patched utils.subprocess).")
