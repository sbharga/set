## What this is

A real-time multiplayer implementation of the card game SET (`DESCRIPTION.md` has the full rules), built with Flask + Flask-SocketIO. No frontend framework, no build step — vanilla JS and hand-written CSS served directly by Flask. Meant for local/LAN play among friends, not public deployment.

## Commands

```bash
uv sync              # install deps (Python >=3.12)
uv run python main.py    # run the server (defaults to 0.0.0.0:5000; override with SET_HOST/SET_PORT env vars)
uv run pytest         # run the full test suite
uv run pytest tests/test_game.py::test_invalid_set_penalizes_and_locks_out  # run a single test
```

There is no lint/format/typecheck command configured and no JS build step — templates and static files are served as-is.

Open `http://localhost:5000` in two or more browser tabs/windows to actually play. Game state is in-memory only; restarting the server clears all rooms.

## Architecture

### Backend layering

Strict one-way dependency chain, each layer transport/framework-agnostic from the one below it:

```
deck.py    — pure SET rule engine (cards as ints, is_set, find_any_set). No I/O, no Flask.
   ↑
game.py    — per-room state machine (Game/Player/Buzz dataclasses). Transport-agnostic:
             knows nothing about Socket.IO. Owns all game rules.
   ↑
events.py  — Socket.IO handlers. Translates client actions into Game method calls under
             game.lock, then broadcasts the resulting events. Owns no game rules itself.
   ↑
app.py     — Flask app factory + SocketIO singleton; registers events.py's handlers.
```

`rooms.py` sits beside `game.py`: an in-memory `RoomRegistry` (dict + lock) that creates/looks up/removes `Game` instances by room code. There is no database — the process's memory is the only store.

### Concurrency model

Flask-SocketIO runs in `async_mode="threading"` (real OS threads, not eventlet/gevent), so two players' actions in the same room can genuinely race. `Game.lock` is an `RLock` (not `Lock`, so a helper that re-enters the lock from an already-locked call path doesn't self-deadlock). Every handler in `events.py` holds `game.lock` across its whole "decide, mutate, build the broadcast payload" span — not just the mutation — so a snapshot built for broadcast is never torn mid-update.

### The three expiring-window pattern

There are three independent timed windows in the game, and all three follow the exact same pattern — understand one and you understand all three:

1. **Buzz window** (`BUZZ_SECONDS`, `Game.buzz.deadline`) — 10s for a buzzer to pick 3 cards.
2. **Per-player lockout** (`LOCKOUT_SECONDS`, `Player.lockout_until`) — 5s penalty cooldown after a wrong guess.
3. **Shared set-reveal freeze** (`SET_REVEAL_SECONDS`, `Game.reveal_until`) — 2.5s room-wide pause (blocks the finder too) after a valid set, so everyone watches the same reveal animation in sync.

Each stores an absolute deadline (`time.monotonic()`-based). Each has a `socketio.start_background_task` sleeper (`_watch_buzz_timeout` / `_watch_lockout` / `_watch_reveal` in `events.py`) that sleeps until the deadline **outside any lock**, then re-acquires `game.lock` and calls an `expire_*` method that re-validates the deadline is still current before acting. This stale-deadline guard (e.g. `Game.expire_lockout`) is what makes a late timer firing after the window was already superseded by a newer one a no-op — critical, since nothing else cancels these background tasks.

**The server is the sole source of truth for when a window ends** — it explicitly announces expiry (`buzz_ended`, `cooldown_ended`, `reveal_ended`), rather than clients guessing from a countdown. The client mirrors this with its own local ticking clock (`game.js`'s `ensureTicking`) computed from `performance.now()` + the server's relative `*_ms` fields, purely so the UI doesn't visually freeze between server broadcasts — but the server event, not the client timer, is what actually flips game state.

### State serialization

`Game.snapshot()` is the single serializer used for `room_state`, `game_started`, and `game_over` — every other event (`buzz_started`, `card_selected`, `set_claimed`, `set_rejected`, `cards_dealt`, `cooldown_ended`, `reveal_ended`) sends a smaller targeted payload instead of a full snapshot, and `game.js` merges those into its cached `latestSnapshot` rather than waiting for the next full one. When adding a new field to game state, decide deliberately whether it belongs in the full snapshot, a targeted event, or both.

### Cards as integers

A card is a single int 0–80 (`deck.py`). Read in base 3, its four digits are `(shape, color, number, shading)`. `is_set(a, b, c)` collapses to "each feature's digit-sum is a multiple of 3" — no branching per feature. Card dicts (`{code, shape, color, number, shading}`) are only materialized at the API boundary (`Card.to_dict()`), for the wire and for rendering.

### Frontend: vanilla JS, event-driven, no polling

Each page's controller (`static/js/game.js`, `home.js`) is a single `DOMContentLoaded` closure with no framework and no build step. All state changes arrive via Socket.IO push — there is no HTTP polling anywhere. Card rendering (`cards.js`) builds inline SVG referencing shared `<path>`/`<pattern>` defs in `base.html`'s `<defs>` block via `<use>`, so shape geometry and stripe patterns live in exactly one place. Default card colors are defined as CSS custom properties (`--card-red/green/purple` in `style.css`); the renderer keeps SVG attributes linked to those variables so browser-local palette overrides update existing cards live.

The board (`game.js`'s `syncBoard`) reconciles by diffing against existing DOM nodes keyed by `data-code`, not a full `innerHTML` wipe — this is what makes FLIP-style repositioning animation possible when the board recompacts after a claim. Any change to board rendering should preserve this keyed-reconciliation property.

Room codes exist only as the opaque `/room/<code>` URL path (so invite links work) — they are deliberately never rendered anywhere in the UI. Games are displayed and joined by title (`Game.title`, derived from the host's name), since this app targets small local/LAN groups, not public room browsing.

### Gotcha: `hidden` attribute vs. explicit `display`

Several views/sections are toggled via the DOM `hidden` property in JS. The browser's default `[hidden] { display: none }` UA rule loses to *any* page-authored rule that sets `display` on that same element, regardless of specificity — so any selector given an explicit `display` in `style.css` that is also toggled via `.hidden` in JS needs its own `.selector[hidden] { display: none; }` override (see `.game-view[hidden]`, `.rail-timer[hidden]`, `.reveal-overlay[hidden]`, `.modal-backdrop[hidden]` in `style.css`). Forgetting this override is a silent bug: the element stays laid out and visible underneath whatever should have replaced it.
