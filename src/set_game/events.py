"""Socket.IO event handlers: translate client actions into `Game` calls
and broadcast the results. This module owns no game rules itself -- see
`game.py` for those -- it only does transport plumbing:

  * mapping a socket session id (sid) to (room_code, player_id)
  * calling into `Game` under its lock
  * broadcasting the resulting events to the right Socket.IO room
  * scheduling the server-authoritative expiry watches for the buzz
    window, per-player lockouts, and the shared set-reveal freeze

Every handler holds `game.lock` across its whole "decide, mutate, build
the broadcast payload" span (see the concurrency note in game.py) -- with
"threading" async mode, two players' actions in the same room run on real
OS threads and can genuinely interleave. Emitting while holding the lock
is fine: Socket.IO emits just queue onto a buffer, they don't block on a
client round trip, so lock hold time stays negligible.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time
from collections import deque
from typing import Protocol, cast

from flask import request
from flask_socketio import emit
from flask_socketio import join_room as sio_join_room

from .app import socketio
from .game import BUZZ_SECONDS, SELECTION_PREVIEW_SECONDS, Game, Phase
from .rooms import is_valid_room_code, registry

MIN_PLAYERS_TO_START = 2
REAPER_INTERVAL_SECONDS = 5
# A just-created room has no players yet (the creator seats themselves a
# moment later, after their client redirects to /room/<code>). Give a
# freshly created room this much grace before the reaper is allowed to
# collect it for being empty, so a slow redirect doesn't race the reaper.
ROOM_CREATION_GRACE_SECONDS = REAPER_INTERVAL_SECONDS * 2

# sid -> (room_code, player_id), so disconnect handlers know who left
# without the client having to tell us (it can't, once it's gone).
_sid_index: dict[str, tuple[str, str]] = {}
# Serializes membership changes across the sid index and the corresponding
# Game player record. Without one lock spanning both, a reconnect can attach
# a new socket between the old socket's index removal and disconnect update,
# causing the old handler to mark the newly reconnected player offline.
_membership_lock = threading.RLock()
_reaper_lock = threading.Lock()
_reaper_started = False
# A tiny in-process guard against accidental key-repeat and abusive clients.
# It limits only mutating game events; normal reconnect/recovery traffic is
# unaffected and no cross-room/global lock is held while game logic runs.
_action_rate_lock = threading.Lock()
_action_windows: dict[str, deque[float]] = {}
MAX_MUTATIONS_PER_SECOND = 30


class _SocketIORequest(Protocol):
    sid: str


def _request_sid() -> str:
    """Return Flask-SocketIO's request-scoped session identifier."""
    return cast(_SocketIORequest, request).sid


def _now() -> float:
    return time.monotonic()


def _socketio_sleep(seconds: float) -> None:
    """Sleep through Socket.IO; its third-party stub incorrectly requires int."""
    socketio.sleep(seconds)  # type: ignore[arg-type]


PLAYER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
PLAYER_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def _text_field(data: object, key: str) -> str:
    """Return a stripped string field from an untrusted event payload."""
    if not isinstance(data, dict):
        return ""
    value = data.get(key)
    return value.strip() if isinstance(value, str) else ""


def _valid_name(name: str) -> bool:
    return 1 <= len(name) <= 20 and all(
        char.isprintable() and char not in "\r\n\t" for char in name
    )


def _credential_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _allow_mutation(sid: str) -> bool:
    now = _now()
    with _action_rate_lock:
        window = _action_windows.setdefault(sid, deque())
        while window and window[0] <= now - 1:
            window.popleft()
        if len(window) >= MAX_MUTATIONS_PER_SECOND:
            return False
        window.append(now)
        return True


def _players_payload(game: Game, now: float) -> dict:
    return {
        "players": [p.to_dict(now) for p in game.players.values()],
        "winner_ids": list(game.winner_ids),
        "no_set_vote": {
            "voters": sorted(game.no_set_votes),
            "needed": game.no_set_votes_needed(),
        },
    }


def _emit_players_updated(game: Game, now: float) -> None:
    """Broadcast membership/score metadata without re-sending the board."""
    with game.lock:
        payload = _players_payload(game, now)
    socketio.emit("players_updated", payload, to=game.room_code)


def _broadcast_state(game: Game) -> None:
    """Use only for phase transitions that require a fresh board snapshot."""
    with game.lock:
        payload = game.snapshot(_now())
    socketio.emit("room_state", payload, to=game.room_code)


def _error(message: str) -> None:
    emit("action_error", {"message": message})


def _mutation_allowed() -> bool:
    if _allow_mutation(_request_sid()):
        return True
    _error("Too many actions. Please slow down.")
    return False


def _card(code: int) -> dict:
    from .deck import Card

    return Card.from_code(code).to_dict()


def _emit_no_set_vote(
    game: Game, now: float, *, player_id: str | None = None, voted: bool | None = None
) -> None:
    socketio.emit(
        "no_set_vote",
        {
            "voters": sorted(game.no_set_votes),
            "needed": game.no_set_votes_needed(),
            "player_id": player_id,
            "voted": voted,
        },
        to=game.room_code,
    )


def _emit_no_set_pass(
    game: Game, now: float, board_before: list[int], result: str
) -> None:
    """Emits the follow-up event for a no-set vote that just went unanimous
    -- shared by the direct vote handler and the "settle" re-check below."""
    if result == "passed-dealt":
        added = [c for c in game.board if c not in board_before]
        socketio.emit(
            "cards_dealt",
            {
                "board": [_card(c) for c in game.board],
                "added": added,
                "deck_remaining": len(game.deck_remaining),
                "players": [p.to_dict(now) for p in game.players.values()],
            },
            to=game.room_code,
        )
    elif result == "passed-game-over":
        socketio.emit("game_over", game.snapshot(now), to=game.room_code)


def _settle_no_set_vote(game: Game, now: float) -> None:
    """Re-check a pending no-set vote after something that unblocks it just
    happened without the vote itself changing -- a voter disconnected
    (shrinking the electorate) or an active buzz/reveal window just ended
    (votes are blocked while one is in progress). No-op unless a vote is
    actually pending and has now become unanimous."""
    with game.lock:
        board_before = list(game.board)
        result = game.recheck_no_set_vote(now)
        if result:
            _emit_no_set_vote(game, now)
            _emit_no_set_pass(game, now, board_before, result)


# --- private room membership -------------------------------------------


@socketio.on("create_room")
def on_create_room(data):
    # The name is retained in the event for backwards-compatible clients,
    # but creating a private room does not publish or reserve a public seat.
    name = _text_field(data, "name")
    if not _valid_name(name):
        return _error("Enter a nickname using up to 20 printable characters.")
    game = registry.create_room()
    emit("room_created", {"room_code": game.room_code})


@socketio.on("join_room")
def on_join_room(data):
    room_code = _text_field(data, "room_code").upper()
    name = _text_field(data, "name")
    player_id = _text_field(data, "player_id")
    player_token = _text_field(data, "player_token")

    if not _valid_name(name):
        return _error("Enter a nickname using up to 20 printable characters.")
    if not PLAYER_ID_RE.fullmatch(player_id) or not PLAYER_TOKEN_RE.fullmatch(
        player_token
    ):
        return _error("Invalid player credentials. Refresh the page and try again.")
    if not is_valid_room_code(room_code):
        return _error("That invite code is invalid.")

    game = registry.get(room_code)
    if not game:
        return _error("This private game no longer exists.")

    auth_digest = _credential_digest(player_token)
    sid = _request_sid()
    with _membership_lock:
        with game.lock:
            existing = game.players.get(player_id)
            if game.is_blocked(auth_digest):
                return _error("You were removed from this game by its host.")
            if existing and not hmac.compare_digest(existing.auth_digest, auth_digest):
                return _error("This player seat belongs to another browser.")
            if not existing and len(game.players) >= 8:
                return _error("This game already has 8 players.")
            # A duplicated tab can carry the same private credentials.
            # Retire its older socket before attaching the new one; otherwise
            # that stale socket's later disconnect would mark the newly
            # connected player offline (and could even forfeit their buzz).
            previous_sid = existing.sid if existing and existing.connected else None
            game.add_player(player_id, sid, name, auth_digest)
            snapshot = game.snapshot(_now())
        if previous_sid and previous_sid != sid:
            _sid_index.pop(previous_sid, None)
            socketio.server.disconnect(previous_sid, namespace="/")
        _sid_index[sid] = (game.room_code, player_id)
    sio_join_room(game.room_code)

    emit("joined", {"player_id": player_id, "room_code": game.room_code})
    # A joining browser needs a complete recovery snapshot, but existing
    # players only need the small player-list delta; do not re-send a board
    # of card dictionaries to every participant on routine joins.
    emit("room_state", snapshot)
    _emit_players_updated(game, _now())


@socketio.on("disconnect")
def on_disconnect():
    sid = _request_sid()
    with _action_rate_lock:
        _action_windows.pop(sid, None)
    with _membership_lock:
        entry = _sid_index.pop(sid, None)
        if not entry:
            return
        room_code, player_id = entry
        game = registry.get(room_code)
        if not game:
            return

        now = _now()
        with game.lock:
            was_buzzing = bool(game.buzz and game.buzz.player_id == player_id)
            lockout_deadline = game.mark_disconnected(player_id, now)

    _emit_players_updated(game, now)
    if was_buzzing:
        # mark_disconnected() clears the buzz same as any other forfeit;
        # emit the granular state transition rather than re-sending a board.
        socketio.emit("buzz_ended", {}, to=room_code)
    if lockout_deadline is not None:
        socketio.start_background_task(
            _watch_lockout, room_code, player_id, lockout_deadline
        )
    # mark_disconnected() already dropped this player's own vote; the
    # departure may also have shrunk the electorate enough to make a
    # still-pending vote from the remaining players unanimous.
    _settle_no_set_vote(game, now)


@socketio.on("kick_player")
def on_kick_player(data):
    """Allow the current host to permanently remove another room identity."""
    if not _mutation_allowed():
        return
    sid = _request_sid()
    found = _require_room(sid)
    if not found:
        return
    game, host_id = found
    target_id = _text_field(data, "player_id")
    if not PLAYER_ID_RE.fullmatch(target_id):
        return _error("Invalid player.")
    if target_id == host_id:
        return _error("The host cannot remove themselves.")

    with _membership_lock:
        # Re-check membership while holding the same lock used by reconnect
        # and disconnect, so a stale host socket cannot kick after it lost
        # its seat to a newer tab.
        if _sid_index.get(sid) != (game.room_code, host_id):
            return _error("You are no longer in this game.")
        with game.lock:
            host = game.players.get(host_id)
            target = game.players.get(target_id)
            if not host or not host.is_host:
                return _error("Only the host can remove players.")
            if not target:
                return _error("That player is no longer in this game.")
            target_sid = target.sid if target.connected else None
            was_buzzing = bool(game.buzz and game.buzz.player_id == target_id)
            game.remove_player(target_id)
        if target_sid:
            _sid_index.pop(target_sid, None)

    if target_sid:
        socketio.emit(
            "removed_from_room",
            {"message": "You were removed by the host."},
            to=target_sid,
        )
        socketio.server.disconnect(target_sid, namespace="/")
    _emit_players_updated(game, _now())
    if was_buzzing:
        socketio.emit("buzz_ended", {}, to=game.room_code)
    _settle_no_set_vote(game, _now())


# --- game lifecycle --------------------------------------------------------


def _require_room(sid: str) -> tuple[Game, str] | None:
    with _membership_lock:
        entry = _sid_index.get(sid)
    if not entry:
        _error("You are not in a room.")
        return None
    room_code, player_id = entry
    game = registry.get(room_code)
    if not game:
        _error("This room no longer exists.")
        return None
    return game, player_id


@socketio.on("start_game")
def on_start_game():
    if not _mutation_allowed():
        return
    found = _require_room(_request_sid())
    if not found:
        return
    game, player_id = found

    with game.lock:
        player = game.players.get(player_id)
        if not player or not player.is_host:
            return _error("Only the host can start the game.")
        if game.phase == Phase.PLAYING:
            return _error("Game already in progress.")
        if len(game.active_players()) < MIN_PLAYERS_TO_START:
            return _error(f"Need at least {MIN_PLAYERS_TO_START} players to start.")
        game.start()
        snapshot = game.snapshot(_now())

    socketio.emit("game_started", snapshot, to=game.room_code)


@socketio.on("play_again")
def on_play_again():
    if not _mutation_allowed():
        return
    found = _require_room(_request_sid())
    if not found:
        return
    game, player_id = found

    with game.lock:
        player = game.players.get(player_id)
        if not player or not player.is_host:
            return _error("Only the host can start a new match.")
        if game.phase != Phase.FINISHED:
            return _error("Current match hasn't finished yet.")
        game.reset_to_lobby()

    _broadcast_state(game)


# --- buzz / selection -----------------------------------------------------


@socketio.on("buzz")
def on_buzz():
    if not _mutation_allowed():
        return
    found = _require_room(_request_sid())
    if not found:
        return
    game, player_id = found
    now = _now()

    with game.lock:
        reason = game.can_buzz(player_id, now)
        if reason:
            return _error(f"Can't buzz: {reason}.")
        buzz = game.start_buzz(player_id, now)
        player_name = game.players[player_id].name

    socketio.emit(
        "buzz_started",
        {
            "player_id": player_id,
            "name": player_name,
            "remaining_ms": int(BUZZ_SECONDS * 1000),
            "duration_ms": int(BUZZ_SECONDS * 1000),
        },
        to=game.room_code,
    )
    socketio.start_background_task(
        _watch_buzz_timeout, game.room_code, player_id, buzz.deadline
    )


def _watch_buzz_timeout(room_code: str, player_id: str, deadline: float) -> None:
    delay = max(0.0, deadline - _now())
    _socketio_sleep(delay)  # deliberately outside any lock -- this is a real wait
    game = registry.get(room_code)
    if not game:
        return

    lockout_deadline = None
    with game.lock:
        now = _now()
        acted = game.expire_buzz(deadline, now)
        if acted:
            players_payload = [p.to_dict(now) for p in game.players.values()]
            p = game.players.get(player_id)
            lockout_deadline = p.lockout_until if p else None

    if acted:
        socketio.emit(
            "set_rejected",
            {"player_id": player_id, "reason": "timeout", "players": players_payload},
            to=room_code,
        )
        socketio.emit("buzz_ended", {}, to=room_code)
        if lockout_deadline is not None:
            socketio.start_background_task(
                _watch_lockout, room_code, player_id, lockout_deadline
            )
        # The buzz that was blocking any pending no-set vote just ended.
        _settle_no_set_vote(game, _now())


def _watch_lockout(room_code: str, player_id: str, deadline: float) -> None:
    """Announces when a player's penalty cooldown has actually expired.

    Without this, clients have no push notification that a lockout is
    over -- they'd only find out on some unrelated broadcast (another
    player's turn, a reconnect), which is the root cause of the button
    getting stuck on "Cooling down..." indefinitely. `expire_lockout`
    re-checks the deadline is still current, so a lockout that was
    superseded by a second offense before this timer fired is a no-op
    here (the later timer will announce it instead).
    """
    delay = max(0.0, deadline - _now())
    _socketio_sleep(delay)
    game = registry.get(room_code)
    if not game:
        return

    with game.lock:
        now = _now()
        acted = game.expire_lockout(player_id, deadline, now)
        if acted:
            players_payload = [p.to_dict(now) for p in game.players.values()]

    if acted:
        socketio.emit(
            "cooldown_ended",
            {"player_id": player_id, "players": players_payload},
            to=room_code,
        )


def _watch_reveal(room_code: str, deadline: float) -> None:
    """Announces when the shared set-reveal freeze has ended, so every
    client (finder included) re-enables its buttons at the same instant."""
    delay = max(0.0, deadline - _now())
    _socketio_sleep(delay)
    game = registry.get(room_code)
    if not game:
        return

    with game.lock:
        now = _now()
        acted = game.expire_reveal(deadline, now)
        if acted:
            players_payload = [p.to_dict(now) for p in game.players.values()]

    if acted:
        socketio.emit("reveal_ended", {"players": players_payload}, to=room_code)


@socketio.on("select_card")
def on_select_card(data):
    if not _mutation_allowed():
        return
    found = _require_room(_request_sid())
    if not found:
        return
    game, player_id = found
    card_code = data.get("card") if isinstance(data, dict) else None
    if not isinstance(card_code, int) or isinstance(card_code, bool):
        return _error("Invalid card.")

    now = _now()
    preview_task = None
    with game.lock:
        original_deadline = game.buzz.deadline if game.buzz else None
        result = game.select(player_id, card_code, now, defer_resolution=True)

        if result in ("selected", "deselected", "selection-complete"):
            socketio.emit(
                "card_selected",
                {
                    "player_id": player_id,
                    "card": card_code,
                    "selected": result in ("selected", "selection-complete"),
                },
                to=game.room_code,
            )
            if result == "selection-complete":
                expected_cards = tuple(game.buzz.selection)
                replacement_deadline = (
                    game.buzz.deadline
                    if game.buzz.deadline != original_deadline
                    else None
                )
                preview_task = (
                    game.room_code,
                    player_id,
                    expected_cards,
                    replacement_deadline,
                )
        else:
            _error(f"Can't select: {result}.")

    if preview_task:
        room_code, preview_player_id, expected_cards, replacement_deadline = (
            preview_task
        )
        socketio.start_background_task(
            _resolve_selection_after_preview,
            room_code,
            preview_player_id,
            expected_cards,
        )
        # Selecting the third card may extend a nearly-expired buzz so the
        # preview can finish. Replace the stale original timeout watcher.
        if replacement_deadline is not None:
            socketio.start_background_task(
                _watch_buzz_timeout,
                room_code,
                preview_player_id,
                replacement_deadline,
            )


def _resolve_selection_after_preview(
    room_code: str,
    player_id: str,
    expected_cards: tuple[int, int, int],
) -> None:
    _socketio_sleep(SELECTION_PREVIEW_SECONDS)
    game = registry.get(room_code)
    if not game:
        return

    now = _now()
    with game.lock:
        board_before = list(game.board)
        result = game.resolve_selection(player_id, expected_cards, now)
        if result == "resolved-valid":
            removed = [c for c in board_before if c not in game.board]
            added = [c for c in game.board if c not in board_before]
            reveal_deadline = game.reveal_until
            payload = {
                "player_id": player_id,
                "removed": [_card(c) for c in removed],
                "added": [_card(c) for c in added],
                "board": [_card(c) for c in game.board],
                "deck_remaining": len(game.deck_remaining),
                "players": [p.to_dict(now) for p in game.players.values()],
                "reveal_ms": max(0, int((reveal_deadline - now) * 1000)),
            }
            game_over_payload = (
                game.snapshot(now) if game.phase == Phase.FINISHED else None
            )
        elif result == "resolved-invalid":
            lockout_deadline = game.players[player_id].lockout_until
            payload = {
                "player_id": player_id,
                "reason": "invalid",
                "players": [p.to_dict(now) for p in game.players.values()],
            }
        else:
            return

    if result == "resolved-valid":
        socketio.emit("set_claimed", payload, to=room_code)
        socketio.emit("buzz_ended", {}, to=room_code)
        if game_over_payload:
            socketio.emit("game_over", game_over_payload, to=room_code)
        if not game_over_payload:
            socketio.start_background_task(_watch_reveal, room_code, reveal_deadline)
    else:
        socketio.emit("set_rejected", payload, to=room_code)
        socketio.emit("buzz_ended", {}, to=room_code)
        socketio.start_background_task(
            _watch_lockout, room_code, player_id, lockout_deadline
        )
        # The buzz that was blocking any pending no-set vote just ended.
        # (The valid-set branch clears votes outright, so it needs no
        # equivalent -- there is nothing left to settle.)
        _settle_no_set_vote(game, _now())


@socketio.on("vote_no_set")
def on_vote_no_set():
    """Toggle the caller's vote that the board has no set. Once every
    active player has voted, 3 more cards are dealt (or the match ends if
    the deck is empty) -- see Game.toggle_no_set_vote for the rules."""
    if not _mutation_allowed():
        return
    found = _require_room(_request_sid())
    if not found:
        return
    game, player_id = found
    now = _now()

    with game.lock:
        board_before = list(game.board)
        result = game.toggle_no_set_vote(player_id, now)

        if result in ("voted", "unvoted"):
            _emit_no_set_vote(game, now, player_id=player_id, voted=result == "voted")
        elif result in ("passed-dealt", "passed-game-over"):
            _emit_no_set_vote(game, now, player_id=player_id, voted=True)
            _emit_no_set_pass(game, now, board_before, result)
        else:
            _error(f"Can't vote no-set: {result}.")


# --- background maintenance -------------------------------------------------


def start_background_reaper(sio) -> None:
    global _reaper_started
    with _reaper_lock:
        if _reaper_started:
            return
        _reaper_started = True

    def _loop():
        while True:
            sio.sleep(REAPER_INTERVAL_SECONDS)
            now = _now()
            for room_code in registry.all_room_codes():
                game = registry.get(room_code)
                if not game:
                    continue
                with game.lock:
                    removed = game.drop_stale_disconnects(now)
                    is_empty = (
                        not game.players
                        and (now - game.created_at) > ROOM_CREATION_GRACE_SECONDS
                    )
                if removed:
                    _emit_players_updated(game, now)
                if is_empty:
                    registry.remove(room_code)

    sio.start_background_task(_loop)
