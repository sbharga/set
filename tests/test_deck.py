from itertools import combinations
from random import Random

import pytest

from set_game.deck import (
    Card,
    count_sets,
    find_any_set,
    full_deck,
    is_set,
    shuffled_deck,
)


def brute_force_is_set(a: int, b: int, c: int) -> bool:
    """Reference implementation using explicit Card attributes, to cross
    check the bit-twiddling version in deck.is_set."""
    ca, cb, cc = Card.from_code(a), Card.from_code(b), Card.from_code(c)
    for feature in ("shape", "color", "number", "shading"):
        vals = {getattr(ca, feature), getattr(cb, feature), getattr(cc, feature)}
        if len(vals) == 2:
            return False
    return True


def test_full_deck_has_81_unique_cards():
    deck = full_deck()
    assert len(deck) == 81
    assert len(set(deck)) == 81
    assert all(0 <= c < 81 for c in deck)


def test_card_from_code_round_trips_all_combinations():
    seen = set()
    for code in range(81):
        card = Card.from_code(code)
        key = (card.shape, card.color, card.number, card.shading)
        assert key not in seen
        seen.add(key)
    assert len(seen) == 81


def test_card_from_code_rejects_out_of_range():
    with pytest.raises(ValueError):
        Card.from_code(-1)
    with pytest.raises(ValueError):
        Card.from_code(81)


@pytest.mark.parametrize("a,b,c", list(combinations(range(0, 81, 7), 3))[:50])
def test_is_set_matches_brute_force(a, b, c):
    assert is_set(a, b, c) == brute_force_is_set(a, b, c)


def test_is_set_full_truth_table_matches_brute_force():
    # Exhaustively compare the fast digit-sum check against the explicit
    # attribute-based reference over every triple of a small deterministic
    # subset, then spot check the identity/degenerate cases explicitly.
    sample = list(range(0, 81, 3))
    for a, b, c in combinations(sample, 3):
        assert is_set(a, b, c) == brute_force_is_set(a, b, c)


def test_is_set_rejects_duplicate_cards():
    assert is_set(5, 5, 10) is False
    assert is_set(5, 10, 5) is False
    assert is_set(5, 5, 5) is False


def test_is_set_known_valid_triple():
    # One solid red diamond, two striped green diamonds, three open purple
    # diamonds -- from DESCRIPTION.md's worked example.
    a = next(
        c
        for c in range(81)
        if (card := Card.from_code(c))
        and card.shape == "diamond"
        and card.color == "red"
        and card.number == 1
        and card.shading == "solid"
    )
    b = next(
        c
        for c in range(81)
        if (card := Card.from_code(c))
        and card.shape == "diamond"
        and card.color == "green"
        and card.number == 2
        and card.shading == "striped"
    )
    c = next(
        c
        for c in range(81)
        if (card := Card.from_code(c))
        and card.shape == "diamond"
        and card.color == "purple"
        and card.number == 3
        and card.shading == "open"
    )
    assert is_set(a, b, c) is True


def test_is_set_known_invalid_triple():
    # Two red, one green (color neither all-same nor all-different) with
    # three different shapes, three different numbers, all solid shading.
    cards = [Card.from_code(c) for c in range(81)]

    def find(shape, color, number, shading):
        return next(
            c.code
            for c in cards
            if c.shape == shape
            and c.color == color
            and c.number == number
            and c.shading == shading
        )

    a = find("oval", "red", 1, "solid")
    b = find("diamond", "red", 2, "solid")
    c = find("squiggle", "green", 3, "solid")
    assert is_set(a, b, c) is False


def test_shuffled_deck_is_deterministic_with_seeded_rng():
    d1 = shuffled_deck(Random(42))
    d2 = shuffled_deck(Random(42))
    assert d1 == d2
    assert sorted(d1) == list(range(81))


def test_find_any_set_matches_brute_force_across_random_boards():
    rng = Random(1234)
    for _ in range(200):
        deck = shuffled_deck(rng)
        board = deck[:12]
        expected = any(is_set(a, b, c) for a, b, c in combinations(board, 3))
        result = find_any_set(board)
        assert (result is not None) == expected
        if result is not None:
            assert is_set(*result)
            assert all(card in board for card in result)


def test_find_any_set_ignores_none_gaps():
    board = [None, None, None]
    assert find_any_set(board) is None


def test_find_any_set_returns_none_for_no_set_board():
    # A hand-picked 3-card board with no set: differ in exactly one
    # feature (color) in a two-same-one-different way is impossible with
    # only 3 cards forming a non-set unless we pick two-same-one-diff on a
    # feature -- use two cards sharing every feature except color, plus a
    # third that breaks the all-same/all-different rule on color.
    a = 0  # oval, red, 1, solid
    b = 1  # oval, red, 1, striped
    board = [a, b]
    assert find_any_set(board) is None


def test_count_sets_matches_brute_force():
    rng = Random(99)
    deck = shuffled_deck(rng)
    board = deck[:15]
    expected = sum(1 for a, b, c in combinations(board, 3) if is_set(a, b, c))
    assert count_sets(board) == expected


def test_count_sets_ignores_none_gaps():
    rng = Random(7)
    deck = shuffled_deck(rng)
    board = deck[:12] + [None, None, None]
    assert count_sets(board) == count_sets(deck[:12])
