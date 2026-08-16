"""In-memory registry of active rooms.

No database: rooms live for the life of the process. A `threading.Lock`
guards the dict itself (creation, removal, and any iteration over it) --
Flask-SocketIO's "threading" async mode handles connections on real OS
threads, so two requests can genuinely touch the dict at the same
instant. Mutating a single room's own state is a separate concern,
guarded by that `Game`'s own lock (see game.py).
"""

from __future__ import annotations

import secrets
import threading

from .game import Game

# Excludes visually ambiguous characters (0/O, 1/I/L) so codes are easy to
# read aloud or type from a phone screenshot.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 10


def is_valid_room_code(room_code: str) -> bool:
    return len(room_code) == CODE_LENGTH and all(
        char in CODE_ALPHABET for char in room_code
    )


class RoomRegistry:
    def __init__(self) -> None:
        self._rooms: dict[str, Game] = {}
        self._lock = threading.Lock()

    def _generate_code(self) -> str:
        # Room codes are invite credentials, so use the operating system's
        # cryptographically secure source rather than a predictable PRNG.
        return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))

    def create_room(self) -> Game:
        with self._lock:
            for _ in range(50):
                code = self._generate_code()
                if code not in self._rooms:
                    game = Game(room_code=code)
                    self._rooms[code] = game
                    return game
            raise RuntimeError("could not allocate a unique room code")

    def get(self, room_code: str) -> Game | None:
        with self._lock:
            return self._rooms.get(room_code.upper())

    def remove(self, room_code: str) -> None:
        with self._lock:
            self._rooms.pop(room_code.upper(), None)

    def active_rooms(self) -> list[Game]:
        with self._lock:
            return [g for g in self._rooms.values() if g.players]

    def all_room_codes(self) -> list[str]:
        with self._lock:
            return list(self._rooms.keys())


# Single process-wide registry; the app factory hands this to event handlers.
registry = RoomRegistry()
