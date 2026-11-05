// Copy text to the clipboard from Steam's Game Mode UI (CEF). No Steam call for text is typed in @decky/ui (only
// SteamClient.System.CopyFilesToClipboard, for files), so a fallback chain of web methods, each with a time limit:
//  1. document.execCommand("copy") on a hidden textarea in the document the user tapped in (synchronous, inside the
//     press, so it still has the user's activation),
//  2. navigator.clipboard.writeText of that document's window (needs a focused document; can hang, hence the limit),
//  3. both again in the plugin's own document when it is another one.
// The caller shows the text in a field to copy by hand when all fail. Framework-free (tests/js/copyopts.test.mjs).

export type CopyMethod = { name: string; run: (text: string) => boolean | Promise<boolean> };

/** The name of the first method that copied, or null. A method that throws, says false or takes too long fails. */
export const copyWith = async (text: string, methods: CopyMethod[], timeoutMs = 1500): Promise<string | null> => {
  for (const m of methods) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ok = await Promise.race([
        Promise.resolve().then(() => m.run(text)),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
      ]);
      if (ok === true) return m.name;
    } catch {
      /* next method */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return null;
};

type Doc = {
  createElement(tag: string): any;
  body: any;
  activeElement?: any;
  execCommand?(cmd: string): boolean;
  defaultView?: { navigator?: { clipboard?: { writeText?(t: string): Promise<void> } } } | null;
};

/** execCommand("copy") on a hidden textarea in `doc`; gives the focus back to what had it. */
export const execCopy = (doc: Doc | null | undefined, text: string): boolean => {
  if (!doc?.createElement || !doc.body || typeof doc.execCommand !== "function") return false;
  const before = doc.activeElement;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute?.("readonly", "");
  Object.assign(ta.style ?? {}, { position: "fixed", top: "0", left: "-9999px", opacity: "0", pointerEvents: "none" });
  doc.body.appendChild(ta);
  try {
    ta.focus?.();
    ta.select?.();
    ta.setSelectionRange?.(0, text.length);
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    try { doc.body.removeChild(ta); } catch { /* gone */ }
    try { before?.focus?.(); } catch { /* gone */ }
  }
};

/** navigator.clipboard.writeText of `doc`'s window (true once it resolved). */
export const navigatorCopy = async (doc: Doc | null | undefined, text: string): Promise<boolean> => {
  const clip = doc?.defaultView?.navigator?.clipboard;
  if (!clip || typeof clip.writeText !== "function") return false;
  await clip.writeText(text);
  return true;
};

/** The chain for the document the user tapped in (`doc`, else the global one), then the global one. */
export const clipboardMethods = (doc?: Doc | null): CopyMethod[] => {
  const global = typeof document !== "undefined" ? (document as unknown as Doc) : null;
  const docs = [...new Set([doc ?? global, global].filter((d): d is Doc => !!d))];
  return docs.flatMap((d, n) => [
    { name: `execCommand${n ? " (plugin)" : ""}`, run: (t: string) => execCopy(d, t) },
    { name: `navigator.clipboard${n ? " (plugin)" : ""}`, run: (t: string) => navigatorCopy(d, t) },
  ]);
};

/** Copy `text`; `from` is the element that was pressed (its document is the one with the user's focus). */
export const copyText = (text: string, from?: { ownerDocument?: unknown } | null): Promise<string | null> =>
  copyWith(text, clipboardMethods((from?.ownerDocument as Doc | undefined) ?? null));
