// Custom mouse cursor: black fill, white border, with very slightly rounded
// points (stroke-linejoin: round). Fixed colors — not themed.
function cursorValue(): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='30' height='20' viewBox='0 0 22 22'>` +
    `<path d='M3 2 L19 11 L11 12.5 L8 18 Z' fill='#0d0d0f' stroke='#ffffff' ` +
    `stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/></svg>`;
  // hotspot at the tip; fall back to the system arrow if the data URI fails.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 4 2, auto`;
}

/** Apply the custom cursor. (Kept this name so main.ts's import is unchanged.) */
export function initThemedCursor() {
  document.documentElement.style.cursor = cursorValue();
}
