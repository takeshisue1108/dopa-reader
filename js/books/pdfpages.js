// The pages of a PDF as figures (SPEC_dopa v3 §6.7 "PDF page"; ED D-75, D-108, ST-19).
// A figure block whose figure is of kind "pdfPage" shows its whole page. The pdf.js library
// renders the page into an offscreen canvas at the largest size that fits 1022×528 pixels: the
// cockpit's main monitor is 511×264 on the text layer, and this is twice its width and height.
// The monitor then fits the picture and runs its low-resolution pass (the "PlayStation pass") on
// it.
// The document is the open pdf.js document that parsePdf (./pdf.js) kept on the book as
// `book.pdfDocument`.

/** The box a page is rendered into: the main monitor's area times 2. */
export const PAGE_BOX = { width: 1022, height: 528 };

/**
 * A canvas with the page drawn on white, or null when the book has no PDF document or the page
 * number is not one of its pages.
 * @param {object} book a book model made by parsePdf
 * @param {number} pageNumber from 1
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function renderPdfPage(book, pageNumber, box = PAGE_BOX) {
  const pdfDocument = book?.pdfDocument;
  if (!pdfDocument) {
    return null;
  }
  const isPageOfDocument = pageNumber >= 1 && pageNumber <= pdfDocument.numPages;
  if (!isPageOfDocument) {
    return null;
  }

  const page = await pdfDocument.getPage(pageNumber);

  // the largest scale at which the whole page fits the box
  const unscaled = page.getViewport({ scale: 1 });
  const scaleToWidth = box.width / unscaled.width;
  const scaleToHeight = box.height / unscaled.height;
  const scale = Math.min(scaleToWidth, scaleToHeight);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  const wholeWidthPx = Math.floor(viewport.width);
  canvas.width = Math.max(1, wholeWidthPx);
  const wholeHeightPx = Math.floor(viewport.height);
  canvas.height = Math.max(1, wholeHeightPx);

  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const renderOptions = {
    canvasContext: context,
    viewport,
  };
  const renderTask = page.render(renderOptions);
  await renderTask.promise;

  page.cleanup();
  return canvas;
}

/** Close the PDF document of a book that is no longer open. */
export function closePdf(book) {
  book?.pdfDocument?.destroy();
}
