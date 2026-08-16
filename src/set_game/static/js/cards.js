/* Renders a SET card as an inline SVG. Cards arrive from the server as
 * { code, shape, color, number, shading } — see deck.py:Card.to_dict.
 *
 * Symbols reference shared <path> defs (base.html) via <use>, so shape
 * geometry lives in exactly one place and every card just repositions
 * and re-colors it.
 */

// CSS owns the default palette. Capture it before applying any saved inline
// overrides so reset always returns to the stylesheet's canonical colors.
const DEFAULT_CARD_PALETTE = (() => {
  const root = getComputedStyle(document.documentElement);
  const read = (name, fallback) =>
    root.getPropertyValue(name).trim() || fallback;
  return Object.freeze({
    red: read("--card-red", "#c0392b"),
    green: read("--card-green", "#1e8449"),
    purple: read("--card-purple", "#6c3483"),
  });
})();
const CARD_PALETTE_KEY = "set_card_palette";
const CARD_COLOR_NAMES = Object.keys(DEFAULT_CARD_PALETTE);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function validCardPalette(value) {
  if (!value || typeof value !== "object") return null;
  const palette = {};
  for (const name of CARD_COLOR_NAMES) {
    if (typeof value[name] !== "string" || !HEX_COLOR.test(value[name]))
      return null;
    palette[name] = value[name].toLowerCase();
  }
  return palette;
}

function readSavedCardPalette() {
  try {
    return validCardPalette(JSON.parse(localStorage.getItem(CARD_PALETTE_KEY)));
  } catch (_error) {
    return null;
  }
}

let activeCardPalette = readSavedCardPalette() || { ...DEFAULT_CARD_PALETTE };

function applyCardPalette(palette) {
  activeCardPalette = { ...palette };
  CARD_COLOR_NAMES.forEach((name) => {
    document.documentElement.style.setProperty(
      `--card-${name}`,
      activeCardPalette[name],
    );
  });
}

function saveCardPalette(palette) {
  applyCardPalette(palette);
  try {
    localStorage.setItem(CARD_PALETTE_KEY, JSON.stringify(activeCardPalette));
  } catch (_error) {
    // The visual change still works when browser storage is unavailable.
  }
}

// Apply saved preferences as soon as this shared script loads, before the
// board or how-to-play examples create any card SVGs.
applyCardPalette(activeCardPalette);

const SYMBOL_Y_POSITIONS = {
  1: [110],
  2: [68, 152],
  3: [36, 110, 184],
};

function symbolFillStroke(color, shading) {
  // CSS variable references stay live inside SVG attributes, so changing a
  // picker recolors cards already on screen without rebuilding their DOM.
  const cssColor = `var(--card-${color})`;
  if (shading === "solid")
    return { fill: cssColor, stroke: cssColor, strokeWidth: 2 };
  if (shading === "open")
    return { fill: "none", stroke: cssColor, strokeWidth: 3 };
  // striped
  return { fill: `url(#stripes-${color})`, stroke: cssColor, strokeWidth: 2 };
}

/** Returns an SVG markup string (viewBox 0 0 160 220) for the given card. */
function cardSVGMarkup(card) {
  const ys = SYMBOL_Y_POSITIONS[card.number];
  const { fill, stroke, strokeWidth } = symbolFillStroke(
    card.color,
    card.shading,
  );
  const uses = ys
    .map(
      (y) =>
        `<use href="#sym-${card.shape}" x="80" y="${y}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`,
    )
    .join("");
  return `<svg viewBox="0 0 160 220" aria-hidden="true" focusable="false">${uses}</svg>`;
}

/** Builds a full `.card` element (unattached) for the given card data.
 * Focusable and activatable from the keyboard: Enter/Space triggers the
 * same "click" behavior the board's delegated listener already handles. */
function buildCardElement(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.code = card.code;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute(
    "aria-label",
    `${card.number} ${card.shading} ${card.color} ${card.shape}${card.number > 1 ? "s" : ""}`,
  );
  el.setAttribute("aria-pressed", "false");
  el.innerHTML = cardSVGMarkup(card);
  return el;
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("card-palette-toggle");
  const popover = document.getElementById("card-palette-popover");
  const reset = document.getElementById("card-palette-reset");
  if (!toggle || !popover || !reset) return;

  const inputs = [...popover.querySelectorAll("input[data-card-color]")];

  function syncInputs() {
    inputs.forEach((input) => {
      input.value = activeCardPalette[input.dataset.cardColor];
    });
  }

  function setOpen(open, returnFocus = false) {
    popover.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (!open && returnFocus) toggle.focus();
  }

  syncInputs();
  toggle.addEventListener("click", () => setOpen(popover.hidden));

  inputs.forEach((input) => {
    input.addEventListener("input", () => {
      saveCardPalette({
        ...activeCardPalette,
        [input.dataset.cardColor]: input.value,
      });
    });
  });

  reset.addEventListener("click", () => {
    activeCardPalette = { ...DEFAULT_CARD_PALETTE };
    applyCardPalette(activeCardPalette);
    syncInputs();
    try {
      localStorage.removeItem(CARD_PALETTE_KEY);
    } catch (_error) {
      // Defaults are still restored for the current page.
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!popover.hidden && !event.target.closest(".palette-control"))
      setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
});
