"""Pure SET game math: cards, decks, and the "is this a set?" rule.

No Flask, no I/O, no randomness beyond `shuffled_deck` — this module is
deliberately dependency-free so it is trivial to unit test and reason about.

A card is encoded as a single int 0..80. Read in base 3, its four digits
are (shape, color, number, shading), each 0, 1, or 2. Keeping cards as
plain ints (rather than objects) makes them cheap to send over the wire,
hash, and compare.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from random import Random

SHAPES = ("oval", "diamond", "squiggle")
COLORS = ("red", "green", "purple")
NUMBERS = (1, 2, 3)
SHADINGS = ("solid", "striped", "open")

DECK_SIZE = 81


@dataclass(frozen=True, slots=True)
class Card:
    """Human-readable view of a card, derived from its numeric code."""

    code: int
    shape: str
    color: str
    number: int
    shading: str

    @staticmethod
    def from_code(code: int) -> "Card":
        if not 0 <= code < DECK_SIZE:
            raise ValueError(f"card code out of range: {code}")
        shape_i, rest = divmod(code, 27)
        color_i, rest = divmod(rest, 9)
        number_i, shading_i = divmod(rest, 3)
        return Card(
            code=code,
            shape=SHAPES[shape_i],
            color=COLORS[color_i],
            number=NUMBERS[number_i],
            shading=SHADINGS[shading_i],
        )

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "shape": self.shape,
            "color": self.color,
            "number": self.number,
            "shading": self.shading,
        }


def full_deck() -> list[int]:
    """All 81 card codes, in canonical order."""
    return list(range(DECK_SIZE))


def shuffled_deck(rng: Random | None = None) -> list[int]:
    """A freshly shuffled deck. Pass an rng for deterministic tests."""
    deck = full_deck()
    (rng or Random()).shuffle(deck)
    return deck


def is_set(a: int, b: int, c: int) -> bool:
    """True iff cards a, b, c form a valid SET.

    Decompose each code into its four base-3 digits and check, digit by
    digit, that the three values are either all equal or all distinct.
    That condition is exactly "the digits sum to a multiple of 3" (0+0+0,
    1+1+1, 2+2+2, or 0+1+2 in any order all satisfy sum % 3 == 0; the only
    other digit multisets, e.g. {0,0,1}, do not). So the whole rule
    collapses to one arithmetic check per feature, no branching needed.
    """
    if a == b or b == c or a == c:
        return False
    for divisor in (27, 9, 3, 1):
        da = (a // divisor) % 3
        db = (b // divisor) % 3
        dc = (c // divisor) % 3
        if (da + db + dc) % 3 != 0:
            return False
    return True


def find_any_set(cards: list[int]) -> tuple[int, int, int] | None:
    """First valid triple found among `cards` (ignoring None gaps), or None.

    Board sizes in play are at most ~21 cards, so brute-force combinations
    (at most C(21,3) = 1330) is effectively instant.
    """
    present = [c for c in cards if c is not None]
    for a, b, c in combinations(present, 3):
        if is_set(a, b, c):
            return (a, b, c)
    return None


def count_sets(cards: list[int]) -> int:
    """Count of valid triples among `cards`, ignoring None gaps."""
    present = [c for c in cards if c is not None]
    return sum(1 for a, b, c in combinations(present, 3) if is_set(a, b, c))
