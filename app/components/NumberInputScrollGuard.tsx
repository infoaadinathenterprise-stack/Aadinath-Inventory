'use client';

import { useEffect } from 'react';

/**
 * Globally disables the mouse-wheel-changes-value behavior on every
 * <input type="number"> in the app. Browsers natively let you scroll
 * over a focused number input to step its value, which causes
 * silent data-entry mistakes — especially in the inventory and
 * purchase forms where a single scroll can change a qty or price
 * without the user noticing.
 *
 * The handler runs at the document level so it covers every page,
 * every modal, every dynamically-mounted input — no per-input prop
 * wiring required. We blur the input on wheel (rather than calling
 * preventDefault) so the page itself still scrolls normally.
 */
export default function NumberInputScrollGuard() {
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement &&
        target.type === 'number' &&
        document.activeElement === target
      ) {
        target.blur();
      }
    }
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
}
