import time
from random import Random

import pytest

from set_game import deck
from set_game.bot import BOT_PLAYER_ID, BotDifficulty
from set_game.game import (
    BOARD_MIN,
    BUZZ_SECONDS,
    LOCKOUT_SECONDS,
    SET_REVEAL_SECONDS,
    Game,
    Phase,
)


def make_game(seed=1, n_players=2):
    g = Game(room_code="ABCDEF", rng=Random(seed))
    ids = []
    for i in range(n_players):
        pid = f"p{i}"
        g.add_player(pid, sid=f"sid{i}", name=f"Player {i}")
        ids.append(pid)
    return g, ids


def test_start_deals_at_least_12():
    g, _ = make_game()
    g.start()
    assert len(g.board) >= BOARD_MIN
    assert g.phase == Phase.PLAYING


def test_start_resets_scores_and_lockouts():
    g, ids = make_game()
    g.players[ids[0]].score = 5
    g.players[ids[0]].lockout_until = 999999.0
    g.start()
    assert g.players[ids[0]].score == 0
    assert g.players[ids[0]].lockout_until == 0.0


def test_add_player_first_is_host():
    g, ids = make_game(n_players=3)
    assert g.players[ids[0]].is_host is True
    assert g.players[ids[1]].is_host is False
    assert g.players[ids[2]].is_host is False


def test_add_player_during_active_game_is_spectator():
    g, _ids = make_game(n_players=1)
    g.start()
    g.add_player("late", sid="sidX", name="Latecomer")
    assert g.players["late"].spectator is True


def test_room_capacity_includes_disconnected_reconnecting_seats():
    g, ids = make_game(n_players=8)
    g.mark_disconnected(ids[-1], time.monotonic())
    with pytest.raises(ValueError, match="room full"):
        g.add_player("ninth", sid="sid9", name="Ninth")


def test_remove_player_clears_buzz_and_reassigns_host():
    g, ids = make_game(n_players=2)
    g.start()
    g.start_buzz(ids[0], time.monotonic())
    removed = g.remove_player(ids[0])

    assert removed and removed.player_id == ids[0]
    assert g.buzz is None
    assert ids[0] not in g.players
    assert g.players[ids[1]].is_host is True


def test_disconnecting_host_immediately_reassigns_host():
    g, ids = make_game(n_players=2)

    g.mark_disconnected(ids[0], time.monotonic())

    assert g.players[ids[0]].is_host is False
    assert g.players[ids[1]].is_host is True


def test_first_player_to_reconnect_claims_host_when_room_is_hostless():
    g, ids = make_game(n_players=2)
    now = time.monotonic()
    g.mark_disconnected(ids[0], now)
    g.mark_disconnected(ids[1], now)

    assert not any(player.is_host for player in g.players.values())

    g.add_player(ids[1], sid="replacement-sid", name="Player 1")

    assert g.players[ids[1]].is_host is True
    assert sum(player.is_host for player in g.players.values()) == 1


def test_buzz_locks_out_others():
    g, ids = make_game()
    g.start()
    now = time.monotonic()
    assert g.can_buzz(ids[0], now) is None
    g.start_buzz(ids[0], now)
    assert g.can_buzz(ids[1], now) == "already locked"
    assert g.can_buzz(ids[0], now) == "already locked"


def test_valid_set_awards_point_and_refills_board():
    g, ids = make_game(seed=2)
    g.start()
    now = time.monotonic()
    a, b, c = deck.find_any_set(g.board)
    g.start_buzz(ids[0], now)
    assert g.select(ids[0], a, now) == "selected"
    assert g.select(ids[0], b, now) == "selected"
    result = g.select(ids[0], c, now)
    assert result == "resolved-valid"
    assert g.players[ids[0]].score == 1
    assert a not in g.board and b not in g.board and c not in g.board
    assert len(g.board) >= BOARD_MIN
    assert g.buzz is None


def test_invalid_set_penalizes_and_locks_out():
    g, ids = make_game(seed=3)
    g.start()
    # Find three cards on the board that do NOT form a set.
    from itertools import combinations

    bad_triple = next(
        (t for t in combinations(g.board, 3) if not deck.is_set(*t)), None
    )
    assert bad_triple is not None
    now = time.monotonic()
    g.start_buzz(ids[0], now)
    g.select(ids[0], bad_triple[0], now)
    g.select(ids[0], bad_triple[1], now)
    result = g.select(ids[0], bad_triple[2], now)
    assert result == "resolved-invalid"
    assert g.players[ids[0]].score == -1
    assert g.buzz is None
    assert g.players[ids[0]].lockout_until > now
    # locked out player cannot buzz again immediately
    assert g.can_buzz(ids[0], now) == "locked out"
    # but is free after the lockout window
    assert g.can_buzz(ids[0], now + LOCKOUT_SECONDS + 0.01) is None


def test_deferred_selection_keeps_third_card_visible_before_verdict():
    g, ids = make_game(seed=21)
    g.start()
    from itertools import combinations

    bad_triple = next(t for t in combinations(g.board, 3) if not deck.is_set(*t))
    now = time.monotonic()
    g.start_buzz(ids[0], now)
    assert g.select(ids[0], bad_triple[0], now, defer_resolution=True) == "selected"
    assert g.select(ids[0], bad_triple[1], now, defer_resolution=True) == "selected"
    assert (
        g.select(ids[0], bad_triple[2], now, defer_resolution=True)
        == "selection-complete"
    )

    # The complete selection remains intact and unscored during the short
    # visual preview; extra input is locked until the scheduled verdict.
    assert tuple(g.buzz.selection) == bad_triple
    assert g.players[ids[0]].score == 0
    assert (
        g.select(ids[0], g.board[3], now, defer_resolution=True) == "selection pending"
    )

    assert g.resolve_selection(ids[0], bad_triple, now + 0.55) == "resolved-invalid"
    assert g.players[ids[0]].score == -1
    assert g.buzz is None


def test_buzz_expiry_penalizes_and_frees_others():
    g, ids = make_game(seed=4)
    g.start()
    now = time.monotonic()
    buzz = g.start_buzz(ids[0], now)
    acted = g.expire_buzz(buzz.deadline, buzz.deadline)
    assert acted is True
    assert g.players[ids[0]].score == -1
    assert g.buzz is None
    assert g.can_buzz(ids[1], now) is None


def test_buzz_expiry_does_not_fire_before_deadline():
    g, ids = make_game(seed=4)
    g.start()
    now = time.monotonic()
    buzz = g.start_buzz(ids[0], now)

    assert g.expire_buzz(buzz.deadline, buzz.deadline - 0.01) is False
    assert g.buzz is buzz
    assert g.players[ids[0]].score == 0


def test_stale_buzz_expiry_is_noop():
    g, ids = make_game(seed=5)
    g.start()
    now = time.monotonic()
    buzz = g.start_buzz(ids[0], now)
    # Resolve normally first (simulate a fast correct pick).
    a, b, c = deck.find_any_set(g.board)
    g.select(ids[0], a, now)
    g.select(ids[0], b, now)
    g.select(ids[0], c, now)
    assert g.players[ids[0]].score == 1
    # The old scheduled timeout fires late, using the stale deadline.
    acted = g.expire_buzz(buzz.deadline, now)
    assert acted is False
    assert g.players[ids[0]].score == 1  # unchanged


def test_expire_lockout_rejects_early_and_stale_timers_and_acts_once():
    g, ids = make_game(seed=18)
    g.start()
    now = time.monotonic()
    deadline = g._penalize(ids[0], now)
    assert g.players[ids[0]].lockout_until == deadline
    assert g.expire_lockout(ids[0], deadline, deadline - 0.01) is False
    # A second offense before the first timer fires supersedes the deadline.
    new_deadline = g._penalize(ids[0], now + 1)
    assert new_deadline != deadline
    assert g.expire_lockout(ids[0], deadline, new_deadline) is False
    assert g.expire_lockout(ids[0], new_deadline, new_deadline) is True
    assert g.expire_lockout(ids[0], new_deadline, new_deadline) is False


def test_reveal_freeze_blocks_everyone_including_the_finder():
    g, ids = make_game(seed=19)
    g.start()
    now = time.monotonic()
    a, b, c = deck.find_any_set(g.board)
    g.start_buzz(ids[0], now)
    g.select(ids[0], a, now)
    g.select(ids[0], b, now)
    g.select(ids[0], c, now)
    assert g.reveal_until > now
    # Both the finder and everyone else are frozen out during the reveal.
    assert g.can_buzz(ids[0], now) == "revealing"
    assert g.can_buzz(ids[1], now) == "revealing"
    assert g.toggle_no_set_vote(ids[0], now) == "revealing"
    assert g.toggle_no_set_vote(ids[1], now) == "revealing"
    # Once the shared window has elapsed, everyone is free again.
    later = now + SET_REVEAL_SECONDS + 0.01
    assert g.can_buzz(ids[0], later) is None
    assert g.can_buzz(ids[1], later) is None


def test_expire_reveal_rejects_early_and_stale_timers_and_acts_once():
    g, _ids = make_game(seed=20)
    g.start()
    now = time.monotonic()
    deadline = now + SET_REVEAL_SECONDS
    g.reveal_until = deadline
    assert g.expire_reveal(deadline, deadline - 0.01) is False
    later_deadline = deadline + 5
    g.reveal_until = later_deadline
    assert g.expire_reveal(deadline, later_deadline) is False
    assert g.expire_reveal(later_deadline, later_deadline) is True
    assert g.expire_reveal(later_deadline, later_deadline) is False


def test_select_rejects_non_buzzer():
    g, ids = make_game(seed=6)
    g.start()
    now = time.monotonic()
    g.start_buzz(ids[0], now)
    result = g.select(ids[1], g.board[0], now)
    assert result == "not your buzz"


def test_select_after_deadline_rejected():
    g, ids = make_game(seed=7)
    g.start()
    now = time.monotonic()
    g.start_buzz(ids[0], now)
    result = g.select(ids[0], g.board[0], now + BUZZ_SECONDS + 1)
    assert result == "expired"


def test_no_set_vote_needs_everyone():
    g, ids = make_game(n_players=3, seed=8)
    g.start()
    now = time.monotonic()
    board_before = list(g.board)
    scores_before = {pid: p.score for pid, p in g.players.items()}

    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    assert g.no_set_votes == {ids[0]}
    assert g.board == board_before  # unchanged: not unanimous yet

    assert g.toggle_no_set_vote(ids[1], now) == "voted"
    assert g.no_set_votes == {ids[0], ids[1]}
    assert g.board == board_before

    result = g.toggle_no_set_vote(ids[2], now)
    assert result == "passed-dealt"
    assert g.no_set_votes == set()  # cleared once the vote resolves
    assert len(g.board) == len(board_before) + 3
    # No score changes anywhere in this path -- it's not a claim.
    assert {pid: p.score for pid, p in g.players.items()} == scores_before


def test_no_set_vote_can_be_retracted():
    g, ids = make_game(seed=9)
    g.start()
    now = time.monotonic()
    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    assert g.no_set_votes == {ids[0]}
    assert g.toggle_no_set_vote(ids[0], now) == "unvoted"
    assert g.no_set_votes == set()


def test_no_set_vote_deals_even_when_a_set_exists():
    """The room's unanimous word is trusted -- the vote deals regardless
    of whether the board actually has a set, and never docks anyone."""
    g, ids = make_game(seed=10)
    g.start()
    assert deck.find_any_set(g.board) is not None
    board_before = list(g.board)
    scores_before = {pid: p.score for pid, p in g.players.items()}
    now = time.monotonic()

    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    result = g.toggle_no_set_vote(ids[1], now)
    assert result == "passed-dealt"
    assert len(g.board) == len(board_before) + 3
    assert {pid: p.score for pid, p in g.players.items()} == scores_before


def test_locked_out_player_can_still_vote_no_set():
    g, ids = make_game(seed=11)
    g.start()
    now = time.monotonic()
    g._penalize(ids[0], now)
    assert g.can_buzz(ids[0], now) == "locked out"
    assert g.toggle_no_set_vote(ids[0], now) == "voted"


def test_no_set_vote_blocked_during_buzz_and_reveal():
    g, ids = make_game(seed=12)
    g.start()
    now = time.monotonic()
    g.start_buzz(ids[1], now)
    assert g.toggle_no_set_vote(ids[0], now) == "already locked"

    g.buzz = None
    g.reveal_until = now + SET_REVEAL_SECONDS
    assert g.toggle_no_set_vote(ids[0], now) == "revealing"


def test_no_set_vote_cleared_when_a_set_is_claimed():
    g, ids = make_game(n_players=3, seed=13)
    g.start()
    now = time.monotonic()
    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    assert g.no_set_votes == {ids[0]}

    a, b, c = deck.find_any_set(g.board)
    g.start_buzz(ids[1], now)
    g.select(ids[1], a, now)
    g.select(ids[1], b, now)
    result = g.select(ids[1], c, now)
    assert result == "resolved-valid"
    assert g.no_set_votes == set()


def test_disconnect_shrinks_the_electorate_to_pass_a_pending_vote():
    g, ids = make_game(n_players=3, seed=14)
    g.start()
    now = time.monotonic()
    board_before = list(g.board)
    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    assert g.toggle_no_set_vote(ids[1], now) == "voted"
    # ids[2] never votes, but disconnects -- the electorate shrinks to the
    # two players who already voted, so the vote should now be unanimous.
    g.mark_disconnected(ids[2], now)
    assert ids[2] not in g.no_set_votes
    result = g.recheck_no_set_vote(now)
    assert result == "passed-dealt"
    assert len(g.board) == len(board_before) + 3


def test_unanimous_vote_with_empty_deck_ends_the_match():
    g, ids = make_game(seed=15)
    g.start()
    g.deck_remaining = []
    now = time.monotonic()
    assert g.toggle_no_set_vote(ids[0], now) == "voted"
    result = g.toggle_no_set_vote(ids[1], now)
    assert result == "passed-game-over"
    assert g.phase == Phase.FINISHED
    assert g.winner_ids


def test_finish_picks_all_tied_top_scorers():
    g, ids = make_game(n_players=3, seed=11)
    g.start()
    g.players[ids[0]].score = 3
    g.players[ids[1]].score = 3
    g.players[ids[2]].score = 1
    g._finish()
    assert set(g.winner_ids) == {ids[0], ids[1]}


def test_disconnect_during_own_buzz_penalizes_and_frees_board():
    g, ids = make_game(seed=12)
    g.start()
    now = time.monotonic()
    g.start_buzz(ids[0], now)
    g.mark_disconnected(ids[0], now)
    assert g.buzz is None
    assert g.players[ids[0]].score == -1
    assert g.can_buzz(ids[1], now) is None


def test_reconnect_within_grace_restores_player():
    g, ids = make_game(seed=13)
    g.start()
    g.players[ids[0]].score = 4
    g.mark_disconnected(ids[0], time.monotonic())
    assert g.players[ids[0]].connected is False
    g.add_player(ids[0], sid="new-sid", name="Player 0")
    assert g.players[ids[0]].connected is True
    assert g.players[ids[0]].score == 4  # score preserved


def test_reconnect_updates_player_name():
    g, ids = make_game(seed=13)
    g.mark_disconnected(ids[0], time.monotonic())
    g.add_player(ids[0], sid="new-sid", name="Updated name")
    assert g.players[ids[0]].name == "Updated name"


def test_disconnected_players_do_not_count_as_active_or_join_new_match():
    g, ids = make_game(n_players=2, seed=13)
    g.mark_disconnected(ids[1], time.monotonic())

    assert [p.player_id for p in g.active_players()] == [ids[0]]
    g.start()
    assert g.players[ids[1]].spectator is True


def test_drop_stale_disconnects_removes_after_grace_period():
    g, ids = make_game(n_players=2, seed=14)
    g.start()
    g.mark_disconnected(ids[1], time.monotonic())
    now = time.monotonic() + 61
    removed = g.drop_stale_disconnects(now)
    assert ids[1] in removed
    assert ids[1] not in g.players


def test_drop_stale_disconnects_honors_explicit_zero_time():
    g, ids = make_game(n_players=1, seed=14)
    g.players[ids[0]].connected = False
    g.players[ids[0]].disconnected_at = -61
    assert g.drop_stale_disconnects(now=0) == [ids[0]]


def test_drop_stale_disconnects_reassigns_host():
    g, ids = make_game(n_players=2, seed=15)
    g.start()
    assert g.players[ids[0]].is_host is True
    g.mark_disconnected(ids[0], time.monotonic())
    now = time.monotonic() + 61
    g.drop_stale_disconnects(now)
    assert g.players[ids[1]].is_host is True


def test_finished_standings_keep_disconnected_players_and_reassign_host():
    g, ids = make_game(n_players=2, seed=15)
    g.start()
    g.players[ids[0]].score = 3
    g._finish()
    disconnected_at = time.monotonic()
    g.mark_disconnected(ids[0], disconnected_at)

    assert g.drop_stale_disconnects(disconnected_at + 61) == []
    assert ids[0] in g.players
    assert g.players[ids[1]].is_host is True
    assert g.winner_ids == [ids[0]]


def test_finished_room_drops_players_when_everyone_is_stale():
    g, ids = make_game(n_players=2, seed=15)
    g.start()
    g._finish()
    disconnected_at = time.monotonic()
    for player_id in ids:
        g.mark_disconnected(player_id, disconnected_at)

    assert set(g.drop_stale_disconnects(disconnected_at + 61)) == set(ids)
    assert g.players == {}


def test_snapshot_serializes_board_as_card_dicts():
    g, _ids = make_game(seed=16)
    g.start()
    snap = g.snapshot()
    assert snap["phase"] == "playing"
    assert len(snap["board"]) == len(g.board)
    assert all("shape" in c and "color" in c for c in snap["board"])
    assert snap["deck_remaining"] == len(g.deck_remaining)


def test_reset_to_lobby_clears_state_but_keeps_players():
    g, ids = make_game(seed=17)
    g.start()
    g.players[ids[0]].score = 2
    g.reset_to_lobby()
    assert g.phase == Phase.LOBBY
    assert g.board == []
    assert ids[0] in g.players  # players remain seated for the next match


def test_spectators_are_not_match_winners():
    g, ids = make_game(n_players=2, seed=22)
    g.start()
    spectator = g.add_player("spectator", sid="sid-x", name="Spectator")
    spectator.score = 100
    g.players[ids[0]].score = 2
    g.players[ids[1]].score = 1

    g._finish()

    assert g.winner_ids == [ids[0]]


def test_bot_is_a_scored_seat_and_allows_solo_start():
    g, ids = make_game(n_players=1)

    bot_player = g.configure_bot(BotDifficulty.MEDIUM)

    assert bot_player is not None
    assert bot_player.player_id == BOT_PLAYER_ID
    assert [p.player_id for p in g.active_players()] == [ids[0], BOT_PLAYER_ID]
    snapshot = g.snapshot()
    assert snapshot["bot_difficulty"] == "medium"
    assert snapshot["players"][1]["is_bot"] is True
    assert snapshot["players"][1]["bot_difficulty"] == "medium"


def test_bot_uses_one_of_the_eight_room_seats():
    g, _ids = make_game(n_players=7)
    g.configure_bot(BotDifficulty.EASY)

    with pytest.raises(ValueError, match="room full"):
        g.add_player("eighth-human", sid="sid8", name="Eighth")


def test_bot_cannot_become_host_when_the_human_host_disconnects():
    g, ids = make_game(n_players=2)
    g.configure_bot(BotDifficulty.HARD)

    g.mark_disconnected(ids[0], time.monotonic())

    assert g.players[ids[1]].is_host is True
    assert g.players[BOT_PLAYER_ID].is_host is False


def test_bot_setting_persists_across_play_again_and_can_be_removed():
    g, _ids = make_game(n_players=1)
    g.configure_bot(BotDifficulty.MEDIUM)
    g.start()
    g._finish()

    g.reset_to_lobby()

    assert g.bot_difficulty == BotDifficulty.MEDIUM
    g.configure_bot(None)
    assert g.bot_player is None
    assert g.bot_difficulty is None


def test_bot_configuration_is_lobby_only():
    g, _ids = make_game(n_players=1)
    g.start()

    with pytest.raises(ValueError, match="lobby"):
        g.configure_bot(BotDifficulty.EASY)


def test_connected_bot_does_not_preserve_disconnected_finished_standings():
    g, ids = make_game(n_players=1)
    g.configure_bot(BotDifficulty.EASY)
    g.start()
    g._finish()
    disconnected_at = time.monotonic()
    g.mark_disconnected(ids[0], disconnected_at)

    assert g.drop_stale_disconnects(disconnected_at + 61) == ids
    assert list(g.players) == [BOT_PLAYER_ID]
