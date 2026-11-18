import logging
import os
import subprocess
import platform
from .base_handler import BaseHandler
from .registry import command
from .. import native_link
from ..smart_reorder import SmartReorder

class DataHandler(BaseHandler):
    def __init__(self, ctx):
        super().__init__(ctx)

    @command('log_event')
    def handle_log_event(self, request: native_link.LogRequest):
        # Determine level
        level_name = request.level.upper()

        # Map JS FATAL to Python CRITICAL
        if level_name == "FATAL":
            level = logging.CRITICAL
        else:
            level = getattr(logging, level_name, logging.INFO)

        msg = str(request.message or "")[:4096]
        stack = str(getattr(request, 'stack', None) or "")[:4096]

        # If it's an error from the frontend/browser, route it to the dedicated browser_errors log
        if level in (logging.ERROR, logging.CRITICAL):
            browser_logger = logging.getLogger("browser_errors")
            formatted = f"[{request.context}] {msg}"
            if stack:
                formatted += f"\n  Stack: {stack}"
            browser_logger.error(formatted)

        # Log it using the standard logger
        logging.log(level, f"[JS-{request.context}] {msg}")
        return native_link.success()

    @command('log_browser_error')
    def handle_log_browser_error(self, request: native_link.LogBrowserErrorRequest):
        browser_logger = logging.getLogger("browser_errors")
        msg = str(request.message or "")[:4096]
        stack = str(getattr(request, 'stack', None) or "")[:4096]
        formatted = f"[{request.context}] {msg}"
        if stack:
            formatted += f"\n  Stack: {stack}"
        browser_logger.error(formatted)
        return native_link.success()

    @command('get_unified_diagnostics')
    def handle_get_unified_diagnostics(self, request: native_link.DataSyncRequest):
        # Flush logs to disk by restarting the listener
        from utils import logger as logger_module
        logger_module.shutdown()
        resolved_dir = logger_module.initialize(self.ctx.data_dir, self.ctx.script_dir) or self.ctx.data_dir

        js_diagnostics = request.data or {}

        def read_tail(filename, kb=100):
            path = os.path.join(resolved_dir, filename)
            if not os.path.exists(path):
                return f"[File not found: {filename}]"
            try:
                size = os.path.getsize(path)
                read_size = min(size, kb * 1024)
                with open(path, 'rb') as f:
                    if size > read_size:
                        f.seek(-read_size, 2)
                    content = f.read().decode('utf-8', errors='replace')
                    return content
            except Exception as e:
                return f"[Error reading {filename}: {e}]"

        native_log = read_tail("native_host.log")
        ipc_log = read_tail("ipc_events.log")
        browser_log = read_tail("browser_errors.log")

        import sys
        system_info = {
            "python_version": sys.version,
            "platform": platform.platform(),
            "data_dir": self.ctx.data_dir
        }

        diag_collector = getattr(self.ctx, 'diagnostic_collector', None)
        native_errors = diag_collector.get_errors() if diag_collector else []

        return native_link.success({
            "js_diagnostics": js_diagnostics,
            "native_diagnostics": native_errors,
            "native_log": native_log,
            "ipc_log": ipc_log,
            "browser_log": browser_log,
            "system_info": system_info
        })

    @command('export_data')
    def handle_export_data(self, request: native_link.DataSyncRequest):
        data = request.data
        if data is None:
            return native_link.failure("No data provided.")

        if request.is_incremental:
            success = self.file_io.save_library_batch(data, is_incremental=True)
            if success:
                return native_link.success(message="Incremental sync complete.", log={"text": "[Native Host]: Incremental sync complete.", "type": "info"})
            else:
                return native_link.failure("Incremental sync failed.")
        else:
            res = self.file_io.write_folders_file(data)
            if res["success"]:
                res["log"] = {"text": "[Native Host]: Data export successful.", "type": "info"}
            return res

    @command('export_playlists')
    def handle_export_playlists(self, request: native_link.DataSyncRequest):
        if not request.data or not request.filename:
            return native_link.failure("Missing data or filename.")
        res = self.file_io.write_export_file(request.filename, request.data, subfolder=request.subfolder)
        if res["success"]:
            res["log"] = {"text": f"[Native Host]: Playlist '{request.filename}' exported successfully.", "type": "info"}
        return res

    @command('export_all_playlists_separately')
    def handle_export_all_separately(self, request: native_link.DataSyncRequest):
        folders = request.data
        custom_names = request.custom_names or {}
        if not folders: return native_link.failure("No folder data provided.")
        count = 0
        for f_id, f_data in folders.items():
            if 'playlist' in f_data:
                target_name = custom_names.get(f_id, f_id)
                safe_name = "".join(c if c.isalnum() or c in ('-', '_', ' ') else '_' for c in target_name).rstrip()
                if self.file_io.write_export_file(safe_name, f_data)["success"]:
                    count += 1
        return native_link.success(message=f"Successfully exported {count} playlists.")

    @command('list_import_files')
    def handle_list_import_files(self, request: native_link.BaseRequest):
        return self.file_io.list_import_files()

    @command('import_from_file')
    def handle_import_from_file(self, request: native_link.DataSyncRequest):
        if not request.filename: return native_link.failure("No filename provided.")
        try:
            export_dir_real = os.path.realpath(self.file_io.EXPORT_DIR)
            target_path = os.path.join(export_dir_real, request.filename)
            filepath = os.path.realpath(target_path)
            if os.path.commonpath([export_dir_real, filepath]) != export_dir_real or not filepath.lower().endswith('.json'):
                msg = "Access denied: Path outside export directory."
                return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})

            with open(filepath, 'r', encoding='utf-8') as f:
                import json
                data = json.load(f)
                return native_link.success(data=data)
        except Exception as e:
            msg = f"Failed to read or parse file: {e}"
            return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})

    @command('open_export_folder')
    def handle_open_export_folder(self, request: native_link.BaseRequest):
        try:
            os.makedirs(self.file_io.EXPORT_DIR, exist_ok=True)
            path = os.path.abspath(self.file_io.EXPORT_DIR)
            platform_name = self.file_io.get_settings().get('os_platform', platform.system())
            if platform_name == "Windows":
                subprocess.Popen(['explorer', os.path.normpath(path)])
            elif platform_name == "Darwin":
                subprocess.run(['open', path], check=True)
            else:
                subprocess.run(['xdg-open', path], check=True)
            return native_link.success(message="Opening export folder.")
        except Exception as e:
            msg = f"Failed to open folder: {e}"
            return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})

    @command('get_metadata_cache')
    def handle_get_metadata_cache(self, request: native_link.BaseRequest):
        """Returns the global metadata cache for a specific shard or all shards."""
        if hasattr(request, 'shard') and request.shard:
            data = self.ctx.metadata_cache.get_shard(request.shard)
            return native_link.success({"shard": request.shard, "data": data})
        else:
            shards = self.ctx.metadata_cache.list_shards()
            return native_link.success({"shards": shards})

    @command('cancel_task')
    def handle_cancel_task(self, request: native_link.BaseRequest):
        """Cancels a specific background task by ID."""
        task_id = getattr(request, 'task_id', None)
        if task_id:
            self.ctx.task_manager.cancel_job(task_id)
            return native_link.success(message=f"Task {task_id} cancellation requested.")
        return native_link.failure("Missing task_id.")

    @command('get_smart_reorder')
    def handle_get_smart_reorder(self, request: native_link.DataSyncRequest):
        folder_id = getattr(request, 'folder_id', None)
        if not folder_id:
            return native_link.failure("No folder ID provided.")

        try:
            new_playlist = []
            def _reorder_shard(playlist, _index_entry):
                nonlocal new_playlist
                if not playlist:
                    new_playlist = []
                    return None
                reorderer = SmartReorder(threshold=0.85)
                new_playlist = reorderer.organize(playlist)
                return new_playlist

            self.file_io.update_shard(folder_id, _reorder_shard, update_index=True)
            return native_link.success({"playlist": new_playlist})
        except Exception as e:
            logging.error(f"Smart reorder failed: {e}")
            return native_link.failure(str(e))
