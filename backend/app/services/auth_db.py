"""
Daily Reporter — the identity store.

The one database that is not per-user. It answers "who are the users and what
are they allowed to do", which by definition cannot live inside any one user's
directory.

It holds nothing else. No reports, no settings, no trackers — those live in the
asking user's own database, which is what keeps them apart.
"""

import logging
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import bcrypt

from app.core.paths import AUTH_DB_PATH, ensure_root_dirs

logger = logging.getLogger(__name__)

# Bcrypt truncates silently at 72 bytes. Reject longer rather than accept a
# password where only the first 72 bytes are actually checked.
MAX_PASSWORD_BYTES = 72
MIN_PASSWORD_LENGTH = 8


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_schema_ready = False


def get_auth_connection() -> sqlite3.Connection:
    """
    Open the identity store, creating its schema the first time.

    Lazily rather than relying on the startup hook having run: the schema is
    what every query here depends on, and a connection that assumes somebody
    else created it fails confusingly (and differently under a test client,
    which does not run the lifespan). CREATE TABLE IF NOT EXISTS is idempotent,
    so the flag is only there to keep it off the hot path.
    """
    global _schema_ready
    if not _schema_ready:
        init_auth_database()
    conn = sqlite3.connect(AUTH_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn


def init_auth_database() -> None:
    """Create the identity store. Called on startup and on first use."""
    global _schema_ready
    ensure_root_dirs()
    conn = sqlite3.connect(AUTH_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_approved INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Email is the login handle, matched case-insensitively so
            -- "Terry@..." and "terry@..." cannot become two accounts.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
                ON users(lower(email));

            -- Signing secret for session tokens, generated once and kept so
            -- tokens survive a restart.
            CREATE TABLE IF NOT EXISTS auth_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        conn.commit()
        _schema_ready = True
        logger.info(f"Auth database initialized at {AUTH_DB_PATH}")
    finally:
        conn.close()


def get_or_create_secret() -> str:
    """
    The token signing key.

    Read from JWT_SECRET when set — on Railway that keeps tokens valid across
    redeploys even if the volume is replaced. Otherwise generated once and
    stored, so a restart does not log everybody out.
    """
    env_secret = os.environ.get("JWT_SECRET", "").strip()
    if env_secret:
        return env_secret

    conn = get_auth_connection()
    try:
        row = conn.execute("SELECT value FROM auth_config WHERE key = 'jwt_secret'").fetchone()
        if row:
            return row["value"]
        secret = secrets.token_urlsafe(48)
        conn.execute(
            "INSERT INTO auth_config (key, value) VALUES ('jwt_secret', ?)", (secret,)
        )
        conn.commit()
        logger.info("Generated a new token signing secret")
        return secret
    finally:
        conn.close()


# ============================================
# PASSWORDS
# ============================================

def hash_password(password: str) -> str:
    """
    Hash with bcrypt.

    Used directly rather than through passlib: passlib 1.7.4 reads
    bcrypt.__about__.__version__, which bcrypt 4.x removed, so every call logs
    an AttributeError traceback before recovering. Both are pinned in
    requirements; going straight to bcrypt drops a layer and the noise with it.
    """
    encoded = password.encode('utf-8')
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError(f'Password must be at most {MAX_PASSWORD_BYTES} bytes')
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    """Check a password. False on any malformed hash rather than raising."""
    try:
        encoded = password.encode('utf-8')
        if len(encoded) > MAX_PASSWORD_BYTES:
            return False
        return bcrypt.checkpw(encoded, password_hash.encode('utf-8'))
    except (ValueError, TypeError) as exc:
        logger.warning(f"Password check failed against a malformed hash: {exc}")
        return False


def validate_password(password: str) -> Optional[str]:
    """Return a complaint about the password, or None if it is acceptable."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f'Password must be at least {MIN_PASSWORD_LENGTH} characters'
    if len(password.encode('utf-8')) > MAX_PASSWORD_BYTES:
        return f'Password must be at most {MAX_PASSWORD_BYTES} bytes'
    return None


# ============================================
# USERS
# ============================================

def _row_to_user(row: sqlite3.Row) -> dict[str, Any]:
    """Shape a row for the API. Never includes the password hash."""
    return {
        'id': row['id'],
        'name': row['name'],
        'email': row['email'],
        'role': row['role'],
        'is_approved': bool(row['is_approved']),
        'created_at': row['created_at'],
    }


def count_users() -> int:
    conn = get_auth_connection()
    try:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()['n']
    finally:
        conn.close()


def create_user(name: str, email: str, password: str,
                role: str = 'user', is_approved: bool = False) -> dict[str, Any]:
    """
    Register a user. Raises ValueError if the email is taken.

    The FIRST user to register becomes an approved admin — somebody has to be
    able to approve everyone else, and there is no other way in. Every account
    after that starts unapproved.
    """
    complaint = validate_password(password)
    if complaint:
        raise ValueError(complaint)

    email = email.strip()
    if not email:
        raise ValueError('Email is required')
    if not name.strip():
        raise ValueError('Name is required')

    first_user = count_users() == 0
    if first_user:
        role, is_approved = 'admin', True

    user_id = str(uuid.uuid4())
    now = _now()
    conn = get_auth_connection()
    try:
        conn.execute(
            """INSERT INTO users
               (id, name, email, password_hash, role, is_approved, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (user_id, name.strip(), email, hash_password(password),
             role, 1 if is_approved else 0, now, now),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise ValueError('An account with that email already exists') from exc
    finally:
        conn.close()

    logger.info(f"Created user {user_id} ({email}) role={role} approved={is_approved}")
    return get_user(user_id)  # type: ignore[return-value]


def get_user(user_id: str) -> Optional[dict[str, Any]]:
    conn = get_auth_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row else None
    finally:
        conn.close()


def get_user_by_email(email: str) -> Optional[sqlite3.Row]:
    """The raw row, password hash included — for the login check only."""
    conn = get_auth_connection()
    try:
        return conn.execute(
            "SELECT * FROM users WHERE lower(email) = lower(?)", (email.strip(),)
        ).fetchone()
    finally:
        conn.close()


def list_users() -> list[dict[str, Any]]:
    conn = get_auth_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY is_approved ASC, created_at ASC"
        ).fetchall()
        return [_row_to_user(r) for r in rows]
    finally:
        conn.close()


def set_user_approval(user_id: str, approved: bool) -> Optional[dict[str, Any]]:
    conn = get_auth_connection()
    try:
        cur = conn.execute(
            "UPDATE users SET is_approved = ?, updated_at = ? WHERE id = ?",
            (1 if approved else 0, _now(), user_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
    finally:
        conn.close()
    logger.info(f"User {user_id} approval set to {approved}")
    return get_user(user_id)


def set_user_role(user_id: str, role: str) -> Optional[dict[str, Any]]:
    if role not in ('user', 'admin'):
        raise ValueError("Role must be 'user' or 'admin'")
    conn = get_auth_connection()
    try:
        cur = conn.execute(
            "UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
            (role, _now(), user_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
    finally:
        conn.close()
    return get_user(user_id)


def count_admins(exclude_user_id: str = '') -> int:
    """Approved admins, optionally ignoring one — used to refuse self-lockout."""
    conn = get_auth_connection()
    try:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM users "
            "WHERE role = 'admin' AND is_approved = 1 AND id != ?",
            (exclude_user_id,),
        ).fetchone()['n']
    finally:
        conn.close()


def change_password(user_id: str, new_password: str) -> bool:
    complaint = validate_password(new_password)
    if complaint:
        raise ValueError(complaint)
    conn = get_auth_connection()
    try:
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (hash_password(new_password), _now(), user_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_user(user_id: str) -> bool:
    """
    Remove an account. Their data directory is deliberately left on disk — an
    accidental delete should not destroy somebody's reports, and the directory
    can be reattached or removed by hand.
    """
    conn = get_auth_connection()
    try:
        cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        if cur.rowcount:
            logger.info(f"Deleted user {user_id} (data directory left in place)")
        return cur.rowcount > 0
    finally:
        conn.close()
