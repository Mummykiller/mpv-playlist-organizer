import logging
import os
import subprocess
import platform
from .base_handler import BaseHandler
from .. import native_link

from .base_handler import BaseHandler
from .registry import command
from .. import native_link

class DataHandler(BaseHandler):
    def __init__(self, ctx):
        super().__init__(ctx)

    @command('export_data')
    def handle_export_data(self, request: native_link.DataSyncRequest):
        data = request.data
        if data is None:
            return native_link.failure("No data provided.")
            
        if request.is_incremental:
            success = self.file_io.save_library_batch(data)
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
            target_path = os.path.join(self.file_io.EXPORT_DIR, request.filename)
            filepath = os.path.abspath(target_path)
            export_dir_abs = os.path.abspath(self.file_io.EXPORT_DIR)
            if not filepath.startswith(export_dir_abs):
                msg = "Access denied: Path outside export directory."
                return native_link.failure(msg, log={"text": f"[Native Host]: {msg}", "type": "error"})
            with open(filepath, 'r', encoding='utf-8') as f:
                return native_link.success(f.read())
        except Exception as e:
            msg = f"Failed to read file: {e}"
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
