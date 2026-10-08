import { describe, expect, test } from "bun:test";
import { hostOfHref, linkLooksDeceptive } from "../ui/link-text";
import { budget } from "./timing";

describe("linkLooksDeceptive", () => {
  test("the same host is not deceptive", () => {
    expect(linkLooksDeceptive("https://bank.com/login", "https://bank.com/other")).toBe(false);
    expect(linkLooksDeceptive("see https://bank.com now", "http://bank.com/")).toBe(false);
  });

  test("a different host is deceptive", () => {
    expect(linkLooksDeceptive("https://bank.com", "https://evil.com/x")).toBe(true);
    expect(linkLooksDeceptive("log in at https://bank.com today", "https://evil.com/")).toBe(true);
  });

  test("a subdomain is another host", () => {
    expect(linkLooksDeceptive("https://login.bank.com", "https://bank.com/")).toBe(true);
    expect(linkLooksDeceptive("https://bank.com", "https://login.bank.com/")).toBe(true);
    expect(linkLooksDeceptive("https://bank.com.evil.com", "https://bank.com/")).toBe(true);
  });

  test("a leading www. does not count as a difference, either way", () => {
    expect(linkLooksDeceptive("https://www.bank.com", "https://bank.com/")).toBe(false);
    expect(linkLooksDeceptive("https://bank.com", "https://www.bank.com/x")).toBe(false);
  });

  test("text without a URL is never deceptive", () => {
    expect(linkLooksDeceptive("click here", "https://evil.com/")).toBe(false);
    expect(linkLooksDeceptive("bank.com", "https://evil.com/")).toBe(false); // no scheme: not a URL token
    expect(linkLooksDeceptive("", "https://evil.com/")).toBe(false);
    expect(linkLooksDeceptive("/etc/hosts and ~/notes.md", "https://evil.com/")).toBe(false);
  });

  test("the host comparison ignores case", () => {
    expect(linkLooksDeceptive("HTTPS://BANK.COM/X", "https://bank.com/")).toBe(false);
    expect(linkLooksDeceptive("https://Bank.Com", "https://BANK.com/y")).toBe(false);
  });

  test("a different port is a different host; a default port is not", () => {
    expect(linkLooksDeceptive("https://bank.com:8443/x", "https://bank.com/")).toBe(true);
    expect(linkLooksDeceptive("https://bank.com", "https://bank.com:8443/")).toBe(true);
    expect(linkLooksDeceptive("https://bank.com:443/x", "https://bank.com/")).toBe(false);
    expect(linkLooksDeceptive("http://bank.com:80", "http://bank.com/")).toBe(false);
  });

  test("a URL in the text that cannot be parsed is ignored", () => {
    expect(linkLooksDeceptive("https://[", "https://evil.com/")).toBe(false);
    expect(linkLooksDeceptive("https://%zz", "https://evil.com/")).toBe(false);
    expect(linkLooksDeceptive("https://[ and https://bank.com", "https://evil.com/")).toBe(true);
  });

  test("one matching URL does not excuse another that differs", () => {
    expect(linkLooksDeceptive("https://bank.com and https://evil.com", "https://bank.com/")).toBe(true);
  });

  test("a target that cannot be read is treated as deceptive when the text names a URL", () => {
    expect(linkLooksDeceptive("https://bank.com", "not a url")).toBe(true);
    expect(linkLooksDeceptive("plain words", "not a url")).toBe(false);
  });

  test("a homograph in the text differs from the real host", () => {
    expect(linkLooksDeceptive(`https://${String.fromCharCode(0x430)}pple.com`, "https://apple.com/")).toBe(true);
  });

  test("long text is scanned in bounded time", () => {
    for (const text of ["https://".repeat(20000), "https://a.b/" + "x".repeat(100000), ("https://x.y " + "(").repeat(8000), "h".repeat(100000)]) {
      const t = performance.now();
      linkLooksDeceptive(text, "https://evil.com/");
      expect(performance.now() - t).toBeLessThan(budget(500));
    }
  });
});

describe("hostOfHref", () => {
  test("gives the host, with the port when it is not the default, in punycode for a lookalike", () => {
    expect(hostOfHref("https://evil.com/x?y")).toBe("evil.com");
    expect(hostOfHref("http://localhost:3000/")).toBe("localhost:3000");
    expect(hostOfHref("https://xn--pple-43d.com/")).toBe("xn--pple-43d.com");
    expect(hostOfHref("nope")).toBe("nope");
  });
});
