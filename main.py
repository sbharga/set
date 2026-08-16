import argparse

from set_game.app import run


def main():
    parser = argparse.ArgumentParser(description="Run the SET versus-mode server.")
    parser.add_argument(
        "--host",
        default=None,
        help="Interface to bind (default: SET_HOST or 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to listen on (default: SET_PORT or 5000)",
    )
    args = parser.parse_args()
    run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
