// Books in, book models out (SPEC_dopa v3 §5.1, §5.2; SD-W07).
// parseFile takes a file's name and bytes, chooses the parser and the encoding (detect.js), and
// returns the book model. Refusals are thrown as BookError, whose message is the exact string
// of ST-27 (they are MESSAGES in model.js). A PDF is read in the browser with the pdf.js library,
// which ./pdf.js wraps (parsePdf); parsePdfText is its pure part, for text already taken out of a
// PDF (the tests use it).

import { formatOf, decode, isPdf, extensionOf } from "./detect.js";
import { BookError, MESSAGES } from "./model.js";
import { parseAozora } from "./aozora.js";
import { parseTextFile } from "./text.js";
import { parseMarkdown } from "./markdown.js";
import { parsePdf } from "./pdf.js";

export { BookError, MESSAGES } from "./model.js";
export { parsePdfText, NO_TEXT as PDF_NO_TEXT } from "./pdf.js";

/**
 * Parse text that is already decoded. With no `format` and a name that ends in neither .txt nor
 * .md, the format refusal is thrown.
 * @param {string} text
 * @param {{name?: string, format?: "aozora"|"text"|"markdown", key?: string|null,
 *          imageBase?: string|null, images?: Set<string>|null}} options
 *   `format` defaults to the choice of detect.js by the name's extension and the text.
 *   `key` is the caller's ("aozora:<作品番号>" or "file:<sha256>"). `imageBase` is the folder of a
 *   bundled 青空文庫 book's images; without it an illustration note is dropped (D-108).
 * @returns the book model of §5.1
 */
export function parseText(
  text,
  { name = "", format, key = null, imageBase = null, images = null } = {},
) {
  const chosen = format ?? formatOf(name, text);

  if (chosen === "aozora") {
    const aozoraOptions = {
      name,
      key,
      imageBase,
      images,
    };
    return parseAozora(text, aozoraOptions);
  }

  if (chosen === "text") {
    const textOptions = {
      name,
      key,
    };
    return parseTextFile(text, textOptions);
  }

  if (chosen === "markdown") {
    const markdownOptions = {
      name,
      key,
    };
    return parseMarkdown(text, markdownOptions);
  }

  throw new BookError(MESSAGES.format, "format");
}

/**
 * Parse a file.
 * @param {{name: string, bytes: Uint8Array|ArrayBuffer, key?: string|null,
 *          imageBase?: string|null, images?: Set<string>|null}} file
 * @returns {Promise<object>} the book model of §5.1
 */
export async function parseFile({ name, bytes, key = null, imageBase = null, images = null }) {
  let data = bytes;
  if (!(bytes instanceof Uint8Array)) {
    data = new Uint8Array(bytes);
  }

  if (isPdf(name, data)) {
    const pdfFile = {
      name,
      bytes: data,
      key,
    };
    return parsePdf(pdfFile);
  }

  const extension = extensionOf(name);
  const isTextFile = extension === "txt" || extension === "md";
  if (!isTextFile) {
    throw new BookError(MESSAGES.format, "format");
  }

  const { text } = decode(data);

  const textOptions = {
    name,
    key,
    imageBase,
    images,
  };
  return parseText(text, textOptions);
}
