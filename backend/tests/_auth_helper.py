"""
Shared test plumbing for a multi-user app.

Every data route now requires a signed-in user, and storage resolves inside that
user's directory. These verification scripts predate that, so rather than
threading tokens through each of them by hand, this gives them:

    client = authed_client(app)     — a TestClient that signs in and stays signed in
    with acting_as_test_user():     — for calling database functions directly

The user is created by registering the first account, which the app makes an
approved admin, so no approval step is needed in tests.
"""

import os
import tempfile
from typing import Any, Optional

from fastapi.testclient import TestClient


def use_scratch_storage(prefix: str = "rea-test-") -> str:
    """
    Point storage at a throwaway directory.

    MUST be called before importing app.main — app.core.paths reads the env var
    at import time, so a later call would be ignored and the test would write
    into real data.
    """
    root = tempfile.mkdtemp(prefix=prefix)
    os.environ["DAILY_REPORTER_DATA_DIR"] = root
    return root


class AuthedClient(TestClient):
    """A TestClient that attaches the signed-in user's token to every request."""

    def __init__(self, app, token: str, user: dict[str, Any], **kwargs):
        super().__init__(app, **kwargs)
        self.token = token
        self.user = user

    def request(self, method: str, url: str, **kwargs):  # type: ignore[override]
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("Authorization", f"Bearer {self.token}")
        return super().request(method, url, headers=headers, **kwargs)


def authed_client(
    app,
    name: str = "Test User",
    email: str = "test@example.com",
    password: str = "test-password-1234",
) -> AuthedClient:
    """
    Register the first account and return a client already signed in as it.

    The first account is auto-approved and made admin, so this works with no
    approval step. If the account already exists (a test importing the app
    twice), it signs in instead.
    """
    bootstrap = TestClient(app)
    r = bootstrap.post(
        "/api/auth/register", json={"name": name, "email": email, "password": password}
    )
    if r.status_code == 201 and r.json().get("token"):
        payload = r.json()
    else:
        r = bootstrap.post("/api/auth/login", json={"email": email, "password": password})
        r.raise_for_status()
        payload = r.json()

    # Pin the same user into the ambient context for the rest of the script.
    #
    # WHY: these scripts mix HTTP calls with direct calls into storage helpers
    # (get_report, settings _load/_save) to check what actually landed on disk.
    # Requests carry their own user, but a direct call has no request, and the
    # path layer refuses to guess. A test script runs as exactly one user, so
    # pinning it once here is both true and far less noise than wrapping every
    # assertion.
    #
    # This does NOT weaken what the routes enforce: require_user still runs on
    # every request and sets the context itself, so a route missing its
    # dependency still fails its own checks.
    from app.core.user_context import set_user_id
    set_user_id(payload["user"]["id"])

    return AuthedClient(app, token=payload["token"], user=payload["user"])


def acting_as_test_user(user_id: Optional[str] = None):
    """
    Context manager for calling storage functions directly, outside a request.

    Database helpers resolve paths from the request's user, and raise when there
    isn't one — that fail-closed behaviour is deliberate, so tests that bypass
    HTTP have to say who they are.
    """
    from app.core.user_context import acting_as
    return acting_as(user_id or "test-user")
