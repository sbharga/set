/* Room page: lobby waiting room, live board, buzz/no-set controls,
 * animations, and the game-over screen. Talks to the server purely
 * through Socket.IO events defined in events.py.
 *
 * State that drives the UI ticks off local deadlines, not frozen
 * booleans: `lockoutEndsAtByPlayer` / `buzzDeadline` / `revealEndsAt`
 * are all `performance.now()`-based timestamps derived from the *_ms
 * fields the server sends. A single rAF loop (`ensureTicking`) re-derives
 * button/tile state from "is this deadline still in the future?" every
 * frame, so a cooldown or freeze self-expires in the UI exactly when it
 * actually expires server-side -- no reload, no waiting for an unrelated
 * broadcast to happen to land the correction. The server still announces
 * expiry explicitly (`cooldown_ended`, `reveal_ended`) as the source of
 * truth; the local ticking is what makes the *display* keep up between
 * broadcasts instead of freezing on a stale label.
 */

/* Per-room identity credentials are a security boundary: unlike the old
 * Math.random fallback, these are generated only from Web Crypto, available
 * under Render's mandatory HTTPS. The token is never sent to other players. */
function generateSecureId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function")
    return window.crypto.randomUUID();
  return null;
}
function generateSecureToken() {
  if (!(window.crypto && typeof window.crypto.getRandomValues === "function"))
    return null;
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("room-root");
  const roomCode = root.dataset.roomCode;
  document.getElementById("invite-code").textContent = roomCode;
  const NICK_KEY = "set_nickname";
  const PID_KEY = `set_player_id_${roomCode}`;
  const TOKEN_KEY = `set_player_token_${roomCode}`;

  const myName = sessionStorage.getItem(NICK_KEY);
  if (!myName) {
    window.location.href = "/";
    return;
  }
  let myPlayerId = sessionStorage.getItem(PID_KEY);
  let myPlayerToken = sessionStorage.getItem(TOKEN_KEY);
  if (!myPlayerId || !myPlayerToken) {
    myPlayerId = generateSecureId();
    myPlayerToken = generateSecureToken();
    if (!myPlayerId || !myPlayerToken) {
      root.replaceChildren(
        Object.assign(document.createElement("p"), {
          textContent:
            "This game needs a modern HTTPS browser to create a private player identity.",
        }),
      );
      return;
    }
    sessionStorage.setItem(PID_KEY, myPlayerId);
    sessionStorage.setItem(TOKEN_KEY, myPlayerToken);
  }

  // --- view elements --------------------------------------------------

  const views = {
    connecting: document.getElementById("connecting-view"),
    waiting: document.getElementById("waiting-view"),
    game: document.getElementById("game-view"),
    gameover: document.getElementById("gameover-view"),
  };
  function showView(name) {
    Object.entries(views).forEach(([key, el]) => (el.hidden = key !== name));
    deckStatusEl.hidden = name !== "game";
  }

  const boardEl = document.getElementById("board");
  const playersEl = document.getElementById("players");
  const buzzBtn = document.getElementById("buzz-btn");
  const buzzLabelEl = buzzBtn.querySelector(".btn-label");
  const noSetBtn = document.getElementById("no-set-btn");
  const noSetVoteStatusEl = document.getElementById("no-set-vote-status");
  const deckStatusEl = document.getElementById("deck-status");
  const deckCountEl = document.getElementById("deck-count");
  const statusRailEl = document.getElementById("status-rail");
  const railTimerName = document.getElementById("rail-timer-name");
  const railTimerSeconds = document.getElementById("rail-timer-seconds");
  const buzzRingProgress = document.getElementById("buzz-ring-progress");
  const revealOverlay = document.getElementById("reveal-overlay");
  const revealCreditEl = document.getElementById("reveal-credit");
  const revealCardsEl = document.getElementById("reveal-cards");
  const revealFeaturesEl = document.getElementById("reveal-features");
  const revealCountdownEl = document.getElementById("reveal-countdown");
  const toastEl = document.getElementById("toast");
  const connectionEl = document.getElementById("room-connection");

  const RING_CIRCUMFERENCE = 283; // 2 * pi * r45, matches the SVG circle
  const REDUCED_MOTION = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let hasJoined = false;
  let connectionReady = false;
  let removedFromRoom = false;
  let latestSnapshot = null; // last full room_state we rendered
  let selectedCodes = new Set(); // cards currently highlighted as selected
  let lastScores = {}; // player_id -> last-rendered score, to detect bumps

  // Local deadlines, all on the performance.now() timeline. Derived from
  // the server's relative *_ms fields the instant they arrive.
  let buzzDeadline = 0;
  let buzzDurationMs = 10000;
  let lastWholeSecond = null;
  let revealEndsAt = 0;
  const lockoutEndsAtByPlayer = {}; // player_id -> deadline

  // The pending "no set" vote. Kept outside `latestSnapshot` because
  // `updateScoreboardFromPlayers` replaces player objects wholesale on
  // every score broadcast -- a field living only inside a player object
  // would get silently dropped there. Seeded from `room_state`'s
  // `no_set_vote` and then kept current by the `no_set_vote` event.
  let noSetVoters = new Set();
  let noSetNeeded = 0;

  function toast(message, type) {
    clearTimeout(toastEl._hideTimer);
    if (toastEl._animationHandler) {
      toastEl.removeEventListener("animationend", toastEl._animationHandler);
      toastEl._animationHandler = null;
    }
    toastEl.classList.remove("toast-leaving");
    toastEl.textContent = message;
    toastEl.className = "toast" + (type ? ` toast-${type}` : "");
    toastEl.hidden = false;
    toastEl._hideTimer = setTimeout(() => {
      toastEl.classList.add("toast-leaving");
      toastEl._animationHandler = () => {
        toastEl.hidden = true;
        toastEl._animationHandler = null;
      };
      toastEl.addEventListener("animationend", toastEl._animationHandler, {
        once: true,
      });
    }, 3200);
  }

  // --- socket setup -----------------------------------------------------

  const socket = io();

  function showConnection(label, state) {
    if (!connectionEl) return;
    connectionEl.textContent = label;
    connectionEl.classList.toggle("is-live", state === "live");
    connectionEl.classList.toggle("is-offline", state === "offline");
  }

  socket.on("connect", () => {
    if (removedFromRoom) return;
    showConnection("Syncing", "");
    // Stay read-only until the server answers with a fresh room snapshot.
    // Socket.IO may have reconnected after the board changed while this
    // tab was offline.
    connectionReady = false;
    socket.emit("join_room", {
      room_code: roomCode,
      name: myName,
      player_id: myPlayerId,
      player_token: myPlayerToken,
    });
  });

  socket.on("disconnect", () => {
    connectionReady = false;
    showConnection("Reconnecting", "offline");
    updateControlsEnabled();
    if (hasJoined)
      toast("Connection lost. We’re trying to reconnect…", "error");
  });

  socket.on("joined", () => {
    hasJoined = true;
  });

  socket.on("action_error", (data) => {
    if (!hasJoined) {
      views.connecting.replaceChildren();
      const message = document.createElement("p");
      message.textContent = data.message;
      const navigation = document.createElement("p");
      const backLink = document.createElement("a");
      backLink.href = "/";
      backLink.textContent = "Back to home";
      navigation.appendChild(backLink);
      views.connecting.append(message, navigation);
      showView("connecting");
      return;
    }
    toast(data.message, "error");
  });

  socket.on("room_state", (snapshot) => renderSnapshot(snapshot));
  socket.on("players_updated", (data) => {
    if (!latestSnapshot) return;
    latestSnapshot.players = data.players || latestSnapshot.players;
    if (data.winner_ids) latestSnapshot.winner_ids = data.winner_ids;
    if (data.no_set_vote) {
      noSetVoters = new Set(data.no_set_vote.voters);
      noSetNeeded = data.no_set_vote.needed;
    }
    if (latestSnapshot.phase === "lobby") renderWaitingView(latestSnapshot);
    else if (latestSnapshot.phase === "playing")
      renderPlayers(latestSnapshot.players, latestSnapshot.buzz);
    else renderGameOver(latestSnapshot);
  });
  socket.on("removed_from_room", (data) => {
    removedFromRoom = true;
    connectionReady = false;
    socket.disconnect();
    views.connecting.replaceChildren();
    const message = document.createElement("p");
    message.textContent = data.message || "You were removed by the host.";
    const backLink = document.createElement("a");
    backLink.href = "/";
    backLink.textContent = "Private game home";
    views.connecting.append(message, backLink);
    showView("connecting");
  });
  socket.on("game_started", (snapshot) => {
    SetAudio.deal();
    renderSnapshot(snapshot);
  });
  socket.on("game_over", (snapshot) => {
    SetAudio.gameOver();
    renderSnapshot(snapshot);
  });

  socket.on("buzz_started", (data) => {
    selectedCodes.clear();
    // buzz_started/buzz_ended are granular events (not full room_state
    // snapshots), so latestSnapshot.buzz must be kept in sync here too --
    // the click handler and button-enable logic both gate on it.
    if (latestSnapshot) {
      latestSnapshot.buzz = {
        player_id: data.player_id,
        remaining_ms: data.remaining_ms,
        duration_ms: data.duration_ms,
        selection: [],
      };
    }
    startBuzzUI(data);
    SetAudio.buzzIn();
  });
  socket.on("buzz_ended", () => {
    if (latestSnapshot) latestSnapshot.buzz = null;
    stopBuzzUI();
  });

  function markCardSelected(card, selected) {
    if (!card) return;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  }

  socket.on("card_selected", (data) => {
    const card = boardEl.querySelector(`.card[data-code="${data.card}"]`);
    if (data.selected) selectedCodes.add(data.card);
    else selectedCodes.delete(data.card);
    markCardSelected(card, data.selected);
    updateControlsEnabled();
    if (data.player_id === myPlayerId) SetAudio.click();
  });

  socket.on("set_claimed", (data) => {
    SetAudio.validSet();
    updateScoreboardFromPlayers(data.players);
    deckCountEl.textContent = data.deck_remaining;
    selectedCodes.clear();

    revealEndsAt = performance.now() + data.reveal_ms;
    showReveal(data.removed, nameFor(data.player_id));
    ensureTicking();
    animateSetClaim(data.removed, data.board, data.added);
  });

  socket.on("set_rejected", (data) => {
    SetAudio.invalidSet();
    updateScoreboardFromPlayers(data.players);
    shakeSelected();
    selectedCodes.clear();
  });

  socket.on("no_set_vote", (data) => {
    noSetVoters = new Set(data.voters);
    noSetNeeded = data.needed;
    if (latestSnapshot)
      renderPlayers(latestSnapshot.players, latestSnapshot.buzz);
    updateControlsEnabled();
    if (data.player_id === myPlayerId) SetAudio.click();
  });

  socket.on("cooldown_ended", (data) => {
    delete lockoutEndsAtByPlayer[data.player_id];
    updateScoreboardFromPlayers(data.players);
  });

  socket.on("reveal_ended", (data) => {
    revealEndsAt = 0;
    hideReveal();
    updateScoreboardFromPlayers(data.players);
  });

  socket.on("cards_dealt", (data) => {
    SetAudio.deal();
    // The server already emits an empty no_set_vote before this; clearing
    // here too is belt-and-braces against out-of-order delivery.
    noSetVoters = new Set();
    noSetNeeded = 0;
    updateScoreboardFromPlayers(data.players);
    deckCountEl.textContent = data.deck_remaining;
    syncBoard(data.board, data.added);
  });

  // A backgrounded tab only hears about changes via socket pushes; if it
  // reconnected in the background there may have been pushes it missed
  // entirely. Re-announce ourselves on focus and let the server's normal
  // join_room -> room_state reply catch us up, rather than relying solely
  // on socket.io's own reconnect timing.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hasJoined) {
      socket.emit("join_room", {
        room_code: roomCode,
        name: myName,
        player_id: myPlayerId,
        player_token: myPlayerToken,
      });
    }
  });

  // --- rendering: lobby / players / board -----------------------------

  function isHost() {
    if (!latestSnapshot) return false;
    const me = latestSnapshot.players.find((p) => p.player_id === myPlayerId);
    return !!(me && me.is_host);
  }
  function isSpectator() {
    if (!latestSnapshot) return false;
    const me = latestSnapshot.players.find((p) => p.player_id === myPlayerId);
    return !!(me && me.spectator);
  }

  function renderSnapshot(snapshot) {
    connectionReady = true;
    showConnection("Connected", "live");
    latestSnapshot = snapshot;
    const now = performance.now();
    syncLockoutDeadlines(snapshot.players, now);
    // Mid-reveal reconnect: we don't have the claimed cards to replay the
    // celebration, but we still must enforce the shared freeze so this
    // client can't buzz early -- reveal_remaining_ms carries the residual.
    revealEndsAt =
      snapshot.reveal_remaining_ms > 0 ? now + snapshot.reveal_remaining_ms : 0;
    // Restore a pending no-set vote on (re)connect rather than resetting
    // to 0 -- the tally is room state, not something this client owns.
    noSetVoters = new Set(
      snapshot.no_set_vote ? snapshot.no_set_vote.voters : [],
    );
    noSetNeeded = snapshot.no_set_vote ? snapshot.no_set_vote.needed : 0;

    if (snapshot.phase === "lobby") {
      renderWaitingView(snapshot);
      showView("waiting");
    } else if (snapshot.phase === "playing") {
      selectedCodes.clear();
      renderPlayers(snapshot.players, snapshot.buzz);
      deckCountEl.textContent = snapshot.deck_remaining;
      syncBoard(snapshot.board, []);
      if (snapshot.buzz) {
        buzzDurationMs = snapshot.buzz.duration_ms || 10000;
        startBuzzUI({
          player_id: snapshot.buzz.player_id,
          name: nameFor(snapshot.buzz.player_id),
          remaining_ms: snapshot.buzz.remaining_ms,
        });
        snapshot.buzz.selection.forEach((code) => selectedCodes.add(code));
        selectedCodes.forEach((code) => {
          markCardSelected(
            boardEl.querySelector(`.card[data-code="${code}"]`),
            true,
          );
        });
      } else {
        stopBuzzUI();
      }
      updateControlsEnabled(now);
      if (revealEndsAt || anyTimersActive(now)) ensureTicking();
      showView("game");
    } else if (snapshot.phase === "finished") {
      revealEndsAt = 0;
      hideReveal();
      renderGameOver(snapshot);
      showView("gameover");
    }
  }

  function nameFor(playerId) {
    const p = latestSnapshot?.players.find((x) => x.player_id === playerId);
    return p ? p.name : "Someone";
  }

  function renderWaitingView(snapshot) {
    document.getElementById("waiting-title").textContent = snapshot.title;
    const list = document.getElementById("waiting-player-list");
    list.innerHTML = "";
    snapshot.players.forEach((p) => {
      const li = document.createElement("li");
      const tags = [];
      if (p.is_host) tags.push('<span class="tag">HOST</span>');
      if (p.player_id === myPlayerId) tags.push('<span class="tag">YOU</span>');
      if (!p.connected)
        tags.push('<span class="tag tag-offline">OFFLINE</span>');
      const remove =
        isHost() && p.player_id !== myPlayerId
          ? `<button class="kick-player link-btn" type="button" data-player-id="${p.player_id}" data-player-name="${escapeHtml(p.name)}">Remove</button>`
          : "";
      li.innerHTML = `<span class="row-title">${escapeHtml(p.name)}</span><span>${tags.join("")}${remove}</span>`;
      list.appendChild(li);
    });
    document.getElementById("player-count").textContent =
      `${snapshot.players.length} of 8`;

    const activeCount = snapshot.players.filter(
      (p) => p.connected && !p.spectator,
    ).length;
    const startBtn = document.getElementById("start-game-btn");
    const hint = document.getElementById("start-hint");
    const spectatorNote = document.getElementById("spectator-note");
    spectatorNote.hidden = !isSpectator();

    if (isHost()) {
      startBtn.hidden = false;
      startBtn.disabled = activeCount < 2;
      hint.textContent =
        activeCount < 2 ? "Need at least 2 players to start." : "";
    } else {
      startBtn.hidden = true;
      hint.textContent = "Waiting for the host to start the game…";
    }
  }

  function renderPlayers(players, buzz) {
    playersEl.innerHTML = "";
    players.forEach((p) => {
      const tile = document.createElement("div");
      tile.className = "player-tile";
      tile.dataset.playerId = p.player_id;
      if (p.spectator) tile.classList.add("spectator");
      if (buzz && buzz.player_id === p.player_id)
        tile.classList.add("active-buzzer");
      if (noSetVoters.has(p.player_id)) tile.classList.add("voted-no-set");
      const youTag = p.player_id === myPlayerId ? " (you)" : "";
      const voteTag = noSetVoters.has(p.player_id)
        ? '<span class="tag tag-vote">NO SET</span>'
        : "";
      const remove =
        isHost() && p.player_id !== myPlayerId
          ? `<button class="kick-player icon-text-btn" type="button" data-player-id="${p.player_id}" data-player-name="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)}">Remove</button>`
          : "";
      tile.innerHTML = `<span class="name">${escapeHtml(p.name)}${youTag}${p.spectator ? " · watching" : ""}${voteTag}</span><span class="score">${p.score}</span><span class="cooldown"></span>${remove}`;
      if (
        !REDUCED_MOTION &&
        lastScores[p.player_id] !== undefined &&
        lastScores[p.player_id] !== p.score
      ) {
        tile.classList.add("score-bump");
        tile.addEventListener(
          "animationend",
          () => tile.classList.remove("score-bump"),
          { once: true },
        );
      }
      lastScores[p.player_id] = p.score;
      playersEl.appendChild(tile);
    });
    updateLockoutTiles(performance.now());
  }

  function updateScoreboardFromPlayers(players) {
    // Merge fresh scores into the last known snapshot's player list, then
    // re-render. Pass the *current* buzz (not null) -- otherwise a score
    // update mid-buzz would silently drop the active-buzzer highlight.
    if (!latestSnapshot) return;
    const now = performance.now();
    syncLockoutDeadlines(players, now);
    const byId = Object.fromEntries(players.map((p) => [p.player_id, p]));
    latestSnapshot.players = latestSnapshot.players.map(
      (p) => byId[p.player_id] || p,
    );
    renderPlayers(latestSnapshot.players, latestSnapshot.buzz);
    updateControlsEnabled(now);
    ensureTicking();
  }

  function renderGameOver(snapshot) {
    const winners = snapshot.winner_ids.map((id) => nameForIn(snapshot, id));
    document.getElementById("winner-line").textContent =
      winners.length > 1
        ? `It's a tie: ${winners.join(" & ")}!`
        : `${winners[0]} wins!`;

    const sorted = [...snapshot.players].sort((a, b) => b.score - a.score);
    const list = document.getElementById("standings-list");
    list.innerHTML = "";
    sorted.forEach((p) => {
      const li = document.createElement("li");
      if (snapshot.winner_ids.includes(p.player_id))
        li.classList.add("is-winner");
      li.innerHTML = `<span class="row-title">${escapeHtml(p.name)}</span><span class="row-meta">${p.score} ${snapshot.winner_ids.includes(p.player_id) ? "· WINNER" : ""}</span>`;
      list.appendChild(li);
    });

    const playAgainBtn = document.getElementById("play-again-btn");
    const playAgainHint = document.getElementById("play-again-hint");
    playAgainBtn.hidden = !isHost();
    playAgainHint.hidden = isHost();
  }

  function nameForIn(snapshot, id) {
    const p = snapshot.players.find((x) => x.player_id === id);
    return p ? p.name : "Someone";
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // --- unified countdowns: buzz ring, per-player lockouts, reveal freeze --

  function syncLockoutDeadlines(players, now) {
    players.forEach((p) => {
      if (p.locked_out && p.lockout_remaining_ms > 0) {
        lockoutEndsAtByPlayer[p.player_id] = now + p.lockout_remaining_ms;
      } else {
        delete lockoutEndsAtByPlayer[p.player_id];
      }
    });
  }

  function controlsState(now) {
    const spectator = isSpectator();
    const revealMsLeft = revealEndsAt ? Math.max(0, revealEndsAt - now) : 0;
    const revealing = revealMsLeft > 0;
    const buzzActive = !!(latestSnapshot && latestSnapshot.buzz);
    const myDeadline = lockoutEndsAtByPlayer[myPlayerId] || 0;
    const lockoutMsLeft = Math.max(0, myDeadline - now);
    const lockedOut = lockoutMsLeft > 0;
    let label = "I found a SET!";
    if (!connectionReady) {
      label = "Reconnecting…";
    } else if (spectator) {
      label = "Watching this match";
    } else if (revealing) {
      label = `Next round in ${Math.ceil(revealMsLeft / 1000)}s`;
    } else if (lockedOut) {
      label = `Ready again in ${Math.ceil(lockoutMsLeft / 1000)}s`;
    } else if (
      buzzActive &&
      latestSnapshot.buzz.player_id === myPlayerId &&
      selectedCodes.size >= 3
    ) {
      label = "Checking your set…";
    } else if (buzzActive && latestSnapshot.buzz.player_id === myPlayerId) {
      const left = 3 - selectedCodes.size;
      label = `Choose ${left} more card${left === 1 ? "" : "s"}`;
    } else if (buzzActive) {
      label = `${nameFor(latestSnapshot.buzz.player_id)} is choosing`;
    }
    // Voting isn't a claim, so a lockout doesn't block it -- only the
    // connection, spectating, and windows where the board could be about
    // to change out from under the vote (an active buzz or the reveal
    // freeze) do.
    const iVoted = noSetVoters.has(myPlayerId);
    const voteStatus =
      noSetVoters.size > 0 && noSetNeeded > 0
        ? `${noSetVoters.size} of ${noSetNeeded} voted`
        : "";
    return {
      disabled:
        !connectionReady || spectator || revealing || buzzActive || lockedOut,
      voteDisabled: !connectionReady || spectator || revealing || buzzActive,
      voteStatus,
      iVoted,
      label,
      revealing,
      lockedOut,
      buzzActive,
      spectator,
    };
  }

  function updateControlsEnabled(now) {
    now = now || performance.now();
    const state = controlsState(now);
    buzzBtn.disabled = state.disabled;
    noSetBtn.disabled = state.voteDisabled;
    buzzBtn.classList.toggle("cooldown", state.lockedOut && !state.revealing);
    noSetBtn.classList.toggle("voted", state.iVoted);
    buzzLabelEl.textContent = state.label;
    noSetVoteStatusEl.textContent = state.voteStatus;
    updateBoardInteractivity();
  }

  function updateBoardInteractivity() {
    const canSelect = !!(
      latestSnapshot?.buzz &&
      latestSnapshot.buzz.player_id === myPlayerId &&
      buzzDeadline > performance.now() &&
      selectedCodes.size < 3
    );
    boardEl.querySelectorAll(".card").forEach((card) => {
      card.classList.toggle("not-interactive", !canSelect);
      card.tabIndex = canSelect ? 0 : -1;
      card.setAttribute("aria-disabled", String(!canSelect));
    });
  }

  function updateLockoutTiles(now) {
    playersEl
      .querySelectorAll(".player-tile[data-player-id]")
      .forEach((tile) => {
        const pid = tile.dataset.playerId;
        const deadline = lockoutEndsAtByPlayer[pid];
        const cooldownEl = tile.querySelector(".cooldown");
        if (deadline && deadline > now) {
          tile.classList.add("locked-out");
          if (cooldownEl)
            cooldownEl.textContent = `${Math.ceil((deadline - now) / 1000)}s`;
        } else {
          tile.classList.remove("locked-out");
          if (cooldownEl) cooldownEl.textContent = "";
        }
      });
  }

  function updateBuzzRing(now) {
    const left = Math.max(0, buzzDeadline - now);
    const fraction = buzzDurationMs ? Math.min(1, left / buzzDurationMs) : 0;
    buzzRingProgress.style.strokeDashoffset = String(
      RING_CIRCUMFERENCE * (1 - fraction),
    );
    const urgent = left <= 3000;
    buzzRingProgress.classList.toggle("urgent", urgent);
    const wholeSecond = Math.ceil(left / 1000);
    railTimerSeconds.textContent = wholeSecond;
    if (
      wholeSecond !== lastWholeSecond &&
      wholeSecond <= 3 &&
      wholeSecond > 0
    ) {
      SetAudio.tick(true);
    }
    lastWholeSecond = wholeSecond;
  }

  function updateRevealCountdownText(now) {
    if (!revealEndsAt) {
      revealCountdownEl.textContent = "";
      return;
    }
    const left = Math.max(0, revealEndsAt - now);
    revealCountdownEl.textContent =
      left > 0 ? `Back in ${Math.ceil(left / 1000)}s` : "";
  }

  function anyTimersActive(now) {
    if (latestSnapshot && latestSnapshot.buzz) return true;
    if (revealEndsAt && revealEndsAt > now) return true;
    return Object.values(lockoutEndsAtByPlayer).some((t) => t > now);
  }

  // A single ticking loop drives every countdown display (the ring, the
  // button labels, each tile's cooldown text, the reveal countdown) so
  // there's one clock instead of several timers racing to write the same
  // elements. Under reduced motion the numeric countdowns still need to
  // update -- just coarsely (250ms), since there's no ring sweep to
  // justify a 60fps loop.
  let tickHandle = null;
  function ensureTicking() {
    if (tickHandle) return;
    const run = () => {
      const now = performance.now();
      if (latestSnapshot && latestSnapshot.buzz) updateBuzzRing(now);
      updateControlsEnabled(now);
      updateLockoutTiles(now);
      updateRevealCountdownText(now);
      if (anyTimersActive(now)) {
        tickHandle = REDUCED_MOTION
          ? setTimeout(run, 250)
          : requestAnimationFrame(run);
      } else {
        tickHandle = null;
      }
    };
    tickHandle = REDUCED_MOTION
      ? setTimeout(run, 0)
      : requestAnimationFrame(run);
  }

  // --- board rendering + FLIP animation ---------------------------------

  /** Reconciles the board to `cards`, reusing existing DOM nodes keyed by
   * card code instead of wiping and rebuilding everything. Survivors that
   * shift position (the board recompacting after a claim) glide there via
   * FLIP instead of teleporting; `enterCodes` get the deal-in animation. */
  function syncBoard(cards, enterCodes) {
    boardEl.classList.toggle("board-large", cards.length > 12);
    boardEl.classList.toggle("board-xlarge", cards.length > 15);
    boardEl.classList.toggle("board-xxlarge", cards.length > 18);
    const enterSet = new Set(enterCodes || []);
    const existing = new Map();
    boardEl
      .querySelectorAll(".card")
      .forEach((el) => existing.set(Number(el.dataset.code), el));

    const firstRects = new Map();
    if (!REDUCED_MOTION) {
      cards.forEach((card) => {
        const el = existing.get(card.code);
        if (el) firstRects.set(card.code, el.getBoundingClientRect());
      });
    }

    const wanted = new Set(cards.map((c) => c.code));
    existing.forEach((el, code) => {
      if (!wanted.has(code)) el.remove();
    });

    let cursor = null;
    cards.forEach((card) => {
      let el = existing.get(card.code);
      if (!el) {
        el = buildCardElement(card);
        if (enterSet.has(card.code)) {
          el.classList.add("card-enter");
          // The animation fills forward (holds its end transform) until
          // this class is removed -- left in place, it would permanently
          // pin transform to identity and block .selected's own lift.
          el.addEventListener(
            "animationend",
            () => {
              el.classList.remove("card-enter");
              el.style.animationDelay = "";
            },
            { once: true },
          );
        }
      }
      markCardSelected(el, selectedCodes.has(card.code));
      if (cursor) cursor.after(el);
      else boardEl.prepend(el);
      cursor = el;
    });

    if (!REDUCED_MOTION) {
      // Deal-in cards animate from the deck count in the header.
      const deckRect = deckStatusEl.getBoundingClientRect();
      boardEl.querySelectorAll(".card-enter").forEach((el, index) => {
        const r = el.getBoundingClientRect();
        el.style.animationDelay = `${index * 35}ms`;
        el.style.setProperty(
          "--deal-x",
          `${deckRect.left + deckRect.width / 2 - (r.left + r.width / 2)}px`,
        );
        el.style.setProperty(
          "--deal-y",
          `${deckRect.top + deckRect.height / 2 - (r.top + r.height / 2)}px`,
        );
      });

      // FLIP the survivors: invert the just-applied layout change with a
      // transform, then release it so the browser animates back to identity.
      cards.forEach((card) => {
        const el = existing.get(card.code);
        if (!el) return;
        const first = firstRects.get(card.code);
        if (!first) return;
        const last = el.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.setProperty("--flip-x", `${dx}px`);
        el.style.setProperty("--flip-y", `${dy}px`);
        el.classList.add("card-flip", "card-flip-start");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => el.classList.remove("card-flip-start"));
        });
        el.addEventListener(
          "transitionend",
          () => el.classList.remove("card-flip"),
          { once: true },
        );
      });
    }
    updateBoardInteractivity();
  }

  /** Plays the staggered vanish for the claimed cards, then reconciles the
   * board once the animation genuinely finishes (not a hardcoded timeout
   * pinned to the keyframe duration). */
  function animateSetClaim(removedCards, newBoard, addedCards) {
    const addedCodes = addedCards.map((c) => c.code);
    let pending = 0;
    removedCards.forEach((card, i) => {
      const el = boardEl.querySelector(`.card[data-code="${card.code}"]`);
      if (!el) return;
      pending++;
      markCardSelected(el, false);
      el.style.animationDelay = REDUCED_MOTION ? "0ms" : `${i * 60}ms`;
      el.classList.add("card-vanish");
      el.addEventListener(
        "animationend",
        () => {
          pending--;
          if (pending === 0) syncBoard(newBoard, addedCodes);
        },
        { once: true },
      );
    });
    if (pending === 0) syncBoard(newBoard, addedCodes);
  }

  function shakeSelected() {
    selectedCodes.forEach((code) => {
      const el = boardEl.querySelector(`.card[data-code="${code}"]`);
      if (!el) return;
      el.classList.add("card-invalid");
      el.addEventListener(
        "animationend",
        () => {
          el.classList.remove("card-invalid");
          markCardSelected(el, false);
        },
        { once: true },
      );
    });
  }

  /** Returns true if the card was actually actionable (i.e. it's your
   * buzz), false otherwise -- callers use this to decide whether to
   * consume the input event or let it fall through (e.g. to the global
   * Space-to-buzz shortcut). */
  function trySelectCard(cardEl) {
    if (!cardEl || cardEl.classList.contains("card-vanish")) return false;
    const amBuzzer =
      latestSnapshot?.buzz && latestSnapshot.buzz.player_id === myPlayerId;
    if (!amBuzzer) return false;
    socket.emit("select_card", { card: Number(cardEl.dataset.code) });
    return true;
  }

  boardEl.addEventListener("click", (e) => {
    trySelectCard(e.target.closest(".card"));
  });

  // Cards are focusable (see cards.js); Enter/Space activates the focused
  // card -- but only when it's actually your buzz. If a card merely has
  // focus (e.g. left over from a previous click) while it isn't your
  // turn, this must NOT swallow the keypress: it should fall through to
  // the global Space-to-buzz shortcut below instead.
  boardEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.code !== "Space") return;
    const card = e.target.closest(".card");
    if (!card) return;
    if (trySelectCard(card)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // --- set reveal: shared celebration + freeze ----------------------------

  function describeFeatures(cards) {
    return [
      ["shape", "Shape"],
      ["color", "Color"],
      ["number", "Number"],
      ["shading", "Shading"],
    ].map(([key, label]) => {
      const values = cards.map((c) => c[key]);
      return { label, allSame: values.every((v) => v === values[0]) };
    });
  }

  function showReveal(cards, finderName) {
    revealCreditEl.textContent = `${finderName} found a set!`;

    revealCardsEl.innerHTML = "";
    cards.forEach((c) => {
      const el = buildCardElement(c);
      el.tabIndex = -1;
      el.removeAttribute("role");
      el.removeAttribute("aria-pressed");
      revealCardsEl.appendChild(el);
    });

    revealFeaturesEl.innerHTML = "";
    describeFeatures(cards).forEach((f, i) => {
      const span = document.createElement("span");
      span.className = `reveal-feature ${f.allSame ? "all-same" : "all-diff"}`;
      span.style.animationDelay = REDUCED_MOTION ? "0ms" : `${0.3 + i * 0.12}s`;
      span.innerHTML = `<strong>${f.label}</strong> ${f.allSame ? "all same" : "all different"}`;
      revealFeaturesEl.appendChild(span);
    });

    revealOverlay.hidden = false;
  }

  function hideReveal() {
    revealOverlay.hidden = true;
    revealCountdownEl.textContent = "";
  }

  // --- buzz ring + rail --------------------------------------------------

  function startBuzzUI(data) {
    const amBuzzer = data.player_id === myPlayerId;
    boardEl.classList.toggle("dimmed", !amBuzzer);
    statusRailEl.hidden = false;
    railTimerName.textContent = amBuzzer ? "You" : data.name;
    buzzDeadline = performance.now() + data.remaining_ms;
    lastWholeSecond = null;
    updateControlsEnabled();
    updateBoardInteractivity();
    ensureTicking();
  }

  function stopBuzzUI() {
    boardEl.classList.remove("dimmed");
    statusRailEl.hidden = true;
    buzzDeadline = 0;
    updateControlsEnabled();
    updateBoardInteractivity();
  }

  // --- keyboard shortcuts --------------------------------------------------

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    const modal = document.getElementById("how-to-play-modal");
    if (modal && !modal.hidden) return;
    // A focused card handles its own Enter/Space (see boardEl's keydown
    // listener above) and calls stopPropagation, so this only runs when
    // nothing more specific claimed the key first.
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (!controlsState(performance.now()).disabled) socket.emit("buzz");
    } else if (e.key.toLowerCase() === "n") {
      if (!controlsState(performance.now()).voteDisabled)
        socket.emit("vote_no_set");
    }
  });

  // --- controls ------------------------------------------------------------

  root.addEventListener("click", (event) => {
    const button = event.target.closest(".kick-player");
    if (!button || !isHost()) return;
    const name = button.dataset.playerName || "this player";
    if (window.confirm(`Remove ${name} from this game?`)) {
      socket.emit("kick_player", { player_id: button.dataset.playerId });
    }
  });

  buzzBtn.addEventListener("click", () => socket.emit("buzz"));
  noSetBtn.addEventListener("click", () => socket.emit("vote_no_set"));
  document
    .getElementById("start-game-btn")
    .addEventListener("click", () => socket.emit("start_game"));
  document
    .getElementById("play-again-btn")
    .addEventListener("click", () => socket.emit("play_again"));

  const copyLinkBtn = document.getElementById("copy-link-btn");
  const manualCopyEl = document.getElementById("manual-copy");
  const inviteLinkInput = document.getElementById("invite-link-input");

  async function copyText(text) {
    // Do this synchronously while the click's user activation is still
    // live. Waiting for a rejected Clipboard promise first can consume the
    // activation and make this fallback fail on plain-HTTP LAN clients.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    if (copied) return true;

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("clipboard timeout")), 700),
          ),
        ]);
        return true;
      } catch {
        // The caller presents a useful manual-copy instruction below.
      }
    }
    return false;
  }

  copyLinkBtn.addEventListener("click", async () => {
    const originalLabel = copyLinkBtn.textContent;
    copyLinkBtn.disabled = true;
    try {
      const copied = await copyText(window.location.href);
      if (!copied) throw new Error("copy failed");
      manualCopyEl.hidden = true;
      copyLinkBtn.textContent = "Copied!";
      toast("Invite link copied!", "success");
    } catch {
      inviteLinkInput.value = window.location.href;
      manualCopyEl.hidden = false;
      inviteLinkInput.focus();
      inviteLinkInput.select();
      copyLinkBtn.textContent = "Link selected";
      toast("Press Ctrl+C, ⌘C, or choose Copy for the selected link.");
    } finally {
      setTimeout(() => {
        copyLinkBtn.textContent = originalLabel;
        copyLinkBtn.disabled = false;
      }, 1400);
    }
  });
});
