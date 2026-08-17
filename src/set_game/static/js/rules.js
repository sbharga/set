/* How-to-play modal: open/close plumbing + the two worked examples,
 * rendered with the real card renderer so they read exactly like the
 * board (see DESCRIPTION.md's worked valid/invalid examples).
 */

document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("how-to-play-modal");
  const openBtn = document.getElementById("how-to-play-btn");
  if (!modal || !openBtn) return;

  const validExample = [
    {
      code: "ex-v1",
      shape: "diamond",
      color: "red",
      number: 1,
      shading: "solid",
    },
    {
      code: "ex-v2",
      shape: "diamond",
      color: "red",
      number: 2,
      shading: "striped",
    },
    {
      code: "ex-v3",
      shape: "diamond",
      color: "red",
      number: 3,
      shading: "open",
    },
  ];
  const invalidExample = [
    { code: "ex-i1", shape: "oval", color: "red", number: 1, shading: "solid" },
    {
      code: "ex-i2",
      shape: "diamond",
      color: "red",
      number: 2,
      shading: "solid",
    },
    {
      code: "ex-i3",
      shape: "squiggle",
      color: "green",
      number: 3,
      shading: "solid",
    },
  ];

  // These are illustrative only (not real board cards), so strip the
  // keyboard-focusability buildCardElement gives real cards -- otherwise
  // they'd be dead tab stops inside the modal.
  function buildStaticCard(card) {
    const el = buildCardElement(card);
    el.tabIndex = -1;
    el.setAttribute("role", "img");
    el.removeAttribute("aria-pressed");
    return el;
  }

  const validHost = document.getElementById("htp-valid-cards");
  const invalidHost = document.getElementById("htp-invalid-cards");
  validExample.forEach((c) => validHost.appendChild(buildStaticCard(c)));
  invalidExample.forEach((c) => invalidHost.appendChild(buildStaticCard(c)));

  let lastFocused = null;
  const background = [
    document.querySelector("header"),
    document.getElementById("main-content"),
  ].filter(Boolean);
  const previousInert = new Map();

  function focusableElements() {
    return [...modal.querySelectorAll(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )].filter((el) => !el.hidden && el.getClientRects().length > 0);
  }

  function open() {
    if (!modal.hidden) return;
    lastFocused = document.activeElement;
    document.dispatchEvent(new CustomEvent("set:close-card-palette"));
    modal.hidden = false;
    background.forEach((el) => {
      previousInert.set(el, el.inert);
      el.inert = true;
    });
    document.body.classList.add("modal-open");
    focusableElements()[0]?.focus();
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("focusin", keepFocusInside);
  }

  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    background.forEach((el) => {
      el.inert = previousInert.get(el) || false;
    });
    previousInert.clear();
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("focusin", keepFocusInside);
    const focusTarget = lastFocused?.isConnected ? lastFocused : openBtn;
    focusTarget.focus();
    lastFocused = null;
  }

  function keepFocusInside(e) {
    if (!modal.contains(e.target)) focusableElements()[0]?.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = focusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  openBtn.addEventListener("click", open);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal
    .querySelectorAll("[data-close-modal]")
    .forEach((b) => b.addEventListener("click", close));
});
