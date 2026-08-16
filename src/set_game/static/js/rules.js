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
    el.removeAttribute("role");
    el.removeAttribute("aria-pressed");
    el.removeAttribute("aria-label");
    return el;
  }

  const validHost = document.getElementById("htp-valid-cards");
  const invalidHost = document.getElementById("htp-invalid-cards");
  validExample.forEach((c) => validHost.appendChild(buildStaticCard(c)));
  invalidExample.forEach((c) => invalidHost.appendChild(buildStaticCard(c)));

  let lastFocused = null;

  function open() {
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    modal.querySelector(".icon-btn").focus();
    document.addEventListener("keydown", onKeydown);
  }

  function close() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", onKeydown);
    if (lastFocused) lastFocused.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = modal.querySelectorAll(
      "button, [href], input, [tabindex]:not([tabindex='-1'])",
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
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
