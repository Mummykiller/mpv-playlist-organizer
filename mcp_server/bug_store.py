"""SQLite-backed bug pattern store for the local mpv-playlist-organizer MCP server."""

import os
import re
import sqlite3
import sys
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from typing import Any

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

MCP_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB_PATH = os.path.join(MCP_DIR, "bug_patterns.db")
DB_ENV_VAR = "MPV_MCP_BUG_DB_PATH"

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
VALID_CATEGORIES = frozenset(
    {
        "general",
        "concurrency",
        "security",
        "state-sync",
        "ui-dom",
        "ipc",
        "lifecycle",
        "testing",
        "tooling",
    }
)
VALID_SEVERITIES = frozenset({"high", "medium", "low"})
VALID_STATUSES = frozenset({"watching", "promote_candidate", "graduated"})
PROMOTE_THRESHOLD = 2

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bug_patterns (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    severity TEXT NOT NULL DEFAULT 'medium',
    hits INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'watching',
    details TEXT NOT NULL DEFAULT '',
    suggested_check TEXT NOT NULL DEFAULT '',
    test_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bug_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_slug TEXT NOT NULL REFERENCES bug_patterns(slug) ON DELETE CASCADE,
    location TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(pattern_slug, location)
);

CREATE INDEX IF NOT EXISTS idx_bug_occurrences_slug ON bug_occurrences(pattern_slug);
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _resolve_db_path(db_path: str | None = None) -> str:
    if db_path:
        return db_path
    env_path = os.environ.get(DB_ENV_VAR, "").strip()
    return env_path or DEFAULT_DB_PATH


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    resolved = _resolve_db_path(db_path)
    parent = os.path.dirname(os.path.abspath(resolved))
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(resolved, timeout=5.0, isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.executescript(SCHEMA_SQL)
    except Exception:
        conn.close()
        raise
    return conn


@contextmanager
def _write_tx(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    else:
        if conn.in_transaction:
            conn.execute("COMMIT")


def _validate_slug(slug: Any) -> tuple[str | None, str | None]:
    if not isinstance(slug, str) or not SLUG_RE.match(slug.strip()):
        return (
            None,
            "Invalid slug: must be 2-64 chars matching ^[a-z0-9][a-z0-9_-]{1,63}$ (e.g. 'stale-session-gen')",
        )
    return slug.strip(), None


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def log_bug_pattern(
    slug: str,
    title: str,
    location: str,
    category: str = "general",
    severity: str | None = None,
    note: str = "",
    details: str = "",
    suggested_check: str = "",
    db_path: str | None = None,
) -> dict[str, Any]:
    clean_slug, err = _validate_slug(slug)
    if err or clean_slug is None:
        return {"ok": False, "error": err or "Invalid slug"}

    clean_title = title.strip() if isinstance(title, str) else ""
    if not clean_title or len(clean_title) > 200:
        return {"ok": False, "error": "Invalid title: must be a non-empty string (<= 200 chars)"}

    clean_loc = location.strip() if isinstance(location, str) else ""
    if not clean_loc or len(clean_loc) > 250:
        return {"ok": False, "error": "Invalid location: must be a non-empty file:symbol string (<= 250 chars)"}

    clean_cat = category.strip().lower() if isinstance(category, str) else ""
    if clean_cat not in VALID_CATEGORIES:
        return {"ok": False, "error": f"Invalid category '{category}'. Use one of: {sorted(VALID_CATEGORIES)}"}

    clean_sev: str | None = None
    if severity is not None:
        clean_sev = severity.strip().lower() if isinstance(severity, str) else ""
        if clean_sev not in VALID_SEVERITIES:
            return {"ok": False, "error": f"Invalid severity '{severity}'. Use one of: {sorted(VALID_SEVERITIES)}"}

    clean_note = note.strip()[:500] if isinstance(note, str) else ""
    clean_details = details.strip()[:4000] if isinstance(details, str) else ""
    clean_check = suggested_check.strip()[:1000] if isinstance(suggested_check, str) else ""
    now = _utc_now()

    with closing(_connect(db_path)) as conn:
        with _write_tx(conn):
            existing = conn.execute(
                "SELECT slug, title, category, severity, status, details, suggested_check, test_ref "
                "FROM bug_patterns WHERE slug = ?",
                (clean_slug,),
            ).fetchone()

            reopened = False
            if existing is None:
                insert_sev = clean_sev if clean_sev is not None else "medium"
                conn.execute(
                    """
                    INSERT INTO bug_patterns
                        (slug, title, category, severity, hits, status, details, suggested_check, test_ref, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, 'watching', ?, ?, NULL, ?, ?)
                    """,
                    (clean_slug, clean_title, clean_cat, insert_sev, clean_details, clean_check, now, now),
                )
            else:
                new_category = existing["category"] if (clean_cat == "general" and existing["category"] != "general") else clean_cat
                new_severity = clean_sev if clean_sev is not None else existing["severity"]
                new_details = clean_details or existing["details"]
                new_check = clean_check or existing["suggested_check"]
                reopened = existing["status"] == "graduated"
                conn.execute(
                    """
                    UPDATE bug_patterns
                    SET title = ?, category = ?, severity = ?, details = ?, suggested_check = ?, updated_at = ?
                    WHERE slug = ?
                    """,
                    (clean_title, new_category, new_severity, new_details, new_check, now, clean_slug),
                )

            occ = conn.execute(
                "SELECT id, occurrence_count, note FROM bug_occurrences WHERE pattern_slug = ? AND location = ?",
                (clean_slug, clean_loc),
            ).fetchone()
            if occ is None:
                conn.execute(
                    """
                    INSERT INTO bug_occurrences
                        (pattern_slug, location, occurrence_count, note, created_at, updated_at)
                    VALUES (?, ?, 1, ?, ?, ?)
                    """,
                    (clean_slug, clean_loc, clean_note, now, now),
                )
                location_hits = 1
            else:
                location_hits = int(occ["occurrence_count"]) + 1
                merged_note = clean_note or occ["note"]
                conn.execute(
                    """
                    UPDATE bug_occurrences
                    SET occurrence_count = ?, note = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (location_hits, merged_note, now, occ["id"]),
                )

            stats = conn.execute(
                "SELECT COALESCE(SUM(occurrence_count), 0) AS total_hits, COUNT(*) AS loc_count "
                "FROM bug_occurrences WHERE pattern_slug = ?",
                (clean_slug,),
            ).fetchone()
            total_hits = int(stats["total_hits"])
            loc_count = int(stats["loc_count"])
            new_status = "promote_candidate" if total_hits >= PROMOTE_THRESHOLD else "watching"

            conn.execute(
                "UPDATE bug_patterns SET hits = ?, status = ?, updated_at = ? WHERE slug = ?",
                (total_hits, new_status, now, clean_slug),
            )

    res: dict[str, Any] = {
        "ok": True,
        "slug": clean_slug,
        "hits": total_hits,
        "locations": loc_count,
        "location_hits": location_hits,
        "status": new_status,
        "promote_hint": new_status == "promote_candidate",
    }
    if reopened:
        res["reopened"] = True
    return res


def query_bug_patterns(
    search: str | None = None,
    category: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    min_hits: int | None = None,
    include_graduated: bool = False,
    limit: int = 30,
    db_path: str | None = None,
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []

    if category is not None:
        cat = category.strip().lower()
        if cat not in VALID_CATEGORIES:
            return {"ok": False, "error": f"Invalid category '{category}'. Use one of: {sorted(VALID_CATEGORIES)}"}
        clauses.append("p.category = ?")
        params.append(cat)

    if severity is not None:
        sev = severity.strip().lower()
        if sev not in VALID_SEVERITIES:
            return {"ok": False, "error": f"Invalid severity '{severity}'. Use one of: {sorted(VALID_SEVERITIES)}"}
        clauses.append("p.severity = ?")
        params.append(sev)

    if status is not None:
        st = status.strip().lower()
        if st not in VALID_STATUSES:
            return {"ok": False, "error": f"Invalid status '{status}'. Use one of: {sorted(VALID_STATUSES)}"}
        clauses.append("p.status = ?")
        params.append(st)
    elif not include_graduated:
        clauses.append("p.status != 'graduated'")

    if min_hits is not None:
        try:
            mh = int(min_hits)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid min_hits: must be an integer"}
        clauses.append("p.hits >= ?")
        params.append(mh)

    if search is not None and search.strip():
        like = f"%{_escape_like(search.strip())}%"
        clauses.append(
            "(p.slug LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\' "
            "OR EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.pattern_slug = p.slug AND o.location LIKE ? ESCAPE '\\'))"
        )
        params.extend([like, like, like])

    clamped_limit = max(1, min(100, int(limit) if isinstance(limit, int) else 30))
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    sql = f"""
        SELECT
            p.slug,
            p.title,
            p.category,
            p.severity,
            p.hits,
            p.status,
            p.test_ref,
            p.updated_at,
            (SELECT COUNT(*) FROM bug_occurrences o WHERE o.pattern_slug = p.slug) AS locations
        FROM bug_patterns p
        {where_sql}
        ORDER BY p.hits DESC, p.updated_at DESC
        LIMIT ?
    """
    params.append(clamped_limit)

    with closing(_connect(db_path)) as conn:
        rows = conn.execute(sql, params).fetchall()

    items: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {
            "slug": row["slug"],
            "title": row["title"],
            "category": row["category"],
            "severity": row["severity"],
            "hits": row["hits"],
            "locations": row["locations"],
            "status": row["status"],
            "updated_at": row["updated_at"],
        }
        if row["test_ref"]:
            item["test_ref"] = row["test_ref"]
        items.append(item)

    return {"ok": True, "count": len(items), "items": items}


def get_bug_pattern(slug: str, db_path: str | None = None) -> dict[str, Any]:
    clean_slug, err = _validate_slug(slug)
    if err or clean_slug is None:
        return {"ok": False, "error": err or "Invalid slug"}

    with closing(_connect(db_path)) as conn:
        row = conn.execute(
            """
            SELECT slug, title, category, severity, hits, status, details, suggested_check, test_ref, created_at, updated_at
            FROM bug_patterns
            WHERE slug = ?
            """,
            (clean_slug,),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": f"Bug pattern '{clean_slug}' not found"}

        occ_rows = conn.execute(
            """
            SELECT location, occurrence_count, note, created_at, updated_at
            FROM bug_occurrences
            WHERE pattern_slug = ?
            ORDER BY updated_at DESC, id DESC
            """,
            (clean_slug,),
        ).fetchall()

    return {
        "ok": True,
        "pattern": {
            "slug": row["slug"],
            "title": row["title"],
            "category": row["category"],
            "severity": row["severity"],
            "hits": row["hits"],
            "status": row["status"],
            "details": row["details"],
            "suggested_check": row["suggested_check"],
            "test_ref": row["test_ref"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "occurrences": [
                {
                    "location": o["location"],
                    "occurrence_count": o["occurrence_count"],
                    "note": o["note"],
                    "created_at": o["created_at"],
                    "updated_at": o["updated_at"],
                }
                for o in occ_rows
            ],
        },
    }


def graduate_bug_pattern(
    slug: str,
    test_ref: str,
    note: str = "",
    db_path: str | None = None,
) -> dict[str, Any]:
    clean_slug, err = _validate_slug(slug)
    if err or clean_slug is None:
        return {"ok": False, "error": err or "Invalid slug"}

    clean_ref = test_ref.strip() if isinstance(test_ref, str) else ""
    if not clean_ref or len(clean_ref) > 250:
        return {"ok": False, "error": "Invalid test_ref: must be a non-empty test/check reference (<= 250 chars)"}

    clean_note = note.strip()[:1000] if isinstance(note, str) else ""
    now = _utc_now()

    with closing(_connect(db_path)) as conn:
        with _write_tx(conn):
            row = conn.execute(
                "SELECT slug, hits, details FROM bug_patterns WHERE slug = ?",
                (clean_slug,),
            ).fetchone()
            if row is None:
                return {"ok": False, "error": f"Bug pattern '{clean_slug}' not found"}

            new_details = row["details"]
            if clean_note:
                new_details = f"{new_details}\n[Graduated] {clean_note}".strip()

            conn.execute(
                "UPDATE bug_patterns SET status = 'graduated', test_ref = ?, details = ?, updated_at = ? WHERE slug = ?",
                (clean_ref, new_details, now, clean_slug),
            )

    return {
        "ok": True,
        "slug": clean_slug,
        "status": "graduated",
        "test_ref": clean_ref,
        "hits": int(row["hits"]),
    }


def remove_bug_pattern(
    slug: str,
    location: str | None = None,
    reason: str = "",
    db_path: str | None = None,
) -> dict[str, Any]:
    clean_slug, err = _validate_slug(slug)
    if err or clean_slug is None:
        return {"ok": False, "error": err or "Invalid slug"}

    clean_loc: str | None = None
    if location is not None:
        clean_loc = location.strip() if isinstance(location, str) else ""
        if not clean_loc:
            return {"ok": False, "error": "Invalid location: must be a non-empty string when provided"}

    clean_reason = reason.strip()[:300] if isinstance(reason, str) else ""
    now = _utc_now()

    with closing(_connect(db_path)) as conn:
        with _write_tx(conn):
            row = conn.execute(
                "SELECT slug, status FROM bug_patterns WHERE slug = ?",
                (clean_slug,),
            ).fetchone()
            if row is None:
                return {"ok": False, "error": f"Bug pattern '{clean_slug}' not found"}

            if clean_loc is None:
                conn.execute("DELETE FROM bug_patterns WHERE slug = ?", (clean_slug,))
                res: dict[str, Any] = {
                    "ok": True,
                    "removed": "pattern",
                    "slug": clean_slug,
                    "remaining_hits": 0,
                }
                if clean_reason:
                    res["reason"] = clean_reason
                return res

            cur = conn.execute(
                "DELETE FROM bug_occurrences WHERE pattern_slug = ? AND location = ?",
                (clean_slug, clean_loc),
            )
            if cur.rowcount == 0:
                return {"ok": False, "error": f"Occurrence '{clean_loc}' not found under '{clean_slug}'"}

            stats = conn.execute(
                "SELECT COALESCE(SUM(occurrence_count), 0) AS total_hits, COUNT(*) AS loc_count "
                "FROM bug_occurrences WHERE pattern_slug = ?",
                (clean_slug,),
            ).fetchone()
            remaining_hits = int(stats["total_hits"])
            loc_count = int(stats["loc_count"])

            if loc_count == 0:
                conn.execute("DELETE FROM bug_patterns WHERE slug = ?", (clean_slug,))
                res = {
                    "ok": True,
                    "removed": "pattern",
                    "slug": clean_slug,
                    "location": clean_loc,
                    "remaining_hits": 0,
                }
                if clean_reason:
                    res["reason"] = clean_reason
                return res

            new_status = row["status"]
            if new_status != "graduated":
                new_status = "promote_candidate" if remaining_hits >= PROMOTE_THRESHOLD else "watching"

            conn.execute(
                "UPDATE bug_patterns SET hits = ?, status = ?, updated_at = ? WHERE slug = ?",
                (remaining_hits, new_status, now, clean_slug),
            )
            res = {
                "ok": True,
                "removed": "occurrence",
                "slug": clean_slug,
                "location": clean_loc,
                "remaining_hits": remaining_hits,
                "remaining_locations": loc_count,
                "status": new_status,
            }
            if clean_reason:
                res["reason"] = clean_reason
            return res
