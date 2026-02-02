import uuid
import logging
import threading

class TaskManager:
    """
    Manages background tasks and reports progress to the frontend via IPC.
    Allows for task cancellation and multi-step job tracking.
    """
    def __init__(self, send_message_func):
        self.send_message = send_message_func
        self.jobs = {} # { job_id: job_data }
        self.lock = threading.Lock()
        self._cancelled_jobs = set()

    def create_job(self, type_name, label, total=0):
        """Creates a new job and returns its unique ID."""
        job_id = str(uuid.uuid4())
        job_data = {
            "id": job_id,
            "type": type_name,
            "label": label,
            "status": "queued",
            "progress": 0,
            "total": total,
            "can_cancel": True
        }
        
        with self.lock:
            self.jobs[job_id] = job_data
        
        self._broadcast_task_update(job_id)
        return job_id

    def update_job(self, job_id, progress=None, status=None, label=None):
        """Updates job state and broadcasts to the UI."""
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return

            if progress is not None:
                job["progress"] = progress
            if status is not None:
                job["status"] = status
            if label is not None:
                job["label"] = label
            
            # Auto-cleanup on completion or failure
            is_finished = job["status"] in ["completed", "failed", "cancelled"]

        self._broadcast_task_update(job_id, removed=is_finished)
        
        if is_finished:
            with self.lock:
                if job_id in self.jobs:
                    del self.jobs[job_id]
                if job_id in self._cancelled_jobs:
                    self._cancelled_jobs.remove(job_id)

    def cancel_job(self, job_id):
        """Marks a job for cancellation."""
        with self.lock:
            if job_id in self.jobs:
                self._cancelled_jobs.add(job_id)
                self.jobs[job_id]["status"] = "cancelled"
        
        # Immediate broadcast so UI can show "Cancelling..."
        self._broadcast_task_update(job_id)

    def is_cancelled(self, job_id):
        """Thread-safe check to see if a job has been requested to stop."""
        with self.lock:
            return job_id in self._cancelled_jobs

    def _broadcast_task_update(self, job_id, removed=False):
        """Sends the task state over the bridge."""
        job_data = None
        with self.lock:
            job_data = self.jobs.get(job_id)
        
        if not job_data and not removed:
            return

        self.send_message({
            "action": "task_update",
            "task_id": job_id,
            "removed": removed,
            "task": job_data
        })