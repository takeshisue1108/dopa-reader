// Choosing a parser and a text encoding (SPEC_dopa v3 §5.2 "Choosing a parser"; ED ST-27, D-72).
// A file named .pdf, or one that starts with %PDF-, is a PDF. Any other file is decoded as UTF-8
// (fatal), then as Shift_JIS, then as EUC-JP; a decoding counts only if fewer than 0.1% of its
// characters are U+FFFD. A .md file is Markdown. A .txt file with 《》 ruby, ［＃ notes or the
// dash line of the 青空文庫 symbol note is 青空文庫; else a .txt that reads as Markdown (a #
// heading, a table's rule line, a fenced block, a link) is Markdown (D-115); any other .txt is
// plain text. Any other extension is refused.

import { BookError, MESSAGES } from "./model.js";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** The extension of a file name, lower case, without the dot ("" when there is none). */
export function extensionOf(name) {
  const path = String(name ?? "");
  const pathParts = path.split(/[\\/]/);
  const file = pathParts.pop();

  const dot = file.lastIndexOf(".");
  if (dot > 0) {
    const extension = file.slice(dot + 1);
    return extension.toLowerCase();
  }
  return "";
}

/** Whether a file is a PDF, by its name or its first bytes. */
export function isPdf(name, bytes) {
  if (extensionOf(name) === "pdf") {
    return true;
  }
  return PDF_MAGIC.every((byte, i) => bytes[i] === byte);
}

/**
 * The text of a file's bytes and the encoding that read it (§5.2).
 * Throws 「文字コードを判別できませんでした」 when no encoding counts.
 * @param {Uint8Array} bytes
 * @returns {{text: string, encoding: "utf-8" | "shift_jis" | "euc-jp"}}
 */
export function decode(bytes) {
  try {
    const strictDecoder = new TextDecoder("utf-8", { fatal: true });
    const text = strictDecoder.decode(bytes);
    return {
      text,
      encoding: "utf-8",
    };
  } catch {
    // not UTF-8: try the Japanese encodings
  }

  for (const encoding of ["shift_jis", "euc-jp"]) {
    const decoder = new TextDecoder(encoding);
    const text = decoder.decode(bytes);

    let total = 0;
    let broken = 0;
    for (const ch of text) {
      total++;
      if (ch === "\uFFFD") {
        broken++;
      }
    }

    if (total > 0) {
      const brokenShare = broken / total;
      if (brokenShare < 0.001) {
        return {
          text,
          encoding,
        };
      }
    }
  }

  throw new BookError(MESSAGES.encoding, "encoding");
}

/** Whether a .txt text is a 青空文庫 file: 《》 ruby, ［＃ notes, or the symbol note's dash line. */
export function looksAozora(text) {
  const hasRuby = /《[^《》\n]+》/.test(text);
  if (hasRuby) {
    return true;
  }

  const hasNote = text.includes("［＃");
  if (hasNote) {
    return true;
  }

  const hasDashLine = /^-{20,}\s*$/m.test(text);
  return hasDashLine;
}

/** Whether a .txt text reads as Markdown: an ATX heading (`# …`), a pipe table's rule line, a
 * fenced block, or a Markdown image or link (ED D-115). */
export function looksMarkdown(text) {
  const hasHeading = /^#{1,6}[ \t]+\S/m.test(text);
  if (hasHeading) {
    return true;
  }

  const hasTableRule = /^\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(text);
  if (hasTableRule) {
    return true;
  }

  const hasFence = /^(```|~~~)/m.test(text);
  if (hasFence) {
    return true;
  }

  const hasImageOrLink = /!?\[[^\]\n]+\]\([^)\s]+\)/.test(text);
  return hasImageOrLink;
}

/**
 * The parser for a decoded file: "aozora", "text" or "markdown". A .txt is tried as 青空文庫 first,
 * then as Markdown; only when it is neither is it plain text (ED D-115).
 * Throws 「この形式は読めません（.txt・.md・.pdf）」 for any other extension.
 */
export function formatOf(name, text) {
  const extension = extensionOf(name);

  if (extension === "md") {
    return "markdown";
  }

  if (extension === "txt") {
    if (looksAozora(text)) {
      return "aozora";
    }
    if (looksMarkdown(text)) {
      return "markdown";
    }
    return "text";
  }

  throw new BookError(MESSAGES.format, "format");
}
