// PDF page → raster for display, via pdf.js (loaded on first use).

/** Longest side of the rendered bitmap, in pixels. */
const MAX_RENDER_PX = 4096;

export interface RenderedPage {
  /** Object URL of a PNG */
  url: string;
  /** Page size in PDF points (1/72 in) — the underlay's local units */
  width: number;
  height: number;
  pageCount: number;
}

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

export async function renderPdfPage(bytes: ArrayBuffer, pageNumber: number): Promise<RenderedPage> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of (detaches) the buffer it is given.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  try {
    const n = Math.min(Math.max(1, pageNumber), doc.numPages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_RENDER_PX / Math.max(base.width, base.height), 6);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    // Transparent paper: the plan grid stays visible through blank areas.
    await page.render({ canvas, canvasContext: ctx, viewport, background: 'rgba(0,0,0,0)' }).promise;
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not rasterize the PDF page');
    return { url: URL.createObjectURL(blob), width: base.width, height: base.height, pageCount: doc.numPages };
  } finally {
    void doc.destroy();
  }
}
