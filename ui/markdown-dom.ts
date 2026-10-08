import type { IconName } from "./icons";
import { hostOfHref, linkLooksDeceptive } from "./link-text";
import { blockPlainText, inlinePlainText, parseMarkdown, safeHref, type Block, type Inline } from "./markdown";
import { renderFenceBody, renderText, thumbsFor } from "./rich-text";

export interface MarkdownDeps {
  fileUrl: (path: string) => string;
  icon: (name: IconName) => SVGSVGElement;
  copy: (text: string) => Promise<void>;
}

const COPIED_MS = 1500;

/**
 * The DOM for a markdown text. Every node comes from createElement / createTextNode / textContent:
 * nothing from the text is ever parsed as HTML, and a link only gets a target when safeHref accepts it.
 * Links carry no href; the click handler in app.ts opens them through /api/open.
 */
export function renderMarkdown(src: string, deps: MarkdownDeps): DocumentFragment {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  };

  function inlines(nodes: Inline[], into: Node, inLink: boolean) {
    for (const n of nodes) {
      switch (n.t) {
        case "text":
          into.appendChild(renderText(n.v, deps.fileUrl, { links: !inLink }));
          break;
        case "code": {
          const code = el("code");
          code.appendChild(renderText(n.v, deps.fileUrl, { links: !inLink, thumbs: false, code: true }));
          into.appendChild(code);
          if (!inLink) for (const img of thumbsFor(n.v, deps.fileUrl, true)) into.appendChild(img);
          break;
        }
        case "strong":
        case "em":
        case "del": {
          const e = el(n.t);
          inlines(n.c, e, inLink);
          into.appendChild(e);
          break;
        }
        case "br":
          into.appendChild(el("br"));
          break;
        case "link": {
          const href = safeHref(n.href);
          if (href === null || inLink) {
            inlines(n.c, into, inLink);
            break;
          }
          const a = el("a", "link");
          a.dataset.kind = "url";
          a.dataset.target = href;
          a.title = href;
          if (linkLooksDeceptive(inlinePlainText(n.c), href)) {
            // The visible text names another site than the target: it stays plain text, and the real host follows
            // as the only clickable part, so what a click does is written next to it.
            inlines(n.c, into, true);
            a.textContent = `(${hostOfHref(href)})`;
            into.appendChild(document.createTextNode(" "));
            into.appendChild(a);
            break;
          }
          inlines(n.c, a, true);
          into.appendChild(a);
          break;
        }
      }
    }
  }

  function codeBlock(b: Extract<Block, { t: "code" }>): HTMLElement {
    const wrap = el("div", "codeblock");
    const head = el("div", "codehead");
    const label = el("span", "codelang");
    label.textContent = b.lang || "text";
    const btn = el("button", "icon-btn copy");
    btn.type = "button";
    btn.title = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.appendChild(deps.icon("copy"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    btn.onclick = () => {
      deps.copy(b.v).then(
        () => {
          clearTimeout(timer);
          btn.classList.add("copied");
          btn.title = "Copied";
          btn.replaceChildren(deps.icon("check"));
          timer = setTimeout(() => {
            btn.classList.remove("copied");
            btn.title = "Copy";
            btn.replaceChildren(deps.icon("copy"));
          }, COPIED_MS);
        },
        () => {
          /* the clipboard refused: leave the button as it is */
        },
      );
    };
    head.append(label, btn);
    const pre = el("pre");
    const code = el("code");
    code.appendChild(renderFenceBody(b.v, deps.fileUrl));
    pre.appendChild(code);
    wrap.append(head, pre);
    return wrap;
  }

  function cell(tag: "th" | "td", content: Inline[], align: "left" | "center" | "right" | null): HTMLElement {
    const c = el(tag);
    if (align) c.style.textAlign = align;
    inlines(content, c, false);
    return c;
  }

  function block(b: Block): HTMLElement {
    switch (b.t) {
      case "p": {
        const p = el("p");
        inlines(b.c, p, false);
        return p;
      }
      case "h": {
        const h = el(`h${b.level}` as "h1");
        inlines(b.c, h, false);
        return h;
      }
      case "code":
        return codeBlock(b);
      case "quote": {
        const q = el("blockquote");
        for (const child of b.c) q.appendChild(block(child));
        return q;
      }
      case "ul":
      case "ol": {
        const list = el(b.t);
        if (b.t === "ol" && b.start !== undefined) (list as HTMLOListElement).start = b.start;
        for (const item of b.items) {
          const li = el("li");
          for (const child of item) li.appendChild(block(child));
          list.appendChild(li);
        }
        return list;
      }
      case "hr":
        return el("hr");
      case "table": {
        const wrap = el("div", "table-wrap");
        const table = el("table");
        const thead = el("thead");
        const hr = el("tr");
        b.head.forEach((c, i) => hr.appendChild(cell("th", c, b.align[i] ?? null)));
        thead.appendChild(hr);
        const tbody = el("tbody");
        for (const row of b.rows) {
          const tr = el("tr");
          row.forEach((c, i) => tr.appendChild(cell("td", c, b.align[i] ?? null)));
          tbody.appendChild(tr);
        }
        table.append(thead, tbody);
        wrap.appendChild(table);
        return wrap;
      }
    }
  }

  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(src)) {
    // One block that cannot be built (a stack overflow on a hostile tree, say) must not take the conversation with it:
    // it is shown as plain text instead, and nothing it half-built is kept.
    try {
      frag.appendChild(block(b));
    } catch {
      const fallback = el("div", "md-fallback");
      fallback.textContent = blockPlainText(b);
      frag.appendChild(fallback);
    }
  }
  return frag;
}
