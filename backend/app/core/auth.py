"""
Daily Reporter — session tokens and the dependency that scopes a request.

require_user is the dependency every data route depends on. It does three
things, in this order:

  1. Validates the bearer token.
  2. Re-checks the account still exists and is still approved — so revoking
     somebody does not wait for their token to expire.
  3. Records them in the request context, which is what makes every path in
     app.core.paths resolve inside THAT user's directory.

Step 3 is the one that provides isolation. Everything downstream — reports,
settings, trackers, uploaded PDFs — follows from it without needing to know
about users at all.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.core.paths import ensure_user_dirs
from app.core.user_context import set_user_id
from app.services.auth_db import get_or_create_secret, get_user

logger = logging.getLogger(__name__)

ALGORITHM = 'HS256'
# Long-lived on purpose: this is used from a phone in the field, often with no
# signal, and being logged out mid-report on a job site is worse than the risk
# a shorter window buys back.
TOKEN_TTL_DAYS = 30

# auto_error=False so a missing header produces our own 401 with a useful
# message rather than FastAPI's bare "Not authenticated".
_bearer = HTTPBearer(auto_error=False)


def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        'sub': user_id,
        'iat': now,
        'exp': now + timedelta(days=TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, get_or_create_secret(), algorithm=ALGORITHM)


# A download handed to something that cannot send headers.
#
# On Android the export URL is opened in the SYSTEM BROWSER — Capacitor cannot
# download a blob inside its WebView, so the file has to go out to a different
# application entirely. That application has no access to this app's token, and
# window.open cannot attach an Authorization header, so a normal bearer token is
# useless for it.
#
# The answer is a token that survives being put in a URL: separate scope so it
# opens nothing but a download, and minutes rather than days of life, because a
# query string is the one place a credential reliably ends up in server logs and
# browser history.
DOWNLOAD_SCOPE = 'download'
DOWNLOAD_TOKEN_TTL_MINUTES = 5


def create_download_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        'sub': user_id,
        'scope': DOWNLOAD_SCOPE,
        'iat': now,
        'exp': now + timedelta(minutes=DOWNLOAD_TOKEN_TTL_MINUTES),
    }
    return jwt.encode(payload, get_or_create_secret(), algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[str]:
    """
    The user id inside a valid SESSION token, or None.

    A download token is deliberately refused here — it is scoped to fetching a
    file and must not be usable as a session, which is the whole reason it is
    safe to put in a URL.
    """
    try:
        payload = jwt.decode(token, get_or_create_secret(), algorithms=[ALGORITHM])
        if payload.get('scope') == DOWNLOAD_SCOPE:
            logger.debug("Refused a download token used as a session token")
            return None
        return payload.get('sub')
    except JWTError as exc:
        logger.debug(f"Rejected token: {exc}")
        return None


def decode_download_token(token: str) -> Optional[str]:
    """The user id inside a valid download token, or None."""
    try:
        payload = jwt.decode(token, get_or_create_secret(), algorithms=[ALGORITHM])
        if payload.get('scope') != DOWNLOAD_SCOPE:
            return None
        return payload.get('sub')
    except JWTError as exc:
        logger.debug(f"Rejected download token: {exc}")
        return None


# Users whose directories and tables this process has already set up. There is
# no single database to initialize at startup any more — a user's storage is
# created the first time they make an authenticated request. CREATE TABLE IF NOT
# EXISTS is idempotent, so this set is only an optimisation: it keeps the common
# case from opening the database twice on every request.
_storage_ready: set[str] = set()


def _ensure_storage_ready(user_id: str) -> None:
    if user_id in _storage_ready:
        return
    ensure_user_dirs(user_id)
    # Imported here rather than at module scope: database.py imports the path
    # helpers, which import this module's user context, and a top-level import
    # would close that circle.
    from app.services.database import init_database
    init_database()
    _storage_ready.add(user_id)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={'WWW-Authenticate': 'Bearer'},
    )


async def require_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict[str, Any]:
    """
    Authenticate the caller and scope the request to their storage.

    Depend on this from every route that touches data. Without it the path layer
    raises rather than guessing, so an unprotected route fails loudly instead of
    quietly reading somebody else's files.
    """
    if credentials is None or not credentials.credentials:
        raise _unauthorized('Sign in to continue')

    user_id = decode_access_token(credentials.credentials)
    if not user_id:
        raise _unauthorized('Your session has expired — sign in again')

    user = get_user(user_id)
    if not user:
        # Deleted since the token was issued.
        raise _unauthorized('That account no longer exists')
    if not user['is_approved']:
        # Checked on every request, so withdrawing approval takes effect at once
        # rather than whenever the token happens to expire.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Your account is waiting for approval',
        )

    set_user_id(user_id)
    _ensure_storage_ready(user_id)
    # Handy for logging and for routes that want the user without re-declaring
    # the dependency.
    request.state.user = user
    return user


async def require_user_or_download_token(
    request: Request,
    t: Optional[str] = Query(
        None,
        description='Short-lived download token, for fetches that cannot send headers',
    ),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict[str, Any]:
    """
    As require_user, but also accepts a download token in the query string.

    Only the export routes use this. It exists because Android hands the export
    URL to the system browser, which cannot send an Authorization header — see
    create_download_token. Everything else still requires a real session.
    """
    if credentials is not None and credentials.credentials:
        return await require_user(request, credentials)

    if not t:
        raise _unauthorized('Sign in to continue')

    user_id = decode_download_token(t)
    if not user_id:
        raise _unauthorized('That download link has expired — try exporting again')

    user = get_user(user_id)
    if not user:
        raise _unauthorized('That account no longer exists')
    if not user['is_approved']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Your account is waiting for approval',
        )

    set_user_id(user_id)
    _ensure_storage_ready(user_id)
    request.state.user = user
    return user


async def require_admin(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """As require_user, but refuses anyone who is not an admin."""
    if user.get('role') != 'admin':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='That action is restricted to administrators',
        )
    return user
