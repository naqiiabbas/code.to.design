import { px } from './css';

/**
 * Temporarily grows every internally scrolling element so the content hidden
 * below (or beside) its fold is laid out and captured.
 *
 * The alternative would be to read each child's position and rebuild the layout
 * ourselves, which gets the ancestors and following siblings wrong. Letting the
 * browser re-run layout is both simpler and correct: everything downstream moves
 * exactly as it would if the box had always been that tall.
 */

/** Refuse to expand anything absurd - a virtualised list can report kilometres. */
const MAX_EXPANSION = 20000;

const SCROLLABLE = /^(auto|scroll|overlay)$/;

/** Every property this module may set, so restore can undo exactly that much. */
const TOUCHED = [
  'max-height', 'height', 'min-height',
  'max-width', 'width', 'min-width',
  'overflow', 'box-sizing',
];

interface Saved {
  el: HTMLElement;
  style: string | null;
  scrollTop: number;
  scrollLeft: number;
}

export interface Expansion {
  restore: () => void;
  expanded: number;
  skipped: number;
}

function overflows(el: HTMLElement): { y: boolean; x: boolean } {
  const style = getComputedStyle(el);
  return {
    y: SCROLLABLE.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2,
    x: SCROLLABLE.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2,
  };
}

export function expandScrollContainers(scope: Element): Expansion {
  const saved: Saved[] = [];
  let expanded = 0;
  let skipped = 0;

  // Document order, so an outer scroller is grown before the ones inside it and
  // each element is measured against a layout that is already settled.
  const candidates: Element[] = [scope, ...Array.from(scope.querySelectorAll('*'))];

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) continue;
    // The page's own scroller is already handled by sizing the root frame to the
    // full scroll height; touching it here would fight that.
    if (candidate === document.documentElement || candidate === document.body) continue;

    const el = candidate;
    const scrolls = overflows(el);
    if (!scrolls.y && !scrolls.x) continue;

    if (el.scrollHeight > MAX_EXPANSION || el.scrollWidth > MAX_EXPANSION) {
      skipped++;
      continue;
    }

    saved.push({
      el,
      style: el.getAttribute('style'),
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
    });

    el.scrollTop = 0;
    el.scrollLeft = 0;

    const floorHeight = el.clientHeight;
    const floorWidth = el.clientWidth;

    if (scrolls.y) {
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('min-height', `${floorHeight}px`, 'important');
    }
    if (scrolls.x) {
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('min-width', `${floorWidth}px`, 'important');
    }
    el.style.setProperty('overflow', 'visible', 'important');

    // Reading scrollHeight here forces the reflow, so the check below sees the
    // new layout. Flex items and grid tracks often ignore `height: auto`, so
    // pin the exact content size when the box is still overflowing.
    const after = overflows(el);
    const style = getComputedStyle(el);
    if (after.y || el.scrollHeight > el.clientHeight + 2) {
      const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('height', `${el.scrollHeight + border}px`, 'important');
    }
    if (after.x || el.scrollWidth > el.clientWidth + 2) {
      const border = px(style.borderLeftWidth) + px(style.borderRightWidth);
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('width', `${el.scrollWidth + border}px`, 'important');
    }

    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) skipped++;
    else expanded++;
  }

  return {
    expanded,
    skipped,
    restore: () => {
      // Innermost first, so each element is restored before its parent resizes.
      for (let i = saved.length - 1; i >= 0; i--) {
        const entry = saved[i];
        if (entry.style) {
          entry.el.setAttribute('style', entry.style);
        } else {
          // Remove exactly what was added rather than clearing the attribute
          // wholesale, in case the page set inline styles of its own meanwhile.
          for (const property of TOUCHED) entry.el.style.removeProperty(property);
          if (entry.el.style.length === 0) {
            // Chrome leaves an empty style="" behind if the attribute is removed
            // while its declaration is still populated, so empty it explicitly
            // before removing it.
            entry.el.style.cssText = '';
            entry.el.removeAttribute('style');
          }
        }
        entry.el.scrollTop = entry.scrollTop;
        entry.el.scrollLeft = entry.scrollLeft;
      }
    },
  };
}
