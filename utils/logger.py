import logging
import datetime

class StandardLogger:
    """
    Standardized Python logger that follows the same [Time] [Tag]: Message format.
    Delegates to the standard logging module but simplifies the interface.
    """
    def __init__(self, tag='PY'):
        self.tag = tag
        self.logger = logging.getLogger(tag)

    def _format(self, msg):
        time_str = datetime.datetime.now().strftime('%H:%M:%S')
        return f"[{time_str}] [{self.tag}]: {msg}"

    def info(self, msg):
        self.logger.info(msg)
        # We don't print to console here because native host uses stdout for JSON communication.
        # Use log_stream or remote logging for visible feedback.

    def error(self, msg):
        self.logger.error(msg)

    def debug(self, msg):
        self.logger.debug(msg)

    def warning(self, msg):
        self.logger.warning(msg)
