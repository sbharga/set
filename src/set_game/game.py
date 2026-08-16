"""One room's match: the buzz-and-lock state machine.

This module owns all game rules and is transport-agnostic -- it knows
nothing about Socket.IO or Flask. `events.py` translates client actions
into calls here and broadcasts the returned events.

Concurrency note: Flask-SocketIO's "threading" async mode handles each
connection on a real OS thread, so two players' actions in the same room
can genuinely race (e.g. two simultaneous buzzes). `Game.lock` guards
every state-mutating sequence; callers in `events.py` hold it across the
full "decide, mutate, read state back out" span, not just the mutation,
so a snapshot built for broadcast is never torn.

There are three independent expiring windows, each following the same
pattern: an absolute deadline is stored, a background task sleeps until
that deadline and then re-validates it under the lock before acting, so
a stale timer firing after the window already resolved (superseded by a
newer one) is a no-op.

  * `Buzz.deadline` -- the 10s window a buzzer has to pick 3 cards.
  * `Player.lockout_until` -- the 5s penalty cooldown after a wrong guess,
    per player.
  * `Game.reveal_until` -- the shared celebration/freeze after a valid
    set, room-wide (it blocks the finder too, not just everyone else).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from random import Random

from . import deck

BOARD_MIN = 12
BUZZ_SECONDS = 10.0
LOCKOUT_SECONDS = 5.0
SET_REVEAL_SECONDS = 2.5
SELECTION_PREVIEW_SECONDS = 0.55
RECONNECT_GRACE_SECONDS = 60.0
MAX_PLAYERS = 8


class Phase(str, Enum):
    LOBBY = "lobby"
    PLAYING = "playing"
    FINISHED = "finished"


@dataclass
class Player:
    player_id: str  # stable across reconnects (stored client-side)
    name: str
    # Digest of a per-room reconnect credential. This never crosses the
    # wire in snapshots, so another player cannot claim this seat merely by
    # knowing its public player id.
    auth_digest: str = ""
    sid: str | None = None  # current Socket.IO session id, None while disconnected
    score: int = 0
    connected: bool = True
    is_host: bool = False
    spectator: bool = False
    lockout_until: float = 0.0
    disconnected_at: float | None = None

    def to_dict(self, now: float) -> dict:
        return {
            "player_id": self.player_id,
            "name": self.name,
            "score": self.score,
            "connected": self.connected,
            "is_host": self.is_host,
            "spectator": self.spectator,
            "locked_out": self.lockout_until > now,
            "lockout_remaining_ms": max(0, int((self.lockout_until - now) * 1000)),
        }


@dataclass
class Buzz:
    player_id: str
    deadline: float
    selection: list[int] = field(default_factory=list)


@dataclass
class Game:
    room_code: str
    rng: Random = field(default_factory=Random)
    created_at: float = field(default_factory=time.monotonic)

    phase: Phase = Phase.LOBBY
    players: dict[str, Player] = field(default_factory=dict)  # player_id -> Player
    order: list[str] = field(default_factory=list)  # join order, for stable display

    deck_remaining: list[int] = field(default_factory=list)
    board: list[int | None] = field(default_factory=list)
    buzz: Buzz | None = None
    reveal_until: float = 0.0
    winner_ids: list[str] = field(default_factory=list)
    # Player ids who currently believe the board has no set. Room-level
    # (not per-Player) so it doesn't need to survive the wholesale player
    # replacement events.py's score broadcasts do client-side -- see the
    # "state serialization" note in CLAUDE.md. Cleared whenever the board
    # changes (a set is claimed, a vote passes) or the room resets.
    no_set_votes: set[str] = field(default_factory=set)
    # Credentials of identities removed by the host. This is intentionally
    # room-lifetime-only: anonymous users can otherwise create a fresh
    # identity, but a kicked tab cannot immediately reclaim its old seat.
    blocked_auth_digests: set[str] = field(default_factory=set, repr=False)

    # RLock (not Lock) so a helper that re-enters the lock from within an
    # already-locked call path -- e.g. a broadcast helper called while a
    # handler still holds it -- doesn't self-deadlock.
    lock: threading.RLock = field(default_factory=threading.RLock, compare=False, repr=False)

    # --- membership -------------------------------------------------

    @property
    def title(self) -> str:
        host = next((p for p in self.players.values() if p.is_host), None)
        return f"{host.name}'s Game" if host else "New Game"

    def add_player(self, player_id: str, sid: str, name: str, auth_digest: str = "") -> Player:
        if player_id in self.players:
            p = self.players[player_id]
            p.name = name
            p.sid = sid
            p.connected = True
            p.disconnected_at = None
            return p
        # Disconnected seats remain reserved during their reconnect grace
        # period, so a room can never exceed its advertised eight players.
        if len(self.players) >= MAX_PLAYERS:
            raise ValueError("room full")
        is_host = len(self.players) == 0
        # Games already in progress seat new joiners as spectators until
        # the next round; the lobby seats everyone as active players.
        spectator = self.phase != Phase.LOBBY
        p = Player(
            player_id=player_id,
            name=name,
            auth_digest=auth_digest,
            sid=sid,
            is_host=is_host,
            spectator=spectator,
        )
        self.players[player_id] = p
        self.order.append(player_id)
        return p

    def is_blocked(self, auth_digest: str) -> bool:
        return auth_digest in self.blocked_auth_digests

    def remove_player(self, player_id: str) -> Player | None:
        """Permanently remove a player at the host's request.

        Unlike a disconnect, removal does not retain a reconnecting seat or
        penalize a player who happened to hold the buzz. The caller owns the
        transport disconnect and any follow-up room broadcasts.
        """
        p = self.players.get(player_id)
        if not p:
            return None
        if self.buzz and self.buzz.player_id == player_id:
            self.buzz = None
        self.no_set_votes.discard(player_id)
        if p.auth_digest:
            self.blocked_auth_digests.add(p.auth_digest)
        del self.players[player_id]
        self.order.remove(player_id)
        if p.is_host:
            self._reassign_host()
        if self.phase == Phase.FINISHED:
            self._update_winners()
        return p

    def mark_disconnected(self, player_id: str, now: float) -> float | None:
        """Marks the player offline. If they were mid-buzz, penalizes them
        (same as any other forfeited buzz) and returns the resulting
        lockout deadline so the caller can schedule its expiry watch."""
        p = self.players.get(player_id)
        if not p:
            return None
        p.connected = False
        p.sid = None
        p.disconnected_at = now
        self.no_set_votes.discard(player_id)
        if p.is_host and self.phase == Phase.FINISHED:
            p.is_host = False
            self._reassign_host()
        if self.buzz and self.buzz.player_id == player_id:
            return self._penalize(player_id, now)
        return None

    def drop_stale_disconnects(self, now: float | None = None) -> list[str]:
        """Remove players who've been gone past the reconnect grace period.
        Returns the ids removed, so the caller can broadcast an update."""
        now = time.monotonic() if now is None else now
        removed = []
        # Keep finished-match participants in the standings while anyone is
        # still present to view them. Once everybody disconnects, normal
        # removal resumes so the room can be collected.
        preserve_standings = self.phase == Phase.FINISHED and any(
            p.connected for p in self.players.values()
        )
        for pid, p in list(self.players.items()):
            if (
                not p.connected
                and p.disconnected_at is not None
                and now - p.disconnected_at > RECONNECT_GRACE_SECONDS
            ):
                if preserve_standings and not p.spectator:
                    continue
                removed.append(pid)
                del self.players[pid]
                self.order.remove(pid)
                self.no_set_votes.discard(pid)
                if p.is_host:
                    self._reassign_host()
        return removed

    def _reassign_host(self) -> None:
        for pid in self.order:
            p = self.players.get(pid)
            if p and p.connected:
                p.is_host = True
                return

    def active_players(self) -> list[Player]:
        return [
            self.players[pid]
            for pid in self.order
            if pid in self.players
            and self.players[pid].connected
            and not self.players[pid].spectator
        ]

    # --- lifecycle ----------------------------------------------------

    def start(self) -> None:
        self.deck_remaining = deck.shuffled_deck(self.rng)
        self.board = []
        self._deal(BOARD_MIN)
        self.phase = Phase.PLAYING
        self.buzz = None
        self.reveal_until = 0.0
        self.winner_ids = []
        self.no_set_votes.clear()
        for p in self.players.values():
            p.score = 0
            p.lockout_until = 0.0
            # A player who disconnected from the lobby during the grace
            # period must not silently occupy a seat in the new match.
            p.spectator = not p.connected

    def reset_to_lobby(self) -> None:
        self.phase = Phase.LOBBY
        self.deck_remaining = []
        self.board = []
        self.buzz = None
        self.reveal_until = 0.0
        self.winner_ids = []
        self.no_set_votes.clear()
        for p in self.players.values():
            p.spectator = False
            p.lockout_until = 0.0

    def _deal(self, count: int) -> list[int]:
        dealt = []
        for _ in range(count):
            if not self.deck_remaining:
                break
            dealt.append(self.deck_remaining.pop())
        self.board.extend(dealt)
        return dealt

    # --- buzz / selection ----------------------------------------------

    def _can_act(self, player_id: str, now: float) -> str | None:
        """Shared eligibility checks for anything that touches the board
        (buzzing or voting no-set): known + connected player, mid-match,
        not a spectator, and not blocked by an active buzz or reveal
        freeze. Returns None if allowed, else a short reason string."""
        p = self.players.get(player_id)
        if not p or not p.connected:
            return "unknown player"
        if self.phase != Phase.PLAYING:
            return "game not in progress"
        if p.spectator:
            return "spectating"
        if self.reveal_until > now:
            return "revealing"
        if self.buzz is not None:
            return "already locked"
        return None

    def can_buzz(self, player_id: str, now: float) -> str | None:
        """Returns None if allowed, else a short reason string."""
        reason = self._can_act(player_id, now)
        if reason:
            return reason
        if self.players[player_id].lockout_until > now:
            return "locked out"
        return None

    def start_buzz(self, player_id: str, now: float) -> Buzz:
        self.buzz = Buzz(player_id=player_id, deadline=now + BUZZ_SECONDS)
        return self.buzz

    def select(self, player_id: str, card_code: int, now: float, *, defer_resolution: bool = False) -> str:
        """Toggle a card in the active buzzer's selection.

        Returns one of: "selected", "deselected", "selection-complete",
        "resolved-valid", "resolved-invalid", or a rejection reason.
        """
        if not self.buzz or self.buzz.player_id != player_id:
            return "not your buzz"
        if now > self.buzz.deadline:
            return "expired"
        if card_code not in self.board:
            return "card not on board"

        if len(self.buzz.selection) >= 3:
            return "selection pending"

        if card_code in self.buzz.selection:
            self.buzz.selection.remove(card_code)
            return "deselected"

        self.buzz.selection.append(card_code)
        if len(self.buzz.selection) < 3:
            return "selected"

        if defer_resolution:
            # Keep the board locked long enough for every client to paint
            # the third highlight before the verdict animation replaces it.
            self.buzz.deadline = max(
                self.buzz.deadline,
                now + SELECTION_PREVIEW_SECONDS + 0.25,
            )
            return "selection-complete"

        return self.resolve_selection(player_id, tuple(self.buzz.selection), now)

    def resolve_selection(self, player_id: str, expected_cards: tuple[int, int, int], now: float) -> str:
        """Resolve a deferred third-card selection if it is still current."""
        if not self.buzz or self.buzz.player_id != player_id:
            return "stale selection"
        if tuple(self.buzz.selection) != expected_cards:
            return "stale selection"

        a, b, c = expected_cards
        if deck.is_set(a, b, c):
            self._resolve_valid_set(player_id, (a, b, c), now)
            return "resolved-valid"
        else:
            self._penalize(player_id, now)
            return "resolved-invalid"

    def expire_buzz(self, expected_deadline: float, now: float) -> bool:
        """Called by the scheduled timeout task. Returns True if it acted
        (i.e. the buzz was still the same one that scheduled this expiry)."""
        if (
            not self.buzz
            or self.buzz.deadline != expected_deadline
            or now < expected_deadline
        ):
            return False  # already resolved or superseded
        pid = self.buzz.player_id
        self._penalize(pid, now)
        return True

    def expire_lockout(self, player_id: str, expected_deadline: float, now: float) -> bool:
        """Called by the scheduled lockout-expiry task. Returns True if this
        is still the lockout that scheduled it (i.e. the player hasn't since
        been penalized again with a later deadline), meaning it's safe to
        tell the room this player is free again."""
        p = self.players.get(player_id)
        if not p or p.lockout_until != expected_deadline or now < expected_deadline:
            return False
        p.lockout_until = 0.0
        return True

    def expire_reveal(self, expected_deadline: float, now: float) -> bool:
        """Called by the scheduled reveal-expiry task. Returns True if this
        is still the reveal window that scheduled it."""
        if self.reveal_until != expected_deadline or now < expected_deadline:
            return False
        self.reveal_until = 0.0
        return True

    def no_set_votes_needed(self) -> int:
        return len(self.active_players())

    def toggle_no_set_vote(self, player_id: str, now: float) -> str:
        """Toggle a player's vote that the board has no set.

        Voting isn't a claim -- it costs nothing and is never wrong, so
        (unlike `can_buzz`) a locked-out player may still vote. Once every
        active player has voted, 3 more cards are dealt (or, if the deck is
        empty, the match ends) regardless of whether a set actually exists
        -- the room's unanimous word is trusted rather than re-checked.

        Returns "voted", "unvoted", "passed-dealt", "passed-game-over", or
        a short rejection reason.
        """
        reason = self._can_act(player_id, now)
        if reason:
            return reason
        if player_id in self.no_set_votes:
            self.no_set_votes.discard(player_id)
            return "unvoted"
        self.no_set_votes.add(player_id)
        return self._resolve_no_set_vote() or "voted"

    def _resolve_no_set_vote(self) -> str | None:
        """Deals (or ends the match) iff every active player has voted.
        Returns None if the vote isn't unanimous yet."""
        active = self.active_players()
        if not active or any(p.player_id not in self.no_set_votes for p in active):
            return None
        self.no_set_votes.clear()
        if self.deck_remaining:
            self._deal(3)
            return "passed-dealt"
        # Deck empty and the room has collectively given up: match over.
        self._finish()
        return "passed-game-over"

    def recheck_no_set_vote(self, now: float) -> str | None:
        """Re-evaluate a pending vote after the electorate shrank (a voter
        disconnected) or a blocking window just closed (buzz/reveal ended).
        A no-op unless a vote is actually pending and now unanimous."""
        if self.phase != Phase.PLAYING or self.buzz is not None or self.reveal_until > now:
            return None
        if not self.no_set_votes:
            return None
        return self._resolve_no_set_vote()

    # --- resolution -----------------------------------------------------

    def _resolve_valid_set(self, player_id: str, cards: tuple[int, int, int], now: float) -> None:
        p = self.players[player_id]
        p.score += 1
        for card_code in cards:
            idx = self.board.index(card_code)
            self.board[idx] = None
        self.buzz = None
        # The board is about to change; any pending "no set" votes were
        # about the old board and no longer apply.
        self.no_set_votes.clear()
        # Room-wide freeze so everyone (finder included) watches the same
        # reveal animation before the next buzz is allowed.
        self.reveal_until = now + SET_REVEAL_SECONDS

        # Per the rules: only refill up to BOARD_MIN. Cards claimed while
        # the board is already above the minimum (15, 18...) are simply
        # removed, not replaced, until the count drops back to 12.
        gaps = self.board.count(None)
        base_len = len(self.board) - gaps
        if base_len < BOARD_MIN:
            need = min(gaps, BOARD_MIN - base_len)
            for _ in range(need):
                if not self.deck_remaining:
                    break
                idx = self.board.index(None)
                self.board[idx] = self.deck_remaining.pop()

        self.board = [c for c in self.board if c is not None]
        self._check_end()

    def _penalize(self, player_id: str, now: float) -> float | None:
        """Docks a point and starts that player's lockout. Returns the new
        lockout deadline (so the caller can schedule its expiry watch), or
        None if the player is no longer in the game."""
        self.buzz = None
        p = self.players.get(player_id)
        if not p:
            return None
        p.score -= 1
        p.lockout_until = now + LOCKOUT_SECONDS
        return p.lockout_until

    def _check_end(self) -> None:
        if not self.deck_remaining and deck.find_any_set(self.board) is None:
            self._finish()

    def _finish(self) -> None:
        self.phase = Phase.FINISHED
        self.buzz = None
        self.reveal_until = 0.0
        host = next((p for p in self.players.values() if p.is_host), None)
        if host and not host.connected:
            host.is_host = False
            self._reassign_host()
        self._update_winners()

    def _update_winners(self) -> None:
        participants = [(pid, p) for pid, p in self.players.items() if not p.spectator]
        if participants:
            top = max(p.score for _, p in participants)
            self.winner_ids = [pid for pid, p in participants if p.score == top]
        else:
            self.winner_ids = []

    # --- serialization ----------------------------------------------------

    def snapshot(self, now: float | None = None) -> dict:
        now = now if now is not None else time.monotonic()
        return {
            "room_code": self.room_code,
            "title": self.title,
            "phase": self.phase.value,
            "players": [self.players[pid].to_dict(now) for pid in self.order if pid in self.players],
            "board": [deck.Card.from_code(c).to_dict() for c in self.board],
            "deck_remaining": len(self.deck_remaining),
            "buzz": (
                {
                    "player_id": self.buzz.player_id,
                    # Monotonic clock has no meaningful epoch to share with
                    # the client, so send a relative countdown instead; the
                    # client runs its own local timer from this offset.
                    "remaining_ms": max(0, int((self.buzz.deadline - now) * 1000)),
                    "duration_ms": int(BUZZ_SECONDS * 1000),
                    "selection": list(self.buzz.selection),
                }
                if self.buzz
                else None
            ),
            "reveal_remaining_ms": max(0, int((self.reveal_until - now) * 1000)),
            "winner_ids": list(self.winner_ids),
            "no_set_vote": {
                "voters": sorted(self.no_set_votes),
                "needed": self.no_set_votes_needed(),
            },
        }
