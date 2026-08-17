from random import Random

from set_game import deck
from set_game.bot import BotDifficulty, choose_action, reaction_delay


def test_reaction_delays_stay_within_each_difficulty_range():
    expected = {
        BotDifficulty.EASY: (10.0, 15.0),
        BotDifficulty.MEDIUM: (6.0, 10.0),
        BotDifficulty.HARD: (3.5, 6.0),
    }

    for difficulty, (minimum, maximum) in expected.items():
        delays = [reaction_delay(difficulty, Random(seed)) for seed in range(20)]
        assert all(minimum <= delay <= maximum for delay in delays)


def test_hard_bot_can_select_a_valid_set():
    cards = list(range(12))

    decision = choose_action(cards, BotDifficulty.HARD, Random(1))

    assert decision.cards is not None
    assert deck.is_set(*decision.cards)


def test_hard_bot_is_not_perfect():
    cards = list(range(12))

    decision = choose_action(cards, BotDifficulty.HARD, Random(2))

    assert decision.cards is not None
    assert not deck.is_set(*decision.cards)


def test_easy_bot_can_make_an_invalid_claim():
    cards = list(range(12))

    decision = choose_action(cards, BotDifficulty.EASY, Random(2))

    assert decision.cards is not None
    assert not deck.is_set(*decision.cards)


def test_bot_recognizes_a_board_without_three_cards_as_no_set():
    decision = choose_action([0, 1], BotDifficulty.EASY, Random(2))

    assert decision.is_no_set_vote
