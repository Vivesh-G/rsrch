import time
from collections import deque
from typing import Dict, Deque


class RateLimitExceeded(Exception):
    """Raised when a caller exceeds the configured request rate."""


class ChatRateLimiter:
    """Sliding-window in-memory rate limiter per key with periodic sweep."""

    def __init__(self, limit: int, window_s: float):
        self.limit = limit
        self.window_s = window_s
        self._hits: Dict[str, Deque[float]] = {}
        self._last_sweep = 0.0

    def check(self, key: str) -> None:
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self.window_s:
            hits.popleft()

        if len(hits) >= self.limit:
            raise RateLimitExceeded("Too many chat requests, slow down")

        hits.append(now)

        if now - self._last_sweep > self.window_s:
            self._last_sweep = now
            for other_key in list(self._hits):
                if other_key == key:
                    continue
                q = self._hits[other_key]
                while q and now - q[0] > self.window_s:
                    q.popleft()
                if not q:
                    del self._hits[other_key]

    def drop(self, key: str) -> None:
        self._hits.pop(key, None)
