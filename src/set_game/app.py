"""Flask app factory and process entry point."""

from __future__ import annotations

import hashlib
import os
import secrets
from functools import lru_cache

from flask import Flask, Response, abort, render_template, request, url_for
from flask_compress import Compress
from flask_socketio import SocketIO
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import safe_join

from .rooms import is_valid_room_code

# "threading" needs no extra dependency (Werkzeug's dev server + the
# simple-websocket package Flask-SocketIO already pulls in) and, unlike
# eventlet, isn't deprecated. Real OS threads mean Game state mutations
# need explicit locking -- see the concurrency note in game.py.
# `None` accepts only same-origin Socket.IO requests. Render terminates TLS
# before the app; ProxyFix below restores the original scheme/host safely.
# The app never uses `flask.session`, so Flask-SocketIO's per-event session
# wrapping is wasted work. No legitimate client message approaches 64 KB
# (the default limit is 1 MB).
socketio = SocketIO(
    async_mode="threading", manage_session=False, max_http_buffer_size=64 * 1024
)
compress = Compress()

STATIC_MAX_AGE_SECONDS = 31536000


@lru_cache(maxsize=256)
def _file_digest(path: str, mtime_ns: int, size: int) -> str:
    # mtime/size are part of the cache key so an edited file gets a new hash
    # without a restart (dev); production files never change.
    with open(path, "rb") as file:
        return hashlib.sha256(file.read()).hexdigest()[:12]


def create_app() -> Flask:
    app = Flask(__name__)

    def static_version(filename: str) -> str | None:
        assert app.static_folder
        path = safe_join(app.static_folder, filename)
        if path is None:
            return None
        try:
            stat = os.stat(path)
        except OSError:
            return None
        return _file_digest(path, stat.st_mtime_ns, stat.st_size)

    @app.url_defaults
    def version_static_urls(endpoint: str, values: dict) -> None:
        if endpoint == "static" and "filename" in values:
            version = static_version(values["filename"])
            if version:
                values["v"] = version

    production = os.environ.get("SET_ENV") == "production"
    secret_key = os.environ.get("SECRET_KEY")
    if production and not secret_key:
        raise RuntimeError("SECRET_KEY must be set when SET_ENV=production")
    # Flask sessions are not used for player identity, but a random key still
    # prevents accidental reuse of the old public development secret.
    app.config["SECRET_KEY"] = secret_key or secrets.token_urlsafe(32)
    trusted_hosts = os.environ.get("SET_TRUSTED_HOSTS")
    if trusted_hosts:
        app.config["TRUSTED_HOSTS"] = [
            host.strip() for host in trusted_hosts.split(",") if host.strip()
        ]
    # Only trust forwarded headers when deployed behind Render's proxy; doing
    # so for a directly exposed development server would trust client input.
    if production:
        # Flask documents this assignment, but its type declaration exposes
        # wsgi_app as a method rather than replaceable WSGI middleware.
        app.wsgi_app = ProxyFix(  # type: ignore[method-assign]
            app.wsgi_app, x_for=1, x_proto=1, x_host=1
        )

    compress.init_app(app)
    socketio.init_app(app)

    @app.after_request
    def cache_static_assets(response):
        # Only a request carrying the current content hash may be cached
        # forever; a missing/stale `v` keeps Flask's revalidating default.
        if request.endpoint == "static" and response.status_code in (200, 304):
            version = request.args.get("v")
            filename = (request.view_args or {}).get("filename", "")
            if version and version == static_version(filename):
                response.cache_control.no_cache = None
                response.cache_control.public = True
                response.cache_control.max_age = STATIC_MAX_AGE_SECONDS
                response.cache_control.immutable = True
        return response

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
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        if request.endpoint in {"room", "healthz"}:
            response.headers.setdefault("X-Robots-Tag", "noindex, nofollow, noarchive")
        if production and request.is_secure:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response

    # Importing registers the Socket.IO event handlers on `socketio`.
    from . import events

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/robots.txt")
    def robots():
        body = "\n".join(
            (
                "User-agent: *",
                "Allow: /",
                "Disallow: /room/",
                "Disallow: /healthz",
                f"Sitemap: {url_for('sitemap', _external=True)}",
                "",
            )
        )
        return Response(body, mimetype="text/plain")

    @app.get("/sitemap.xml")
    def sitemap():
        return Response(render_template("sitemap.xml"), mimetype="application/xml")

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
        raise RuntimeError(
            "Use the configured Gunicorn command in production, not main.py."
        )
    host = host if host is not None else os.environ.get("SET_HOST", "0.0.0.0")
    port = port if port is not None else int(os.environ.get("SET_PORT", "5000"))
    app = create_app()
    # This path is for local development. Render uses Gunicorn with one
    # threaded worker so the in-memory registry is never split across workers.
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
