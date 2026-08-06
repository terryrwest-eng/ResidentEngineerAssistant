"""
Daily Reporter — who the current request belongs to.

WHY A CONTEXT VARIABLE

Every user's data lives under its own directory, so almost everything that
touches storage needs to know who is asking. Threading a user_id parameter
through ~90 endpoints and every function they call would mean ~66 path call
sites each growing an argument, and any one of them left behind is a silent
data leak between users.

Instead the authentication dependency records the caller here, once, and the
path layer reads it. A ContextVar (not a global) is what makes that safe under
async: each request runs in its own context, so two requests in flight never see
each other's user.

FAIL CLOSED

require_user_id() raises when nobody is set. That is deliberate and is the whole
safety argument for this design: if a route is ever added without the auth
dependency, it does not quietly fall back to a shared directory and serve one
user's reports to another — it raises, and the request fails with a 500 that
shows up immediately. A loud failure on an unprotected route is worth far more
than a convenient default.
"""

from contextvars import ContextVar
from typing import Optional

_current_user_id: ContextVar[Optional[str]] = ContextVar('current_user_id', default=None)


class NoUserInContext(RuntimeError):
    """Raised when storage is reached without an authenticated user."""


def set_user_id(user_id: str):
    """
    Record the user this request belongs to. Returns the token needed to undo
    it — callers outside a request (migrations, admin tasks) should reset.
    """
    return _current_user_id.set(user_id)


def reset_user_id(token) -> None:
    """Restore whatever user was set before the matching set_user_id call."""
    _current_user_id.reset(token)


def current_user_id() -> Optional[str]:
    """The current user, or None. Prefer require_user_id for storage access."""
    return _current_user_id.get()


def require_user_id() -> str:
    """
    The current user, or raise.

    Any code path that resolves a data directory goes through here, so an
    unauthenticated request cannot reach another user's files.
    """
    user_id = _current_user_id.get()
    if not user_id:
        raise NoUserInContext(
            'Storage was accessed with no authenticated user in context. '
            'The route is probably missing its authentication dependency.'
        )
    return user_id


class acting_as:
    """
    Run a block as a given user — for migrations, admin tooling and tests, which
    operate outside any request.

        with acting_as(user_id):
            save_report(...)
    """

    def __init__(self, user_id: str):
        self._user_id = user_id
        self._token = None

    def __enter__(self):
        self._token = set_user_id(self._user_id)
        return self

    def __exit__(self, *exc):
        if self._token is not None:
            reset_user_id(self._token)
        return False
