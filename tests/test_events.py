import pytest

from set_game.app import create_app, socketio
from set_game.rooms import registry

PLAYER_ID = "player-identifier-01"
PLAYER_TOKEN = "a" * 64


def join(
    client, room_code, name="Alice", player_id=PLAYER_ID, player_token=PLAYER_TOKEN
):
    client.emit(
        "join_room",
        {
            "room_code": room_code,
            "name": name,
            "player_id": player_id,
            "player_token": player_token,
        },
    )


@pytest.fixture(scope="module")
def app():
    return create_app()


def test_new_socket_for_same_player_retires_stale_connection(app):
    game = registry.create_room()
    first = socketio.test_client(app)
    second = socketio.test_client(app)

    try:
        join(first, game.room_code, player_id=PLAYER_ID)
        first_sid = game.players[PLAYER_ID].sid

        join(second, game.room_code, player_id=PLAYER_ID)

        player = game.players[PLAYER_ID]
        assert player.connected is True
        assert player.sid != first_sid
        assert second.is_connected() is True
        assert first.is_connected() is False
    finally:
        if first.is_connected():
            first.disconnect()
        if second.is_connected():
            second.disconnect()
        registry.remove(game.room_code)


def test_join_sends_full_snapshot_only_to_joiner(app):
    game = registry.create_room()
    first = socketio.test_client(app)
    second = socketio.test_client(app)

    try:
        join(first, game.room_code, player_id="first-player-ident")
        first.get_received()
        join(
            second,
            game.room_code,
            player_id="second-player-iden",
            player_token="b" * 64,
        )

        first_events = [event["name"] for event in first.get_received()]
        second_events = [event["name"] for event in second.get_received()]
        assert "room_state" not in first_events
        assert "players_updated" in first_events
        assert "room_state" in second_events
    finally:
        if first.is_connected():
            first.disconnect()
        if second.is_connected():
            second.disconnect()
        registry.remove(game.room_code)


def test_host_can_kick_but_kicked_identity_cannot_rejoin(app):
    game = registry.create_room()
    host = socketio.test_client(app)
    guest = socketio.test_client(app)
    guest_id = "guest-player-ident"
    guest_token = "c" * 64

    try:
        join(host, game.room_code, player_id="host-player-ident", player_token="d" * 64)
        join(guest, game.room_code, player_id=guest_id, player_token=guest_token)
        host.get_received()
        guest.get_received()

        host.emit("kick_player", {"player_id": guest_id})
        assert guest_id not in game.players
        assert guest.is_connected() is False
        assert "players_updated" in [event["name"] for event in host.get_received()]

        returning_guest = socketio.test_client(app)
        try:
            join(
                returning_guest,
                game.room_code,
                player_id=guest_id,
                player_token=guest_token,
            )
            errors = [
                event
                for event in returning_guest.get_received()
                if event["name"] == "action_error"
            ]
            assert (
                errors[0]["args"][0]["message"]
                == "You were removed from this game by its host."
            )
        finally:
            if returning_guest.is_connected():
                returning_guest.disconnect()
    finally:
        if host.is_connected():
            host.disconnect()
        if guest.is_connected():
            guest.disconnect()
        registry.remove(game.room_code)


def test_malformed_card_payload_returns_error_instead_of_crashing_handler(app):
    game = registry.create_room()
    client = socketio.test_client(app)

    try:
        join(client, game.room_code)
        client.get_received()

        client.emit("select_card", {"card": "not-a-card"})

        errors = [
            event for event in client.get_received() if event["name"] == "action_error"
        ]
        assert errors == [
            {
                "name": "action_error",
                "args": [{"message": "Invalid card."}],
                "namespace": "/",
            }
        ]
    finally:
        if client.is_connected():
            client.disconnect()
        registry.remove(game.room_code)


def test_missing_payload_returns_error_instead_of_crashing_handler(app):
    game = registry.create_room()
    client = socketio.test_client(app)

    try:
        join(client, game.room_code)
        client.get_received()

        client.emit("select_card")

        errors = [
            event for event in client.get_received() if event["name"] == "action_error"
        ]
        assert errors[0]["args"][0]["message"] == "Invalid card."
        assert client.is_connected() is True
    finally:
        if client.is_connected():
            client.disconnect()
        registry.remove(game.room_code)


def test_one_socket_cannot_occupy_multiple_player_seats(app):
    first_game = registry.create_room()
    second_game = registry.create_room()
    client = socketio.test_client(app)

    try:
        join(client, first_game.room_code)
        client.get_received()

        join(
            client,
            second_game.room_code,
            player_id="second-player-iden",
            player_token="b" * 64,
        )

        errors = [
            event for event in client.get_received() if event["name"] == "action_error"
        ]
        assert errors[0]["args"][0]["message"] == (
            "This browser is already in another player seat."
        )
        assert list(first_game.players) == [PLAYER_ID]
        assert second_game.players == {}
    finally:
        if client.is_connected():
            client.disconnect()
        registry.remove(first_game.room_code)
        registry.remove(second_game.room_code)
