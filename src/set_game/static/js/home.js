/* Private-game entry: create a room or open a host-provided invite code.
 * Rooms are intentionally never listed or discoverable from this page. */

document.addEventListener("DOMContentLoaded", () => {
  const NICK_KEY = "set_nickname";
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
  const gate = document.getElementById("nickname-gate");
  const picker = document.getElementById("lobby-picker");
  const nickInput = document.getElementById("nickname-input");
  const nickError = document.getElementById("nickname-error");
  const helloName = document.getElementById("hello-name");
  const lobbyError = document.getElementById("lobby-error");
  const codeError = document.getElementById("room-code-error");
  const continueBtn = document.getElementById("nickname-continue");
  const createRoomBtn = document.getElementById("create-room-btn");
  const codeInput = document.getElementById("room-code-input");
  const joinRoomBtn = document.getElementById("join-room-btn");
  const requestedRoom = new URLSearchParams(window.location.search)
    .get("room")
    ?.toUpperCase();

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
  function continueToInvite() {
    if (!requestedRoom || !CODE_RE.test(requestedRoom)) return false;
    window.location.href = `/room/${requestedRoom}`;
    return true;
  }

  function showPicker(name) {
    helloName.textContent = name;
    gate.hidden = true;
    picker.hidden = false;
    requestAnimationFrame(() => document.getElementById("ready-title").focus());
  }
  function showGate(prefill) {
    gate.hidden = false;
    picker.hidden = true;
    nickInput.value = prefill || "";
    nickInput.focus();
    continueBtn.disabled = !nickInput.value.trim();
  }
  function showLobbyError(message) {
    lobbyError.textContent = message;
    lobbyError.hidden = false;
  }

  const savedName = sessionGet(NICK_KEY);
  if (savedName) {
    if (continueToInvite()) return;
    showPicker(savedName);
  } else {
    showGate("");
  }

  function submitNickname() {
    const name = nickInput.value.trim();
    if (!name) {
      nickError.textContent = "Enter a nickname to continue.";
      nickError.hidden = false;
      nickInput.setAttribute("aria-invalid", "true");
      return;
    }
    nickError.hidden = true;
    nickInput.removeAttribute("aria-invalid");
    if (!sessionSet(NICK_KEY, name)) {
      nickError.textContent = "Session storage is unavailable in this browser.";
      nickError.hidden = false;
      nickInput.setAttribute("aria-invalid", "true");
      return;
    }
    if (!continueToInvite()) showPicker(name);
  }

  nickInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitNickname();
  });
  nickInput.addEventListener("input", () => {
    nickError.hidden = true;
    nickInput.removeAttribute("aria-invalid");
    continueBtn.disabled = !nickInput.value.trim();
  });
  continueBtn.addEventListener("click", submitNickname);
  document
    .getElementById("change-name")
    .addEventListener("click", () =>
      showGate(sessionGet(NICK_KEY)),
    );

  const socket = io();
  let createTimeout = null;
  function setConnection(connected) {
    createRoomBtn.disabled = !connected;
    if (!connected) clearTimeout(createTimeout);
    if (connected) lobbyError.hidden = true;
    if (connected || createRoomBtn.textContent !== "Host a new game")
      createRoomBtn.textContent = "Host a new game";
  }
  socket.on("connect", () => setConnection(true));
  socket.on("disconnect", () => setConnection(false));
  socket.on("connect_error", () => {
    setConnection(false);
    showLobbyError(
      "We can’t reach the game server yet. Check your connection and try again.",
    );
  });
  socket.on("action_error", (data) => {
    clearTimeout(createTimeout);
    createRoomBtn.textContent = "Host a new game";
    createRoomBtn.disabled = !socket.connected;
    showLobbyError(data.message);
  });
  socket.on("room_created", (data) => {
    clearTimeout(createTimeout);
    window.location.href = `/room/${data.room_code}`;
  });

  createRoomBtn.addEventListener("click", () => {
    lobbyError.hidden = true;
    createRoomBtn.disabled = true;
    createRoomBtn.textContent = "Creating your game…";
    socket.emit("create_room", { name: sessionGet(NICK_KEY) });
    clearTimeout(createTimeout);
    createTimeout = setTimeout(() => {
      createRoomBtn.textContent = "Host a new game";
      createRoomBtn.disabled = !socket.connected;
      showLobbyError("Creating the game took too long. Please try again.");
    }, 5000);
  });

  function joinByCode() {
    const code = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    codeInput.value = code;
    if (!CODE_RE.test(code)) {
      codeError.textContent = "Enter the 10-character invite code from the host.";
      codeError.hidden = false;
      codeInput.setAttribute("aria-invalid", "true");
      codeInput.focus();
      return;
    }
    window.location.href = `/room/${code}`;
  }
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    joinRoomBtn.disabled = !CODE_RE.test(codeInput.value);
    codeError.hidden = true;
    codeInput.removeAttribute("aria-invalid");
  });
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinByCode();
  });
  joinRoomBtn.addEventListener("click", joinByCode);
});
