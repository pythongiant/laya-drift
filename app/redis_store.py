"""Redis session store: password auth and db index come from the environment."""

from __future__ import annotations

import os
import secrets

import redis

SESSION_PREFIX = "session:"
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "86400"))


def redis_from_env() -> redis.Redis:
    """Build a client using REDIS_HOST/PORT/PASSWORD/DB (password enables AUTH)."""
    return redis.Redis(
        host=os.getenv("REDIS_HOST", "127.0.0.1"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        password=os.getenv("REDIS_PASSWORD") or None,
        db=int(os.getenv("REDIS_DB", "0")),
        decode_responses=True,
        socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "2")),
        socket_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "2")),
    )


def create_session(conn: redis.Redis, user: str) -> str:
    token = secrets.token_urlsafe(32)
    conn.set(f"{SESSION_PREFIX}{token}", user, ex=SESSION_TTL_SECONDS)
    return token


def get_session_user(conn: redis.Redis, token: str) -> str | None:
    return conn.get(f"{SESSION_PREFIX}{token}")


def delete_session(conn: redis.Redis, token: str) -> None:
    conn.delete(f"{SESSION_PREFIX}{token}")
