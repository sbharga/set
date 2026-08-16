"""Flask app factory and process entry point."""

from __future__ import annotations

import os
import secrets

from flask import Flask, abort, render_template
from flask_socketio import SocketIO
from werkzeug.middleware.proxy_fix import ProxyFix

from .rooms import is_valid_room_code

# "threading" needs no extra dependency (Werkzeug's dev server + the
# simple-websocket package Flask-SocketIO already pulls in) and, unlike
# eventlet, isn't deprecated. Real OS threads mean Game state mutations
# need explicit locking -- see the concurrency note in game.py.
# `None` accepts only same-origin Socket.IO requests. Render terminates TLS
# before the app; ProxyFix below restores the original scheme/host safely.
socketio = SocketIO(async_mode="threading", cors_allowed_origins=None)


def create_app() -> Flask:
    app = Flask(__name__)
    production = os.environ.get("SET_ENV") == "production"
    secret_key = os.environ.get("SECRET_KEY")
    if production and not secret_key:
        raise RuntimeError("SECRET_KEY must be set when SET_ENV=production")
    # Flask sessions are not used for player identity, but a random key still
    # prevents accidental reuse of the old public development secret.
    app.config["SECRET_KEY"] = secret_key or secrets.token_urlsafe(32)
    # Only trust forwarded headers when deployed behind Render's proxy; doing
    # so for a directly exposed development server would trust client input.
    if production:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    socketio.init_app(app)

    @app.after_request
    def security_headers(response):
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        )
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response

    # Importing registers the Socket.IO event handlers on `socketio`.
    from . import events  # noqa: F401

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/room/<room_code>")
    def room(room_code: str):
        room_code = room_code.upper()
        if not is_valid_room_code(room_code):
            abort(404)
        return render_template("room.html", room_code=room_code)

    events.start_background_reaper(socketio)

    return app


def run(host: str | None = None, port: int | None = None) -> None:
    if os.environ.get("SET_ENV") == "production":
        raise RuntimeError("Use the configured Gunicorn command in production, not main.py.")
    host = host if host is not None else os.environ.get("SET_HOST", "0.0.0.0")
    port = port if port is not None else int(os.environ.get("SET_PORT", "5000"))
    app = create_app()
    # This path is for local development. Render uses Gunicorn with one
    # threaded worker so the in-memory registry is never split across workers.
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
