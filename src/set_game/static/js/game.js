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
  if (!(window.crypto && typeof window.crypto.getRandomValues === "function"))
    return null;
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
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
  // Purely cosmetic chunking so the code is easier to read aloud/copy by
  // eye -- copyText() below always uses the unbroken `roomCode`.
  document.getElementById("invite-code").textContent =
    roomCode.length === 10
      ? `${roomCode.slice(0, 5)} ${roomCode.slice(5)}`
      : roomCode;
  const NICK_KEY = "set_nickname";
  const PID_KEY = `set_player_id_${roomCode}`;
  const TOKEN_KEY = `set_player_token_${roomCode}`;

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }
  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }
  function sessionRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (_error) {
      // The terminal error remains usable even if storage cannot be changed.
    }
  }

  const myName = sessionGet(NICK_KEY);
  if (!myName) {
    window.location.href = `/?room=${encodeURIComponent(roomCode)}`;
    return;
  }
  let myPlayerId = sessionGet(PID_KEY);
  let myPlayerToken = sessionGet(TOKEN_KEY);
  const validPlayerId = /^[A-Za-z0-9_-]{16,128}$/.test(myPlayerId || "");
  const validPlayerToken = /^[A-Za-z0-9_-]{32,128}$/.test(
    myPlayerToken || "",
  );
  if (!validPlayerId || !validPlayerToken) {
    myPlayerId = null;
    myPlayerToken = null;
  }
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
    if (!sessionSet(PID_KEY, myPlayerId) || !sessionSet(TOKEN_KEY, myPlayerToken)) {
      root.replaceChildren(
        Object.assign(document.createElement("p"), {
          textContent:
            "Private browsing storage is unavailable. Enable session storage to join this game.",
        }),
      );
      return;
    }
  }

  // --- view elements --------------------------------------------------

  const views = {
    connecting: document.getElementById("connecting-view"),
    waiting: document.getElementById("waiting-view"),
    game: document.getElementById("game-view"),
    gameover: document.getElementById("gameover-view"),
  };
  let visibleView = "connecting";
  function showView(name, focus = true) {
    const changed = visibleView !== name;
    Object.entries(views).forEach(([key, el]) => (el.hidden = key !== name));
    deckStatusEl.hidden = name !== "game";
    visibleView = name;
    if (changed && focus) {
      const heading = views[name].querySelector("h1, h2, [role='heading']");
      requestAnimationFrame(() => heading?.focus());
    }
    // The board is sized from its container's measured rect (sizeBoard,
    // below); that rect is 0x0 while game-view is [hidden], so the very
    // first render after joining needs an explicit re-measure once it's
    // actually visible. (ResizeObserver also fires on this transition,
    // this just avoids waiting on its async callback.)
    if (changed && name === "game") requestAnimationFrame(() => sizeBoard());
  }

  const boardEl = document.getElementById("board");
  const boardStageEl = document.querySelector(".board-stage");
  const playersEl = document.getElementById("players");
  const buzzBtn = document.getElementById("buzz-btn");
  const buzzLabelEl = buzzBtn.querySelector(".btn-label");
  const noSetBtn = document.getElementById("no-set-btn");
  const noSetVoteStatusEl = document.getElementById("no-set-vote-status");
  const deckStatusEl = document.getElementById("deck-status");
  const deckCountEl = document.getElementById("deck-count");
  const stageCaptionEl = document.getElementById("stage-caption");
  const buzzCaptionEl = document.getElementById("buzz-caption");
  const buzzCaptionNameEl = document.getElementById("buzz-caption-name");
  const buzzCaptionSecondsEl = document.getElementById("buzz-caption-seconds");
  const buzzBarFillEl = document.getElementById("buzz-bar-fill");
  const revealCaptionEl = document.getElementById("reveal-caption");
  const revealCreditEl = document.getElementById("reveal-credit");
  const revealFeaturesEl = document.getElementById("reveal-features");
  const revealCountdownEl = document.getElementById("reveal-countdown");
  const toastEl = document.getElementById("toast");
  const gameStatusEl = document.getElementById("game-status");
  const botDifficultySelect = document.getElementById("bot-difficulty-select");
  const botSettingStatusEl = document.getElementById("bot-setting-status");

  const REDUCED_MOTION = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const MOBILE_QUERY = window.matchMedia("(max-width: 640px)");

  let hasJoined = false;
  let connectionReady = false;
  let removedFromRoom = false;
  let joinPending = false;
  let rejectedSelectionPending = false;
  let selectionAnimationGeneration = 0;
  let rovingCardCode = null;
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

  // The claim a reveal is celebrating, held back from the board until the
  // reveal freeze ends so the found cards stay lit in place (not whisked
  // away behind an overlay) and their vanish/recompact is visible when it
  // finally happens. reveal_ended is the normal trigger; ensureTicking's
  // loop and renderSnapshot are the fallbacks if that event is ever
  // dropped (see reveal_ended below and the ensureTicking loop).
  let pendingClaim = null;

  // Waiting-room player rows that have already played their join
  // animation once -- a fresh snapshot rebuilds every <li>, so this is
  // what keeps the animation from replaying for players who were already
  // in the room.
  const seenWaitingPlayerIds = new Set();

  // The pending "no set" vote. Kept outside `latestSnapshot` because
  // `updateScoreboardFromPlayers` replaces player objects wholesale on
  // every score broadcast -- a field living only inside a player object
  // would get silently dropped there. Seeded from `room_state`'s
  // `no_set_vote` and then kept current by the `no_set_vote` event.
  let noSetVoters = new Set();
  let noSetNeeded = 0;

  function announce(message, focus = false) {
    gameStatusEl.textContent = "";
    requestAnimationFrame(() => {
      gameStatusEl.textContent = message;
      if (focus) gameStatusEl.focus();
    });
  }

  function finishOnce(element, eventName, callback, timeoutMs) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      element.removeEventListener(eventName, finish);
      callback();
    };
    const timer = setTimeout(finish, timeoutMs);
    element.addEventListener(eventName, finish, { once: true });
    return finish;
  }

  function toast(message, type) {
    clearTimeout(toastEl._hideTimer);
    clearTimeout(toastEl._fallbackTimer);
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
      const hide = () => {
        clearTimeout(toastEl._fallbackTimer);
        toastEl.removeEventListener("animationend", hide);
        toastEl.hidden = true;
        toastEl._animationHandler = null;
      };
      toastEl._animationHandler = hide;
      toastEl.addEventListener("animationend", hide, { once: true });
      toastEl._fallbackTimer = setTimeout(hide, 450);
    }, 3200);
  }

  // --- socket setup -----------------------------------------------------

  const socket = io();

  function showTerminalConnection(message) {
    connectionReady = false;
    views.connecting.replaceChildren();
    const title = document.createElement("h1");
    title.id = "terminal-connection-title";
    title.className = "status-title";
    title.tabIndex = -1;
    title.textContent = "Unable to join";
    const detail = document.createElement("p");
    detail.textContent = message;
    const backLink = document.createElement("a");
    backLink.href = "/";
    backLink.textContent = "Back to game home";
    views.connecting.append(title, detail);
    if (/credentials|seat belongs/i.test(message)) {
      const newSeat = document.createElement("button");
      newSeat.type = "button";
      newSeat.className = "btn btn-primary";
      newSeat.textContent = "Join with a new seat";
      newSeat.addEventListener("click", () => {
        sessionRemove(PID_KEY);
        sessionRemove(TOKEN_KEY);
        window.location.reload();
      });
      views.connecting.appendChild(newSeat);
    }
    views.connecting.appendChild(backLink);
    showView("connecting");
    requestAnimationFrame(() => title.focus());
  }

  socket.on("connect", () => {
    if (removedFromRoom) return;
    // Stay read-only until the server answers with a fresh room snapshot.
    // Socket.IO may have reconnected after the board changed while this
    // tab was offline.
    connectionReady = false;
    joinPending = true;
    socket.emit("join_room", {
      room_code: roomCode,
      name: myName,
      player_id: myPlayerId,
      player_token: myPlayerToken,
    });
  });

  socket.on("disconnect", (reason) => {
    connectionReady = false;
    joinPending = false;
    if (reason === "io server disconnect" && !removedFromRoom) {
      showTerminalConnection(
        "This player seat was opened in another tab. Reload to take the seat back.",
      );
      return;
    }
    updateControlsEnabled();
    updateConnectionControls();
    if (hasJoined)
      toast("Connection lost. We’re trying to reconnect…", "error");
  });

  socket.on("joined", () => {
    hasJoined = true;
  });

  socket.on("action_error", (data) => {
    if (!hasJoined || joinPending) {
      joinPending = false;
      showTerminalConnection(data.message);
      return;
    }
    toast(data.message, "error");
    announce(data.message);
    if (latestSnapshot?.phase === "lobby") updateBotControl(latestSnapshot);
  });

  socket.on("room_state", (snapshot) => renderSnapshot(snapshot));
  socket.on("players_updated", (data) => {
    if (!latestSnapshot) return;
    const previousPlayers = new Map(
      latestSnapshot.players.map((player) => [player.player_id, player]),
    );
    if (data.title) latestSnapshot.title = data.title;
    latestSnapshot.players = data.players || latestSnapshot.players;
    if (Object.prototype.hasOwnProperty.call(data, "bot_difficulty"))
      latestSnapshot.bot_difficulty = data.bot_difficulty;
    if (data.winner_ids) latestSnapshot.winner_ids = data.winner_ids;
    if (data.no_set_vote) {
      noSetVoters = new Set(data.no_set_vote.voters);
      noSetNeeded = data.no_set_vote.needed;
    }
    if (latestSnapshot.phase === "lobby") renderWaitingView(latestSnapshot);
    else if (latestSnapshot.phase === "playing")
      renderPlayers(latestSnapshot.players, latestSnapshot.buzz);
    else renderGameOver(latestSnapshot);
    const joined = (data.players || []).find(
      (player) => !previousPlayers.has(player.player_id),
    );
    const connectionChanged = (data.players || []).find((player) => {
      const previous = previousPlayers.get(player.player_id);
      return previous && previous.connected !== player.connected;
    });
    if (joined) announce(`${joined.name} joined the game.`);
    else if (connectionChanged)
      announce(
        `${connectionChanged.name} ${connectionChanged.connected ? "reconnected" : "disconnected"}.`,
      );
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
    announce(data.message || "You were removed by the host.");
  });
  socket.on("game_started", (snapshot) => {
    renderSnapshot(snapshot);
    announce("The match has started. Cards are ready.");
    SetAudio.deal();
  });
  socket.on("game_over", (snapshot) => {
    renderSnapshot(snapshot);
    announce(document.getElementById("winner-line").textContent);
    SetAudio.gameOver();
  });

  socket.on("buzz_started", (data) => {
    clearSelectionState();
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
    announce(
      data.player_id === myPlayerId
        ? "You called SET. Choose three cards. You have 10 seconds."
        : `${data.name} called SET and is choosing cards.`,
    );
    if (data.player_id === myPlayerId) focusFirstCard();
    SetAudio.buzzIn();
  });
  socket.on("buzz_ended", () => {
    if (latestSnapshot) latestSnapshot.buzz = null;
    if (!rejectedSelectionPending) clearSelectionState();
    stopBuzzUI();
  });

  function markCardSelected(card, selected) {
    if (!card) return;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  }

  function clearSelectionState() {
    selectionAnimationGeneration++;
    rejectedSelectionPending = false;
    selectedCodes.clear();
    boardEl.querySelectorAll(".card.selected, .card.card-invalid").forEach((card) => {
      card.classList.remove("selected", "card-invalid");
      card.style.animationDelay = "";
      markCardSelected(card, false);
    });
  }

  socket.on("card_selected", (data) => {
    const card = boardEl.querySelector(`.card[data-code="${data.card}"]`);
    if (data.selected) selectedCodes.add(data.card);
    else selectedCodes.delete(data.card);
    if (latestSnapshot?.buzz) {
      latestSnapshot.buzz.selection = [...selectedCodes];
    }
    markCardSelected(card, data.selected);
    updateControlsEnabled();
    if (data.player_id === myPlayerId) SetAudio.click();
  });

  socket.on("set_claimed", (data) => {
    updateScoreboardFromPlayers(data.players);
    deckCountEl.textContent = data.deck_remaining;
    selectedCodes.clear();
    noSetVoters.clear();
    noSetNeeded = 0;
    if (latestSnapshot) {
      latestSnapshot.board = data.board;
      latestSnapshot.deck_remaining = data.deck_remaining;
      latestSnapshot.no_set_vote = { voters: [], needed: 0 };
    }

    revealEndsAt = performance.now() + data.reveal_ms;
    // The vanish + recompact is deferred until the freeze actually ends
    // (reveal_ended, or flushPendingClaim's fallback) so the found cards
    // stay lit in place and that motion is visible instead of hidden
    // behind an overlay.
    pendingClaim = { removed: data.removed, board: data.board, added: data.added };
    showReveal(data.removed, nameFor(data.player_id));
    ensureTicking();
    announce(`${nameFor(data.player_id)} found a valid set and earned one point.`);
    SetAudio.validSet();
  });

  socket.on("set_rejected", (data) => {
    updateScoreboardFromPlayers(data.players);
    rejectedSelectionPending = true;
    shakeSelected();
    const mine = data.player_id === myPlayerId;
    announce(
      mine
        ? `Your set was ${data.reason === "timeout" ? "not completed in time" : "invalid"}. One point lost; locked out for 5 seconds.`
        : `${nameFor(data.player_id)}'s set was ${data.reason === "timeout" ? "not completed in time" : "invalid"}.`,
    );
    SetAudio.invalidSet();
  });

  socket.on("no_set_vote", (data) => {
    noSetVoters = new Set(data.voters);
    noSetNeeded = data.needed;
    if (latestSnapshot)
      renderPlayers(latestSnapshot.players, latestSnapshot.buzz);
    updateControlsEnabled();
    if (data.player_id)
      announce(
        `${nameFor(data.player_id)} ${data.voted ? "voted no set" : "removed their no-set vote"}. ${data.voters.length} of ${data.needed} votes.`,
      );
    if (data.player_id === myPlayerId) SetAudio.click();
  });

  socket.on("cooldown_ended", (data) => {
    delete lockoutEndsAtByPlayer[data.player_id];
    updateScoreboardFromPlayers(data.players);
    if (data.player_id === myPlayerId) announce("Your lockout ended. You can buzz again.");
  });

  socket.on("reveal_ended", (data) => {
    revealEndsAt = 0;
    flushPendingClaim();
    updateScoreboardFromPlayers(data.players);
    announce("Cards are available again.");
  });

  socket.on("cards_dealt", (data) => {
    // The server already emits an empty no_set_vote before this; clearing
    // here too is belt-and-braces against out-of-order delivery.
    noSetVoters = new Set();
    noSetNeeded = 0;
    updateScoreboardFromPlayers(data.players);
    deckCountEl.textContent = data.deck_remaining;
    if (latestSnapshot) {
      latestSnapshot.board = data.board;
      latestSnapshot.deck_remaining = data.deck_remaining;
      latestSnapshot.no_set_vote = { voters: [], needed: 0 };
    }
    syncBoard(data.board, data.added);
    announce(`${data.added.length} cards added. ${data.board.length} cards are in play.`);
    SetAudio.deal();
  });

  // A backgrounded tab only hears about changes via socket pushes; if it
  // reconnected in the background there may have been pushes it missed
  // entirely. Re-announce ourselves on focus and let the server's normal
  // join_room -> room_state reply catch us up, rather than relying solely
  // on socket.io's own reconnect timing.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hasJoined) {
      joinPending = true;
      connectionReady = false;
      updateControlsEnabled();
      updateConnectionControls();
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

  function botDifficultyLabel(difficulty) {
    return difficulty
      ? difficulty.charAt(0).toUpperCase() + difficulty.slice(1)
      : "";
  }

  function appendBotTags(container, player) {
    if (!player.is_bot) return;
    container.appendChild(buildTag("BOT", "tag-bot"));
    const difficulty = botDifficultyLabel(player.bot_difficulty);
    if (difficulty)
      container.appendChild(buildTag(difficulty.toUpperCase(), "tag-bot-level"));
  }

  function updateBotControl(snapshot) {
    const difficulty = snapshot.bot_difficulty || "none";
    botDifficultySelect.value = difficulty;
    const me = snapshot.players.find((p) => p.player_id === myPlayerId);
    botDifficultySelect.disabled = !(
      snapshot.phase === "lobby" &&
      connectionReady &&
      me?.is_host &&
      me.connected
    );
    const status =
      difficulty === "none"
        ? "No bot is playing."
        : `Bot difficulty: ${botDifficultyLabel(difficulty)}.`;
    if (botSettingStatusEl.textContent !== status)
      botSettingStatusEl.textContent = status;
  }

  function renderSnapshot(snapshot) {
    const previousPhase = latestSnapshot?.phase;
    joinPending = false;
    connectionReady = true;
    latestSnapshot = snapshot;
    document.getElementById("game-title").textContent = snapshot.title;
    if (previousPhase && previousPhase !== snapshot.phase) lastScores = {};
    const now = performance.now();
    syncLockoutDeadlines(snapshot.players, now);
    // Mid-reveal reconnect: we don't have the claimed cards to replay the
    // celebration, but we still must enforce the shared freeze so this
    // client can't buzz early -- reveal_remaining_ms carries the residual.
    revealEndsAt =
      snapshot.reveal_remaining_ms > 0 ? now + snapshot.reveal_remaining_ms : 0;
    // A full snapshot is authoritative on its own (syncBoard below
    // reconciles straight to snapshot.board), so any claim animation this
    // client was mid-deferring is moot -- discard it rather than risk
    // replaying it against now-stale card codes.
    pendingClaim = null;
    if (!revealEndsAt) hideReveal();
    else if (revealCaptionEl.hidden) showReveal([], "A player");
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
      updateConnectionControls();
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
    updateBotControl(snapshot);
    const list = document.getElementById("waiting-player-list");
    const focusedPlayerId = document.activeElement?.classList?.contains("kick-player")
      ? document.activeElement.dataset.playerId
      : null;
    list.replaceChildren();
    snapshot.players.forEach((p) => {
      const li = document.createElement("li");
      // The list is rebuilt from scratch on every render, so gate the
      // entrance animation on a persisted seen-IDs set -- otherwise every
      // row would replay it on every unrelated update (e.g. someone else
      // changing the bot difficulty).
      if (!REDUCED_MOTION && !seenWaitingPlayerIds.has(p.player_id)) {
        li.classList.add("player-enter");
      }
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = p.name;
      const actions = document.createElement("span");
      if (p.is_host) actions.appendChild(buildTag("HOST"));
      if (p.player_id === myPlayerId) actions.appendChild(buildTag("YOU"));
      appendBotTags(actions, p);
      if (!p.connected) actions.appendChild(buildTag("OFFLINE", "tag-offline"));
      const remove = buildRemoveButton(p, "link-btn");
      if (remove) actions.appendChild(remove);
      li.append(title, actions);
      list.appendChild(li);
    });
    snapshot.players.forEach((p) => seenWaitingPlayerIds.add(p.player_id));
    if (focusedPlayerId) {
      list
        .querySelector(`.kick-player[data-player-id="${focusedPlayerId}"]`)
        ?.focus();
    }
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
      startBtn.disabled = !connectionReady || activeCount < 2;
      hint.textContent =
        activeCount < 2 ? "Need at least 2 players to start." : "";
    } else {
      startBtn.hidden = true;
      hint.textContent = "Waiting for the host to start the game…";
    }
  }

  function renderPlayers(players, buzz) {
    const focusedPlayerId = document.activeElement?.classList?.contains("kick-player")
      ? document.activeElement.dataset.playerId
      : null;
    playersEl.replaceChildren();
    players.forEach((p) => {
      const tile = document.createElement("div");
      tile.className = "player-tile";
      tile.setAttribute("role", "listitem");
      tile.dataset.playerId = p.player_id;
      if (p.spectator) tile.classList.add("spectator");
      if (buzz && buzz.player_id === p.player_id)
        tile.classList.add("active-buzzer");
      if (noSetVoters.has(p.player_id)) tile.classList.add("voted-no-set");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${p.name}${p.player_id === myPlayerId ? " (you)" : ""}${p.spectator ? " · watching" : ""}`;
      appendBotTags(name, p);
      if (noSetVoters.has(p.player_id))
        name.appendChild(buildTag("NO SET", "tag-vote"));
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = p.score;
      const cooldown = document.createElement("span");
      cooldown.className = "cooldown";
      tile.append(name, score, cooldown);
      const remove = buildRemoveButton(p, "icon-text-btn");
      if (remove) tile.appendChild(remove);
      if (
        !REDUCED_MOTION &&
        lastScores[p.player_id] !== undefined &&
        lastScores[p.player_id] !== p.score
      ) {
        tile.classList.add("score-bump");
        finishOnce(
          tile,
          "animationend",
          () => tile.classList.remove("score-bump"),
          650,
        );
      }
      lastScores[p.player_id] = p.score;
      const states = [];
      if (p.is_bot)
        states.push(`${botDifficultyLabel(p.bot_difficulty) || "computer"} bot`);
      if (p.spectator) states.push("watching");
      if (buzz?.player_id === p.player_id) states.push("choosing cards");
      if (noSetVoters.has(p.player_id)) states.push("voted no set");
      const baseLabel = `${p.name}, ${p.score} point${p.score === 1 ? "" : "s"}${states.length ? `, ${states.join(", ")}` : ""}`;
      tile.dataset.baseLabel = baseLabel;
      tile.setAttribute("aria-label", baseLabel);
      playersEl.appendChild(tile);
    });
    if (focusedPlayerId) {
      playersEl
        .querySelector(`.kick-player[data-player-id="${focusedPlayerId}"]`)
        ?.focus();
    }
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
    list.replaceChildren();
    sorted.forEach((p) => {
      const li = document.createElement("li");
      if (snapshot.winner_ids.includes(p.player_id))
        li.classList.add("is-winner");
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = p.name;
      appendBotTags(title, p);
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = `${p.score} ${snapshot.winner_ids.includes(p.player_id) ? "· WINNER" : ""}`;
      li.append(title, meta);
      list.appendChild(li);
    });

    const playAgainBtn = document.getElementById("play-again-btn");
    const playAgainHint = document.getElementById("play-again-hint");
    playAgainBtn.hidden = !isHost();
    playAgainBtn.disabled = !connectionReady;
    playAgainHint.hidden = isHost();
  }

  function nameForIn(snapshot, id) {
    const p = snapshot.players.find((x) => x.player_id === id);
    return p ? p.name : "Someone";
  }

  function buildTag(text, extraClass) {
    const tag = document.createElement("span");
    tag.className = `tag${extraClass ? ` ${extraClass}` : ""}`;
    tag.textContent = text;
    return tag;
  }

  function buildRemoveButton(player, extraClass) {
    if (!isHost() || player.is_bot || player.player_id === myPlayerId) return null;
    const button = document.createElement("button");
    button.className = `kick-player ${extraClass}`;
    button.type = "button";
    button.dataset.playerId = player.player_id;
    button.dataset.playerName = player.name;
    button.ariaLabel = `Remove ${player.name}`;
    button.textContent = "Remove";
    button.disabled = !connectionReady;
    return button;
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
    const playing = latestSnapshot?.phase === "playing";
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
        !playing || !connectionReady || spectator || revealing || buzzActive || lockedOut,
      voteDisabled:
        !playing || !connectionReady || spectator || revealing || buzzActive,
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
    noSetBtn.setAttribute("aria-pressed", String(state.iVoted));
    buzzLabelEl.textContent = state.label;
    noSetVoteStatusEl.textContent = state.voteStatus;
    updateBoardInteractivity();
  }

  function updateConnectionControls() {
    root
      .querySelectorAll(
        "#start-game-btn, #play-again-btn, #bot-difficulty-select, .kick-player",
      )
      .forEach((button) => {
        if (!connectionReady) button.disabled = true;
      });
  }

  function canSelectCard() {
    return !!(
      connectionReady &&
      latestSnapshot?.phase === "playing" &&
      latestSnapshot.buzz?.player_id === myPlayerId &&
      buzzDeadline > performance.now() &&
      selectedCodes.size < 3
    );
  }

  function focusFirstCard() {
    if (!canSelectCard()) return;
    const first = boardEl.querySelector(".card:not(.card-vanish)");
    if (!first) return;
    rovingCardCode = Number(first.dataset.code);
    updateBoardInteractivity();
    first.focus();
  }

  function updateBoardInteractivity() {
    const canSelect = canSelectCard();
    const cards = [...boardEl.querySelectorAll(".card")];
    if (
      canSelect &&
      !cards.some((card) => Number(card.dataset.code) === rovingCardCode)
    ) {
      rovingCardCode = cards.length ? Number(cards[0].dataset.code) : null;
    }
    cards.forEach((card) => {
      card.classList.toggle("not-interactive", !canSelect);
      card.tabIndex =
        canSelect && Number(card.dataset.code) === rovingCardCode ? 0 : -1;
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
          const seconds = Math.ceil((deadline - now) / 1000);
          tile.classList.add("locked-out");
          if (cooldownEl) cooldownEl.textContent = `${seconds}s`;
          tile.setAttribute(
            "aria-label",
            `${tile.dataset.baseLabel}, locked out for ${seconds} seconds`,
          );
        } else {
          tile.classList.remove("locked-out");
          if (cooldownEl) cooldownEl.textContent = "";
          tile.setAttribute("aria-label", tile.dataset.baseLabel || "Player");
        }
      });
  }

  function updateBuzzTimer(now) {
    const left = Math.max(0, buzzDeadline - now);
    const fraction = buzzDurationMs ? Math.min(1, left / buzzDurationMs) : 0;
    buzzBarFillEl.style.width = `${fraction * 100}%`;
    const urgent = left <= 3000;
    buzzBarFillEl.classList.toggle("urgent", urgent);
    const wholeSecond = Math.ceil(left / 1000);
    buzzCaptionSecondsEl.textContent = wholeSecond;
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
    if (latestSnapshot?.buzz && buzzDeadline > now) return true;
    if (revealEndsAt && revealEndsAt > now) return true;
    return Object.values(lockoutEndsAtByPlayer).some((t) => t > now);
  }

  // A single ticking loop drives every countdown display (the buzz bar,
  // the button labels, each tile's cooldown text, the reveal countdown) so
  // there's one clock instead of several timers racing to write the same
  // elements. Under reduced motion the numeric countdowns still need to
  // update -- just coarsely (250ms), since there's no bar sweep to
  // justify a 60fps loop.
  let tickHandle = null;
  function ensureTicking() {
    if (tickHandle) return;
    const run = () => {
      const now = performance.now();
      // Fallback for a dropped reveal_ended: the server is still the
      // source of truth (see the module comment at the top of this file),
      // but if its event never lands, this local deadline is what
      // guarantees the found cards don't stay lit and the board doesn't
      // stay frozen forever.
      if (revealEndsAt && now >= revealEndsAt) flushPendingClaim();
      if (latestSnapshot && latestSnapshot.buzz) updateBuzzTimer(now);
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

  // --- board sizing --------------------------------------------------------

  /** Measures .board-stage (a flex box that always fills the remaining
   * stage space regardless of the board's own size -- no feedback loop)
   * and picks the row/column split and card width that best fills it for
   * `count` cards, replacing the old hand-tuned dvh/vw clamp guess and the
   * board-large/xlarge/xxlarge density classes it required. Mobile stays
   * fixed at 3 columns (that axis is a real layout-mode switch, handled in
   * CSS); desktop searches a small range of row counts for the one that
   * yields the biggest card. */
  function sizeBoard(count) {
    const n = count || boardEl.children.length;
    if (!n) return;
    const frameRect = boardStageEl.getBoundingClientRect();
    if (frameRect.width < 1 || frameRect.height < 1) return;
    const gap = Math.max(8, Math.min(window.innerWidth * 0.013, 16));
    const mobile = MOBILE_QUERY.matches;
    let rows;
    let width;
    if (mobile) {
      const cols = 3;
      rows = Math.max(1, Math.ceil(n / cols));
      const wFromWidth = (frameRect.width - (cols - 1) * gap) / cols;
      const wFromHeight =
        ((frameRect.height - (rows - 1) * gap) / rows) * (3 / 4);
      width = Math.min(wFromWidth, wFromHeight);
    } else {
      let best = null;
      const maxRows = Math.min(Math.max(n, 3), 8);
      for (let r = 3; r <= maxRows; r++) {
        const cols = Math.ceil(n / r);
        const wFromWidth = (frameRect.width - (cols - 1) * gap) / cols;
        const wFromHeight =
          ((frameRect.height - (r - 1) * gap) / r) * (3 / 4);
        const candidate = Math.min(wFromWidth, wFromHeight);
        if (candidate > 0 && (!best || candidate > best.width))
          best = { rows: r, width: candidate };
      }
      ({ rows, width } = best || { rows: 3, width: 88 });
    }
    const clamped = Math.max(72, Math.min(165, width));
    boardEl.style.setProperty("--card-w", `${clamped}px`);
    if (!mobile) boardEl.style.setProperty("--board-rows", String(rows));
  }

  function onBoardContainerResize() {
    sizeBoard();
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onBoardContainerResize).observe(boardStageEl);
  }
  MOBILE_QUERY.addEventListener("change", onBoardContainerResize);

  // --- board rendering + FLIP animation ---------------------------------

  /** Reconciles the board to `cards`, reusing existing DOM nodes keyed by
   * card code instead of wiping and rebuilding everything. Survivors that
   * shift position (the board recompacting after a claim) glide there via
   * FLIP instead of teleporting; `enterCodes` get the deal-in animation. */
  function syncBoard(cards, enterCodes) {
    // Applied before the FLIP "First" capture below, mirroring how the
    // density classes this replaced were toggled at this same point: a
    // custom-property size change is a hard cut (no DOM mutation, nothing
    // for FLIP to invert), so it can land before First without disturbing
    // the position-only glide FLIP animates afterward.
    sizeBoard(cards.length);
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
          finishOnce(
            el,
            "animationend",
            () => {
              el.classList.remove("card-enter");
              el.style.animationDelay = "";
            },
            700 + cards.length * 35,
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
        if (el._finishFlip) el._finishFlip();
        el.style.setProperty("--flip-x", `${dx}px`);
        el.style.setProperty("--flip-y", `${dy}px`);
        el.classList.add("card-flip", "card-flip-start");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => el.classList.remove("card-flip-start"));
        });
        let flipFinished = false;
        const finishFlip = () => {
          if (flipFinished) return;
          flipFinished = true;
          clearTimeout(flipFallback);
          el.removeEventListener("transitionend", onFlipEnd);
          el.classList.remove("card-flip", "card-flip-start");
          if (el._finishFlip === finishFlip) el._finishFlip = null;
        };
        const onFlipEnd = (event) => {
          if (event.target === el && event.propertyName === "transform")
            finishFlip();
        };
        const flipFallback = setTimeout(finishFlip, 550);
        el._finishFlip = finishFlip;
        el.addEventListener("transitionend", onFlipEnd);
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
    let focusWasRemoved = false;
    const finishCard = () => {
      pending--;
      if (pending !== 0) return;
      syncBoard(newBoard, addedCodes);
      if (focusWasRemoved) gameStatusEl.focus();
    };
    removedCards.forEach((card, i) => {
      const el = boardEl.querySelector(`.card[data-code="${card.code}"]`);
      if (!el) return;
      pending++;
      if (el === document.activeElement) focusWasRemoved = true;
      markCardSelected(el, false);
      el.style.animationDelay = REDUCED_MOTION ? "0ms" : `${i * 60}ms`;
      el.classList.add("card-vanish");
      finishOnce(
        el,
        "animationend",
        finishCard,
        650 + i * 60,
      );
    });
    if (pending === 0) syncBoard(newBoard, addedCodes);
  }

  function shakeSelected() {
    const codes = [...selectedCodes];
    const generation = ++selectionAnimationGeneration;
    let pending = 0;
    const finishInvalid = (el, code) => {
      if (el._invalidGeneration === generation) {
        el.classList.remove("card-invalid");
        el.style.animationDelay = "";
        markCardSelected(el, selectedCodes.has(code));
      }
      pending--;
      if (pending === 0 && selectionAnimationGeneration === generation)
        rejectedSelectionPending = false;
    };
    codes.forEach((code) => {
      const el = boardEl.querySelector(`.card[data-code="${code}"]`);
      if (!el) return;
      pending++;
      el._invalidGeneration = generation;
      markCardSelected(el, false);
      el.classList.add("card-invalid");
      finishOnce(
        el,
        "animationend",
        () => finishInvalid(el, code),
        550,
      );
    });
    selectedCodes.clear();
    if (pending === 0 && selectionAnimationGeneration === generation)
      rejectedSelectionPending = false;
  }

  /** Returns true if the card was actually actionable (i.e. it's your
   * buzz), false otherwise -- callers use this to decide whether to
   * consume the input event or let it fall through (e.g. to the global
   * Space-to-buzz shortcut). */
  function trySelectCard(cardEl) {
    if (!cardEl || cardEl.classList.contains("card-vanish")) return false;
    if (!canSelectCard() || cardEl.getAttribute("aria-disabled") === "true")
      return false;
    socket.emit("select_card", { card: Number(cardEl.dataset.code) });
    return true;
  }

  function moveCardFocus(current, direction) {
    const currentRect = current.getBoundingClientRect();
    const originX = currentRect.left + currentRect.width / 2;
    const originY = currentRect.top + currentRect.height / 2;
    let best = null;
    let bestScore = Infinity;
    boardEl.querySelectorAll(".card:not(.card-vanish)").forEach((candidate) => {
      if (candidate === current) return;
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - originX;
      const dy = rect.top + rect.height / 2 - originY;
      const inDirection =
        (direction === "left" && dx < -1) ||
        (direction === "right" && dx > 1) ||
        (direction === "up" && dy < -1) ||
        (direction === "down" && dy > 1);
      if (!inDirection) return;
      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      const score = primary + secondary * 2;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    if (!best) return;
    rovingCardCode = Number(best.dataset.code);
    updateBoardInteractivity();
    best.focus();
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
    const directions = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    if (directions[e.key]) {
      const card = e.target.closest(".card");
      if (card && canSelectCard()) {
        e.preventDefault();
        moveCardFocus(card, directions[e.key]);
      }
      return;
    }
    if (e.key !== "Enter" && e.key !== " " && e.code !== "Space") return;
    const card = e.target.closest(".card");
    if (!card) return;
    if (trySelectCard(card)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  boardEl.addEventListener("focusin", (e) => {
    const card = e.target.closest(".card");
    if (card) rovingCardCode = Number(card.dataset.code);
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

  /** Lights the found cards up in place on the board (instead of the old
   * overlay's duplicate row) and dims the rest via .board.revealing, so
   * you learn *where* the set was. The actual vanish + recompact is
   * deferred until the freeze ends -- see set_claimed/reveal_ended and
   * flushPendingClaim -- so that motion is visible too, not hidden behind
   * a backdrop. */
  function showReveal(cards, finderName) {
    revealCreditEl.textContent =
      cards.length > 0 ? `${finderName} found a set!` : "A set was found!";

    boardEl.classList.add("revealing");
    boardEl
      .querySelectorAll(".card.card-found")
      .forEach((el) => el.classList.remove("card-found"));
    cards.forEach((c) => {
      boardEl
        .querySelector(`.card[data-code="${c.code}"]`)
        ?.classList.add("card-found");
    });

    revealFeaturesEl.replaceChildren();
    (cards.length === 3 ? describeFeatures(cards) : []).forEach((f, i) => {
      const span = document.createElement("span");
      span.className = `reveal-feature ${f.allSame ? "all-same" : "all-diff"}`;
      span.style.animationDelay = REDUCED_MOTION ? "0ms" : `${0.15 + i * 0.08}s`;
      const label = document.createElement("strong");
      label.textContent = f.label;
      span.append(label, ` ${f.allSame ? "all same" : "all different"}`);
      revealFeaturesEl.appendChild(span);
    });

    buzzCaptionEl.hidden = true;
    revealCaptionEl.hidden = false;
    stageCaptionEl.classList.add("is-active");
  }

  function hideReveal() {
    revealCaptionEl.hidden = true;
    if (buzzCaptionEl.hidden) stageCaptionEl.classList.remove("is-active");
    revealCountdownEl.textContent = "";
    boardEl.classList.remove("revealing");
    boardEl
      .querySelectorAll(".card.card-found")
      .forEach((el) => el.classList.remove("card-found"));
  }

  /** The normal path out of a reveal: clears the freeze and plays the
   * deferred vanish + recompact for the claim it was celebrating. Also
   * the fallback path (see ensureTicking and renderSnapshot) for when
   * reveal_ended never arrives. */
  function flushPendingClaim() {
    const claim = pendingClaim;
    pendingClaim = null;
    revealEndsAt = 0;
    hideReveal();
    if (claim) animateSetClaim(claim.removed, claim.board, claim.added);
  }

  // --- buzz timer: board perimeter + caption ------------------------------

  function startBuzzUI(data) {
    const amBuzzer = data.player_id === myPlayerId;
    boardEl.classList.toggle("dimmed", !amBuzzer);
    buzzCaptionNameEl.textContent = amBuzzer ? "You" : data.name;
    buzzBarFillEl.style.width = "100%";
    buzzBarFillEl.classList.remove("urgent");
    revealCaptionEl.hidden = true;
    buzzCaptionEl.hidden = false;
    stageCaptionEl.classList.add("is-active");
    buzzDeadline = performance.now() + data.remaining_ms;
    lastWholeSecond = null;
    updateControlsEnabled();
    updateBoardInteractivity();
    ensureTicking();
  }

  function stopBuzzUI() {
    boardEl.classList.remove("dimmed");
    buzzCaptionEl.hidden = true;
    if (revealCaptionEl.hidden) stageCaptionEl.classList.remove("is-active");
    buzzDeadline = 0;
    updateControlsEnabled();
    updateBoardInteractivity();
  }

  // --- keyboard shortcuts --------------------------------------------------

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (latestSnapshot?.phase !== "playing") return;
    if (e.target.closest("button, a, input, textarea, select, [contenteditable]"))
      return;
    const modal = document.getElementById("how-to-play-modal");
    if (modal && !modal.hidden) return;
    // A focused card handles its own Enter/Space (see boardEl's keydown
    // listener above) and calls stopPropagation, so this only runs when
    // nothing more specific claimed the key first.
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (!controlsState(performance.now()).disabled) socket.emit("buzz");
      return;
    }
    if (e.key.toLowerCase() === "n") {
      if (!controlsState(performance.now()).voteDisabled)
        socket.emit("vote_no_set");
      return;
    }
  });

  // --- controls ------------------------------------------------------------

  root.addEventListener("click", (event) => {
    const button = event.target.closest(".kick-player");
    if (!button || !isHost() || !connectionReady) return;
    const name = button.dataset.playerName || "this player";
    if (window.confirm(`Remove ${name} from this game?`)) {
      socket.emit("kick_player", { player_id: button.dataset.playerId });
    }
  });

  buzzBtn.addEventListener("click", () => socket.emit("buzz"));
  noSetBtn.addEventListener("click", () => socket.emit("vote_no_set"));
  botDifficultySelect.addEventListener("change", () => {
    const difficulty = botDifficultySelect.value;
    if (
      !["none", "easy", "medium", "hard"].includes(difficulty) ||
      !isHost() ||
      !connectionReady ||
      latestSnapshot?.phase !== "lobby"
    )
      return;
    socket.emit("configure_bot", { difficulty });
  });
  document
    .getElementById("start-game-btn")
    .addEventListener("click", () => socket.emit("start_game"));
  document
    .getElementById("play-again-btn")
    .addEventListener("click", () => socket.emit("play_again"));

  const copyLinkBtn = document.getElementById("copy-link-btn");
  const manualCopyEl = document.getElementById("manual-copy");
  const inviteLinkInput = document.getElementById("invite-link-input");
  const inviteUrl = new URL(`/room/${roomCode}`, window.location.origin).href;

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

  let copyInProgress = false;
  copyLinkBtn.addEventListener("click", async () => {
    if (copyInProgress) return;
    copyInProgress = true;
    const originalLabel = copyLinkBtn.textContent;
    copyLinkBtn.setAttribute("aria-disabled", "true");
    copyLinkBtn.setAttribute("aria-busy", "true");
    try {
      const copied = await copyText(inviteUrl);
      if (!copied) throw new Error("copy failed");
      manualCopyEl.hidden = true;
      copyLinkBtn.textContent = "Copied!";
      toast("Invite link copied!", "success");
    } catch {
      inviteLinkInput.value = inviteUrl;
      manualCopyEl.hidden = false;
      inviteLinkInput.focus();
      inviteLinkInput.select();
      copyLinkBtn.textContent = "Link selected";
      toast("Press Ctrl+C, ⌘C, or choose Copy for the selected link.");
    } finally {
      setTimeout(() => {
        copyLinkBtn.textContent = originalLabel;
        copyLinkBtn.removeAttribute("aria-disabled");
        copyLinkBtn.removeAttribute("aria-busy");
        copyInProgress = false;
      }, 1400);
    }
  });
});
