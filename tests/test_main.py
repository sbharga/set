import importlib.util
from pathlib import Path


_SPEC = importlib.util.spec_from_file_location("server_main", Path(__file__).parents[1] / "main.py")
assert _SPEC and _SPEC.loader
main = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(main)


def test_cli_delegates_default_host_and_port_to_environment(monkeypatch):
    called = {}
    monkeypatch.setattr(main, "run", lambda **kwargs: called.update(kwargs))
    monkeypatch.setattr("sys.argv", ["main.py"])

    main.main()

    assert called == {"host": None, "port": None}


def test_cli_host_and_port_override_environment_defaults(monkeypatch):
    called = {}
    monkeypatch.setattr(main, "run", lambda **kwargs: called.update(kwargs))
    monkeypatch.setattr("sys.argv", ["main.py", "--host", "127.0.0.1", "--port", "9000"])

    main.main()

    assert called == {"host": "127.0.0.1", "port": 9000}
