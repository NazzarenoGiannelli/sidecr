import { tokenize } from "../src/tokenize";

/** The host of a URL for comparing: lower-cased by the URL parser, default port dropped, a leading `www.` ignored. null when it is not a URL. */
function comparableHost(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** The host the browser would connect to (punycode for a lookalike name), as shown next to a deceptive link. */
export function hostOfHref(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

/**
 * True when the visible text of a link itself names a URL on another host than the link's target:
 * `[https://bank.com](https://evil.com/x)`. Text with no URL, a URL on the same host (`www.` aside), or a URL the parser
 * cannot read are not deceptive. A target that cannot be read counts as deceptive, because nothing can vouch for it.
 */
export function linkLooksDeceptive(text: string, href: string): boolean {
  const real = comparableHost(href);
  for (const t of tokenize(text)) {
    if (t.type !== "url") continue;
    const shown = comparableHost(t.value);
    if (shown === null) continue;
    if (real === null || shown !== real) return true;
  }
  return false;
}
