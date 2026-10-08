import { activityParts, type Activity } from "./activity";
import { createIcon } from "./icons";

/** The row above the composer while Claude works. Everything shown goes in through textContent. */
export function createActivityView(
  els: { root: HTMLElement; spinner: HTMLElement; text: HTMLElement; stop: HTMLButtonElement },
  now: () => number,
) {
  els.spinner.append(createIcon("circle-notch"));
  els.stop.append(createIcon("stop"));
  let activity: Activity | undefined;
  let receivedAt = 0;

  function paint() {
    if (!activity) return;
    const parts = activityParts(activity, receivedAt, now());
    const spans = parts.map((p, i) => {
      const s = document.createElement("span");
      s.className = i === 0 ? "act-verb" : "act-part";
      s.textContent = p;
      return s;
    });
    els.text.replaceChildren(...spans);
    els.text.title = parts.join(" · ");
  }

  return {
    /** A fresh conversation payload: undefined when the pane is not working. */
    update(a: Activity | undefined) {
      activity = a;
      receivedAt = now();
      els.root.hidden = !a;
      if (a) paint();
      else els.text.replaceChildren();
    },
    /** Called once a second to move the elapsed time on. */
    tick() {
      paint();
    },
  };
}
