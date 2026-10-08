import { createIcon } from "./icons";
import { shouldShowScrollButton } from "./scroll";

/** The round "scroll to bottom" button over the conversation. The decision is in ui/scroll.ts. */
export function attachScrollButton(conv: HTMLElement, btn: HTMLButtonElement, afterClick: () => void) {
  btn.append(createIcon("arrow-down"));
  const update = () => {
    btn.hidden = !shouldShowScrollButton(conv.scrollTop, conv.clientHeight, conv.scrollHeight);
  };
  btn.addEventListener("click", () => {
    conv.scrollTo({ top: conv.scrollHeight, behavior: "smooth" });
    afterClick(); // the button hides itself on the way down; keep the keyboard in the composer
  });
  conv.addEventListener("scroll", update, { passive: true });
  conv.addEventListener("toggle", update, true); // opening a tool list changes the height without a scroll event
  conv.addEventListener("load", update, true); // an image that finishes loading grows the conversation; load does not bubble
  window.addEventListener("resize", update);
  update();
  return { update };
}
