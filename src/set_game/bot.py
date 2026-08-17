"""Pure decision policy for the optional computer player."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from itertools import combinations
from random import Random

from . import deck

BOT_PLAYER_ID = "__set_bot_player__"
BOT_NAME = "SET Bot"


class BotDifficulty(str, Enum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


@dataclass(frozen=True)
class BotProfile:
    min_delay: float
    max_delay: float
    accuracy: float


PROFILES = {
    BotDifficulty.EASY: BotProfile(6.0, 9.0, 0.60),
    BotDifficulty.MEDIUM: BotProfile(3.0, 5.0, 0.85),
    BotDifficulty.HARD: BotProfile(1.0, 2.0, 1.0),
}


@dataclass(frozen=True)
class BotDecision:
    cards: tuple[int, int, int] | None = None

    @property
    def is_no_set_vote(self) -> bool:
        return self.cards is None


def reaction_delay(difficulty: BotDifficulty, rng: Random) -> float:
    profile = PROFILES[difficulty]
    return rng.uniform(profile.min_delay, profile.max_delay)


def choose_action(
    cards: list[int], difficulty: BotDifficulty, rng: Random
) -> BotDecision:
    """Choose a claim for this board, occasionally missing by difficulty.

    A no-set board is always recognized correctly. This matters because the
    bot occupies a real voting seat and must not permanently block the room's
    unanimous no-set action.
    """
    valid = deck.find_any_set(cards)
    if valid is None:
        return BotDecision()

    if rng.random() <= PROFILES[difficulty].accuracy:
        return BotDecision(valid)

    invalid = next(
        (triple for triple in combinations(cards, 3) if not deck.is_set(*triple)),
        None,
    )
    return BotDecision(invalid or valid)
