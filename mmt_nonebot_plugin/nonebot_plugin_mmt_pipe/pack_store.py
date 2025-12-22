from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from threading import Lock
from typing import Optional


class PackStoreError(RuntimeError):
    pass


_PACK_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")


def validate_pack_id(pack_id: str) -> str:
    s = (pack_id or "").strip()
    if not _PACK_ID_RE.match(s):
        raise PackStoreError("invalid pack_id: only [A-Za-z0-9_]")
    return s


class EulaDB:
    """
    Stores per-user acceptance for pack EULAs.
    """

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS pack_eula_accept ("
            "user_id TEXT NOT NULL,"
            "pack_id TEXT NOT NULL,"
            "accepted_at INTEGER NOT NULL,"
            "PRIMARY KEY(user_id, pack_id)"
            ")"
        )
        self._conn.commit()

    def accept(self, *, user_id: str, pack_id: str) -> None:
        uid = (user_id or "").strip()
        if not uid:
            raise PackStoreError("missing user_id")
        pid = validate_pack_id(pack_id)
        ts = int(time.time())
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO pack_eula_accept(user_id, pack_id, accepted_at) VALUES (?, ?, ?)",
                (uid, pid, ts),
            )
            self._conn.commit()

    def is_accepted(self, *, user_id: str, pack_id: str) -> bool:
        uid = (user_id or "").strip()
        if not uid:
            return False
        pid = (pack_id or "").strip()
        if not pid:
            return False
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM pack_eula_accept WHERE user_id = ? AND pack_id = ? LIMIT 1",
                (uid, pid),
            )
            return cur.fetchone() is not None

    def accepted_at(self, *, user_id: str, pack_id: str) -> Optional[int]:
        uid = (user_id or "").strip()
        pid = (pack_id or "").strip()
        if not uid or not pid:
            return None
        with self._lock:
            cur = self._conn.execute(
                "SELECT accepted_at FROM pack_eula_accept WHERE user_id = ? AND pack_id = ? LIMIT 1",
                (uid, pid),
            )
            row = cur.fetchone()
        if not row:
            return None
        return int(row[0])

