// The pages of a PDF as figures (SPEC_dopa v3 §6.7 "PDF page"; ED D-75, D-108, ST-19).
// A figure block of kind "pdfPage" shows its whole page. pdf.js renders the page into an
// offscreen canvas at the largest size that fits twice the main monitor's area (1022×528 pixels);
// the monitor then fits it and runs the PlayStation pass on it. The pdf.js document is the one
// pdf.js's wrapper kept on the book (`book.pdfDocument`).

/** The box a page is rendered into: the main monitor's area times 2. */
export const PAGE_BOX = { width: 1022, height: 528 };

/**
 * A canvas with the page drawn on white, or null when the book has no open PDF document.
 * @param {object} book a book model made by parsePdf
 * @param {number} pageNumber from 1
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function renderPdfPage(book, pageNumber, box = PAGE_BOX) {
  const doc = book?.pdfDocument;
  if (!doc || !(pageNumber >= 1 && pageNumber <= doc.numPages)) return null;
  const page = await doc.getPage(pageNumber);
  const whole = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(box.width / whole.width, box.height / whole.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas;
}

/** Close the PDF document of a book that is no longer open. */
export function closePdf(book) {
  book?.pdfDocument?.destroy();
}
