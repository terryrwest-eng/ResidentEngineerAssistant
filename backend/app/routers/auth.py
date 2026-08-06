"""
Daily Reporter — Authentication Router

Registration is open, but a new account cannot sign in until an administrator
approves it. The first account to register becomes that administrator — there
has to be a way in before anyone exists to grant it.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.auth import create_access_token, require_admin, require_user
from app.services import auth_db
from app.services.migrate_to_multiuser import migrate_legacy_data_to

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class RoleRequest(BaseModel):
    role: str


@router.post("/auth/register", status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest) -> dict[str, Any]:
    """
    Create an account.

    Returns a token only for the first user, who is auto-approved. Everyone
    else must wait for an administrator, so there is no token to hand back.
    """
    try:
        user = auth_db.create_user(
            name=request.name, email=request.email, password=request.password
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if user['is_approved']:
        # This is the first account. Anything already in the storage root came
        # from the single-user version of the app, and belongs to whoever is
        # claiming it now — there is nobody else it could belong to, and this is
        # the only moment that is unambiguously true.
        migration = migrate_legacy_data_to(user['id'])
        if migration['moved']:
            logger.info(
                f"Adopted {len(migration['moved'])} existing items into {user['id']}"
            )
        return {
            'user': user,
            'token': create_access_token(user['id']),
            'message': 'Welcome — your account is the administrator for this app.',
            'migrated': migration['moved'],
            'migration_skipped': migration['skipped'] + migration['failed'],
        }

    return {
        'user': user,
        'token': None,
        'message': 'Account created. An administrator needs to approve it before you can sign in.',
    }


@router.post("/auth/login")
async def login(request: LoginRequest) -> dict[str, Any]:
    row = auth_db.get_user_by_email(request.email)

    # Same message whether the email is unknown or the password is wrong, so
    # the response cannot be used to discover which emails have accounts.
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail='Email or password is incorrect',
    )
    if row is None:
        raise invalid
    if not auth_db.verify_password(request.password, row['password_hash']):
        logger.info(f"Failed login for {request.email}")
        raise invalid

    if not row['is_approved']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='Your account is waiting for an administrator to approve it',
        )

    user = auth_db.get_user(row['id'])
    logger.info(f"Login: {row['email']}")
    return {'user': user, 'token': create_access_token(row['id'])}


@router.get("/auth/me")
async def get_me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """The signed-in user. Doubles as the token validity check on app start."""
    return user


@router.get("/auth/setup-state")
async def setup_state() -> dict[str, Any]:
    """
    Whether anybody has registered yet.

    Unauthenticated on purpose — the sign-in screen needs it before there is a
    token, to decide whether to present "create the first account" or a plain
    sign-in. It reveals only whether the app has been claimed, which anyone can
    infer by trying to register anyway.
    """
    return {'needs_first_user': auth_db.count_users() == 0}


@router.post("/auth/change-password")
async def change_password(
    request: ChangePasswordRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, str]:
    row = auth_db.get_user_by_email(user['email'])
    if row is None or not auth_db.verify_password(request.current_password, row['password_hash']):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Your current password is incorrect',
        )
    try:
        auth_db.change_password(user['id'], request.new_password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {'message': 'Password changed'}


# ============================================
# ADMIN
# ============================================

@router.get("/auth/users")
async def list_users(_: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    """Everyone, unapproved first — the approval queue is the point of it."""
    return auth_db.list_users()


@router.post("/auth/users/{user_id}/approve")
async def approve_user(
    user_id: str, _: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    user = auth_db.set_user_approval(user_id, True)
    if user is None:
        raise HTTPException(status_code=404, detail='No such user')
    return user


@router.post("/auth/users/{user_id}/revoke")
async def revoke_user(
    user_id: str, admin: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    """
    Withdraw access. Takes effect on the user's next request, not whenever
    their token expires, because approval is re-checked every time.
    """
    if user_id == admin['id']:
        raise HTTPException(status_code=400, detail='You cannot revoke your own access')
    if auth_db.count_admins(exclude_user_id=user_id) == 0:
        raise HTTPException(
            status_code=400,
            detail='That is the last administrator — promote someone else first',
        )
    user = auth_db.set_user_approval(user_id, False)
    if user is None:
        raise HTTPException(status_code=404, detail='No such user')
    return user


@router.post("/auth/users/{user_id}/role")
async def set_role(
    user_id: str, request: RoleRequest, admin: dict[str, Any] = Depends(require_admin)
) -> dict[str, Any]:
    if user_id == admin['id'] and request.role != 'admin':
        raise HTTPException(status_code=400, detail='You cannot demote yourself')
    try:
        user = auth_db.set_user_role(user_id, request.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if user is None:
        raise HTTPException(status_code=404, detail='No such user')
    return user


@router.delete("/auth/users/{user_id}")
async def delete_user(
    user_id: str, admin: dict[str, Any] = Depends(require_admin)
) -> dict[str, str]:
    """
    Delete an account. Their reports stay on disk — an accidental click here
    should not destroy someone's work.
    """
    if user_id == admin['id']:
        raise HTTPException(status_code=400, detail='You cannot delete your own account')
    if auth_db.count_admins(exclude_user_id=user_id) == 0:
        raise HTTPException(
            status_code=400,
            detail='That is the last administrator — promote someone else first',
        )
    if not auth_db.delete_user(user_id):
        raise HTTPException(status_code=404, detail='No such user')
    return {'message': 'Account deleted. Their data directory was left in place.'}
