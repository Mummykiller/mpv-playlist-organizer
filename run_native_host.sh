#!/bin/sh
# This wrapper ensures __pycache__ directories are not created.
export PYTHONDONTWRITEBYTECODE=1

"/home/shinku/miniconda3/bin/python" "$(dirname "$0")/native_host.py" "$@"