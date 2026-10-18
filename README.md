# SET — Versus Mode

A real-time multiplayer implementation of the card game SET, built with Flask and Socket.IO. Create a private game, share its invite link (or its 10-character code), and race to find sets with friends or an optional computer player. Rooms are never listed or discoverable from the home page.

## How it plays

The board is shared and there are no turns — everyone searches at once. See a set? Press **SET!** and the board locks to you alone for 10 seconds:

- Tap three cards — the third tap submits automatically.
- Correct → **+1 point**, the cards animate out and are replaced.
- Wrong, or time runs out → **−1 point** and a 5 second cooldown.
- Think there's no set on the board? Press **No SET here** to vote. Once every active player has voted, three more cards are dealt, or the match ends if the deck is empty. Voting never changes your score.

The match ends when the deck runs out and no set remains on the board. Most sets wins. Full rules (and the keyboard shortcuts: `space` to buzz, `N` for No Set, `M` to mute) are in the in-app "?" modal.

The host can add a **SET Bot** from the waiting room at easy, medium, or hard difficulty. Harder bots recognize sets more reliably and react faster. The bot occupies one of the room's eight seats, participates in scoring and no-set votes, and stays configured for rematches until the host removes it.

## Running it

```bash
uv sync
uv run python main.py
```

Then open <http://localhost:5000> in two or more browser tabs/windows to play. Rooms are held in memory, so restarting the server clears all games. A room accepts at most eight players; players joining after a match begins watch until the next match if capacity remains. Hosts can remove players. Since play is anonymous and invite links are not passcode-protected, a removed person can deliberately return as a new browser identity; removal prevents their current private identity from reclaiming its seat.

## Deploying

The app runs as a **single instance** on a Google Cloud e2-micro VM, behind a reverse proxy (Caddy) and Cloudflare. Cloudflare must have WebSockets enabled so Socket.IO can upgrade past polling. The proxy terminates TLS and forwards to Gunicorn on localhost.

```bash
uv sync --frozen --no-dev
uv run --frozen --no-dev gunicorn --worker-class gthread --workers 1 --threads 100 --bind 127.0.0.1:8000 'set_game.app:create_app()'
```

Required environment variables:

- `SET_ENV=production`
- `SECRET_KEY` — a generated secret; startup fails without it.
- `SET_TRUSTED_HOSTS=<your subdomain>`

The health check is `GET /healthz`.

The production command uses one threaded Gunicorn worker so all Socket.IO connections see the same in-memory rooms. Do not scale this service beyond one instance or Gunicorn worker without moving room state and Socket.IO coordination to shared infrastructure such as Redis. Games and invite links are intentionally ephemeral: deploys, restarts, and idle-room cleanup remove them.

## Quality checks

```bash
uv run ruff check main.py src tests
uv run ruff format --check main.py src tests
uv run mypy main.py src tests
uv run pytest
```

The tests cover the SET rule engine, game state machine, Socket.IO edge cases, and server CLI.

## Project layout

```
src/set_game/
  deck.py      # SET rule engine: cards, is_set, find_any_set
  bot.py       # computer-player difficulty profiles and decisions
  game.py      # per-room state machine: buzz, scoring, deck, board
  rooms.py     # in-memory private-room registry and secure invite codes
  app.py       # Flask app factory
  events.py    # Socket.IO event handlers
  templates/   # home page, room page, how-to-play modal
  static/      # CSS, and JS for cards, audio, and the game client
```
