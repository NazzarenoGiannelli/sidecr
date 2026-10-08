import { isImagePath } from "../src/imagepath";
import { tokenize, tokenizeCode, tokenizeFenceBody, type Token } from "../src/tokenize";
import { createIcon } from "./icons";
import { linkSpec } from "./path-link";

export interface TextOptions {
  /** Turn URLs and paths into clickable a.link elements. On by default; off inside link text, where a nested link makes no sense. */
  links?: boolean;
  /** Put a thumbnail after each image path. On by default. */
  thumbs?: boolean;
  /**
   * The text is the content of an inline code span: when all of it is one absolute path, spaces included, it is one link
   * (see tokenizeCode). The markdown parser has already taken the backticks off.
   */
  code?: boolean;
}

function thumb(fileUrl: (p: string) => string, path: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "thumb";
  img.loading = "lazy"; // history can hold many: only the ones near the view load
  img.decoding = "async";
  img.src = fileUrl(path);
  img.alt = "";
  img.onerror = () => img.remove();
  return img;
}

/** The nodes for a list of tokens: text, and a.link for every URL and path (the click handler in app.ts reads data-kind and data-target). */
function renderTokens(tokens: Token[], fileUrl: (p: string) => string, thumbs: boolean): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const t of tokens) {
    if (t.type === "text") {
      frag.append(document.createTextNode(t.value));
    } else {
      const spec = linkSpec(t);
      const a = document.createElement("a");
      a.className = spec.folder ? "link dir" : "link";
      a.textContent = t.value;
      a.dataset.kind = spec.kind;
      a.dataset.target = t.value;
      if (spec.title) a.title = spec.title;
      if (spec.folder) a.prepend(createIcon("folder"));
      if (spec.focusable) {
        a.tabIndex = 0;
        a.setAttribute("role", "link");
      }
      frag.append(a);
      if (thumbs && t.type === "path" && isImagePath(t.value)) frag.append(thumb(fileUrl, t.value));
    }
  }
  return frag;
}

/** Text with its URLs and paths made clickable (the click handler in app.ts opens them through /api/open). Built node by node. */
export function renderText(text: string, fileUrl: (p: string) => string, opts: TextOptions = {}): DocumentFragment {
  const links = opts.links !== false;
  const thumbs = opts.thumbs !== false;
  if (!links) {
    const frag = document.createDocumentFragment();
    frag.append(document.createTextNode(text));
    return frag;
  }
  return renderTokens(opts.code ? tokenizeCode(text) : tokenize(text), fileUrl, thumbs);
}

/** The body of a fenced code block: a line that is one absolute path (spaces allowed) is a link, the rest stays text. */
export function renderFenceBody(body: string, fileUrl: (p: string) => string): DocumentFragment {
  return renderTokens(tokenizeFenceBody(body), fileUrl, false);
}

/** Thumbnails for the image paths in a text, for callers that place them apart from the text itself (`code`: as in TextOptions). */
export function thumbsFor(text: string, fileUrl: (p: string) => string, code = false): HTMLImageElement[] {
  return (code ? tokenizeCode(text) : tokenize(text))
    .filter((t) => t.type === "path" && isImagePath(t.value))
    .map((t) => thumb(fileUrl, t.value));
}
