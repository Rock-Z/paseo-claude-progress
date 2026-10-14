import { Platform } from "react-native";

// Paseo caps plugin pills at 160 px. 400 px fits nine in ten of Claude's step descriptions
// (about 60 characters at the pill's 12 px label) and still leaves room for the other pills.
const PILL_MAX_WIDTH = "400px";
// Paseo's gap between a pill's icon and its label, closed along with the slot.
const PILL_GAP = "8px";
const SLOT_TRANSITION = "width 180ms ease, margin-right 180ms ease, opacity 180ms ease";

// The DOM this module uses; the plugin's TypeScript config has no DOM library.
interface DomElement {
  style: { maxWidth: string; width: string; marginRight: string; opacity: string; transition: string };
  parentElement: DomElement | null;
  closest(selector: string): DomElement | null;
  contains(other: unknown): boolean;
  dispatchEvent(event: unknown): boolean;
}
interface PointerLikeEvent {
  type: string;
  target: DomElement;
  relatedTarget: unknown;
  clientX: number;
  clientY: number;
  stopImmediatePropagation(): void;
  constructor: new (type: string, init: object) => unknown;
}
declare const document: {
  addEventListener(type: string, listener: (event: PointerLikeEvent) => void, capture: boolean): void;
};

const pills = new Set<DomElement>();
let listening = false;

// On web, fit the pill that holds this icon. Paseo gives plugin pills a 16 px icon slot where its
// own pills size the mark to the glyph: `markWidth` does the same, and null collapses the slot and
// its gap so the label slides over. It also widens the pill for the step and keeps hovering it
// silent (clicking still opens the list). Native keeps Paseo's pill.
export function fitPill(node: unknown, markWidth: string | null) {
  if (Platform.OS !== "web" || !node) return;
  const icon = node as DomElement;
  const pill = icon.closest('[role="button"]');
  const slot = icon.parentElement;
  if (!pill || !slot) return;
  slot.style.transition = SLOT_TRANSITION;
  slot.style.width = markWidth ?? "0px";
  slot.style.marginRight = markWidth ? "" : `-${PILL_GAP}`;
  slot.style.opacity = markWidth ? "1" : "0";
  pill.style.maxWidth = PILL_MAX_WIDTH;
  pills.add(pill);
  if (listening) return;
  listening = true;
  // Paseo's title tooltip opens on the pill's hover-in. React derives that from the pointer leaving
  // whatever was under it, so that event is resent as if heading to the pill bar: the element left
  // still gets its leave, the pill no enter. Hover events aimed into the pill are stopped outright.
  for (const type of ["pointerout", "mouseout"]) {
    document.addEventListener(type, (event) => {
      const into = pillHolding(event.relatedTarget);
      if (!into || into.contains(event.target)) return;
      event.stopImmediatePropagation();
      const { clientX, clientY } = event;
      const init = { bubbles: true, clientX, clientY, pointerType: "mouse", relatedTarget: into.parentElement };
      event.target.dispatchEvent(new event.constructor(event.type, init));
    }, true);
  }
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) {
    document.addEventListener(type, (event) => {
      if (pillHolding(event.target)) event.stopImmediatePropagation();
    }, true);
  }
}

function pillHolding(node: unknown) {
  for (const pill of pills) if (pill.contains(node)) return pill;
  return null;
}
