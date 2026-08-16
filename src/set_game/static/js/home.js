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
  const continueBtn = document.getElementById("nickname-continue");
  const createRoomBtn = document.getElementById("create-room-btn");
  const codeInput = document.getElementById("room-code-input");
  const joinRoomBtn = document.getElementById("join-room-btn");
  const connectionEl = document.getElementById("home-connection");

  function showPicker(name) {
    helloName.textContent = name;
    gate.hidden = true;
    picker.hidden = false;
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

  const savedName = sessionStorage.getItem(NICK_KEY);
  if (savedName) showPicker(savedName);
  else showGate("");

  function submitNickname() {
    const name = nickInput.value.trim();
    if (!name) {
      nickError.textContent = "Enter a nickname to continue.";
      nickError.hidden = false;
      return;
    }
    nickError.hidden = true;
    sessionStorage.setItem(NICK_KEY, name);
    showPicker(name);
  }

  nickInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitNickname();
  });
  nickInput.addEventListener("input", () => {
    nickError.hidden = true;
    continueBtn.disabled = !nickInput.value.trim();
  });
  continueBtn.addEventListener("click", submitNickname);
  document
    .getElementById("change-name")
    .addEventListener("click", () =>
      showGate(sessionStorage.getItem(NICK_KEY)),
    );

  const socket = io();
  function setConnection(connected) {
    connectionEl.textContent = connected ? "Ready" : "Reconnecting";
    connectionEl.classList.toggle("is-live", connected);
    connectionEl.classList.toggle("is-offline", !connected);
    createRoomBtn.disabled = !connected;
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
    createRoomBtn.textContent = "Host a new game";
    createRoomBtn.disabled = !socket.connected;
    showLobbyError(data.message);
  });
  socket.on("room_created", (data) => {
    window.location.href = `/room/${data.room_code}`;
  });

  createRoomBtn.addEventListener("click", () => {
    lobbyError.hidden = true;
    createRoomBtn.disabled = true;
    createRoomBtn.textContent = "Creating your game…";
    socket.emit("create_room", { name: sessionStorage.getItem(NICK_KEY) });
  });

  function joinByCode() {
    const code = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    codeInput.value = code;
    if (!CODE_RE.test(code)) {
      showLobbyError("Enter the 10-character invite code from the host.");
      codeInput.focus();
      return;
    }
    window.location.href = `/room/${code}`;
  }
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    joinRoomBtn.disabled = !CODE_RE.test(codeInput.value);
    lobbyError.hidden = true;
  });
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinByCode();
  });
  joinRoomBtn.addEventListener("click", joinByCode);
});
