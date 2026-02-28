type HighlightItem = {
  quote: string;
  note?: string;
  pageNumber?: number;
};

export type ReadingSheetInput = {
  title: string;
  authors?: string[];
  paperUrl?: string;
  pdfUrl?: string;
  summary?: string;
  novelty?: string[];
  notes?: string;
  highlights?: HighlightItem[];
  generatedAt?: string;
};

type DrawLine = {
  text: string;
  size: number;
  bold?: boolean;
  indent?: number;
  spacing?: number;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const TOP = 752;
const BOTTOM = 52;
const LEFT = 48;
const RIGHT = 48;

function cleanText(value: string) {
  return String(value || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfLiteral(value: string) {
  const safe = cleanText(value).replace(/[^\x20-\x7E]/g, "?");
  return safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toMaxChars(size: number, indent = 0) {
  const width = PAGE_WIDTH - LEFT - RIGHT - indent;
  const charWidth = size * 0.53;
  return Math.max(18, Math.floor(width / charWidth));
}

function wrapText(value: string, maxChars: number) {
  const text = cleanText(value);
  if (!text) return [];
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    if (word.length <= maxChars) {
      line = word;
      continue;
    }
    let rest = word;
    while (rest.length > maxChars) {
      out.push(rest.slice(0, maxChars - 1) + "-");
      rest = rest.slice(maxChars - 1);
    }
    line = rest;
  }

  if (line) out.push(line);
  return out;
}

function pushWrapped(
  lines: DrawLine[],
  value: string,
  opt: { size?: number; bold?: boolean; indent?: number; spacing?: number } = {}
) {
  const size = opt.size ?? 11;
  const indent = opt.indent ?? 0;
  const wrapped = wrapText(value, toMaxChars(size, indent));
  for (const text of wrapped) {
    lines.push({
      text,
      size,
      bold: opt.bold,
      indent,
      spacing: opt.spacing,
    });
  }
}

function section(lines: DrawLine[], label: string) {
  lines.push({ text: "", size: 8, spacing: 0.8 });
  lines.push({ text: label.toUpperCase(), size: 10, bold: true, spacing: 1.3 });
}

function buildLines(input: ReadingSheetInput) {
  const lines: DrawLine[] = [];
  const title = cleanText(input.title || "Reading Sheet");
  const authors = Array.isArray(input.authors) ? input.authors.map(cleanText).filter(Boolean) : [];
  const summary = cleanText(input.summary || "");
  const notes = cleanText(input.notes || "");
  const highlights = Array.isArray(input.highlights) ? input.highlights : [];
  const novelty = Array.isArray(input.novelty) ? input.novelty.map(cleanText).filter(Boolean) : [];
  const generatedAt = cleanText(input.generatedAt || new Date().toLocaleString());

  pushWrapped(lines, "Reading Sheet", { size: 20, bold: true, spacing: 1.2 });
  pushWrapped(lines, title, { size: 13, bold: true, spacing: 1.25 });
  lines.push({ text: "", size: 8, spacing: 0.8 });

  pushWrapped(lines, `Generated: ${generatedAt}`, { size: 10 });
  if (authors.length) pushWrapped(lines, `Authors: ${authors.join(", ")}`, { size: 10 });
  if (input.paperUrl) pushWrapped(lines, `Paper URL: ${input.paperUrl}`, { size: 10 });
  if (input.pdfUrl) pushWrapped(lines, `PDF URL: ${input.pdfUrl}`, { size: 10 });

  if (summary) {
    section(lines, "Summary");
    pushWrapped(lines, summary, { size: 11, spacing: 1.35 });
  }

  if (novelty.length) {
    section(lines, "Novelty");
    novelty.forEach((item) => pushWrapped(lines, `- ${item}`, { size: 11, spacing: 1.3 }));
  }

  section(lines, "Notes");
  if (notes) {
    pushWrapped(lines, notes, { size: 11, spacing: 1.35 });
  } else {
    pushWrapped(lines, "No notes saved for this paper.", { size: 11 });
  }

  section(lines, "Highlights");
  if (!highlights.length) {
    pushWrapped(lines, "No highlights saved for this paper.", { size: 11 });
  } else {
    highlights.forEach((h, idx) => {
      const pageLabel = Number.isFinite(Number(h.pageNumber)) && Number(h.pageNumber) > 0 ? ` (Page ${Number(h.pageNumber)})` : "";
      pushWrapped(lines, `${idx + 1}. Highlight${pageLabel}`, { size: 11, bold: true, spacing: 1.3 });
      pushWrapped(lines, h.quote || "", { size: 11, indent: 12, spacing: 1.32 });
      if (h.note) pushWrapped(lines, `Note: ${h.note}`, { size: 10, indent: 12, spacing: 1.25 });
      lines.push({ text: "", size: 8, spacing: 0.7 });
    });
  }

  return lines;
}

function paginate(lines: DrawLine[]) {
  const pages: DrawLine[][] = [];
  let page: DrawLine[] = [];
  let y = TOP;

  for (const line of lines) {
    const size = Math.max(8, Number(line.size || 11));
    const spacing = Number(line.spacing || 1.3);
    const step = size * spacing;
    if (y - step < BOTTOM) {
      pages.push(page);
      page = [];
      y = TOP;
    }
    page.push(line);
    y -= step;
  }

  if (page.length || !pages.length) pages.push(page);
  return pages;
}

function buildPageContent(lines: DrawLine[], pageNum: number, totalPages: number) {
  const chunks: string[] = [];
  let y = TOP;

  for (const line of lines) {
    const size = Math.max(8, Number(line.size || 11));
    const spacing = Number(line.spacing || 1.3);
    const x = LEFT + Math.max(0, Number(line.indent || 0));
    const text = escapePdfLiteral(line.text || "");
    chunks.push(`BT /${line.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${text}) Tj ET`);
    y -= size * spacing;
  }

  const footer = `Page ${pageNum} / ${totalPages}`;
  chunks.push(`BT /F1 9 Tf 1 0 0 1 ${LEFT} 30 Tm (${escapePdfLiteral(footer)}) Tj ET`);
  return chunks.join("\n");
}

function byteLen(value: string) {
  return new TextEncoder().encode(value).length;
}

function sanitizeFileName(value: string) {
  const t = cleanText(value || "reading-sheet").toLowerCase();
  return t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "reading-sheet";
}

function buildPdf(input: ReadingSheetInput) {
  const lines = buildLines(input);
  const pages = paginate(lines);
  const totalPages = pages.length;

  let nextObject = 1;
  const catalogObj = nextObject++;
  const pagesObj = nextObject++;
  const fontObj = nextObject++;
  const fontBoldObj = nextObject++;

  const pageEntries: { pageObj: number; contentObj: number; content: string }[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const contentObj = nextObject++;
    const pageObj = nextObject++;
    pageEntries.push({
      pageObj,
      contentObj,
      content: buildPageContent(pages[i], i + 1, totalPages),
    });
  }

  const objects: Record<number, string> = {
    [catalogObj]: `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`,
    [pagesObj]: `<< /Type /Pages /Count ${pageEntries.length} /Kids [${pageEntries.map((p) => `${p.pageObj} 0 R`).join(" ")}] >>`,
    [fontObj]: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    [fontBoldObj]: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  };

  for (const entry of pageEntries) {
    objects[entry.pageObj] =
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R /F2 ${fontBoldObj} 0 R >> >> ` +
      `/Contents ${entry.contentObj} 0 R >>`;
    objects[entry.contentObj] =
      `<< /Length ${byteLen(entry.content)} >>\nstream\n${entry.content}\nendstream`;
  }

  const totalObjects = nextObject - 1;
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  let pdf = "%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n";

  for (let i = 1; i <= totalObjects; i += 1) {
    offsets[i] = byteLen(pdf);
    const body = objects[i] || "";
    pdf += `${i} 0 obj\n${body}\nendobj\n`;
  }

  const xrefPos = byteLen(pdf);
  pdf += `xref\n0 ${totalObjects + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= totalObjects; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${totalObjects + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

export function downloadReadingSheetPdf(input: ReadingSheetInput) {
  const bytes = buildPdf(input);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const fileName = `${sanitizeFileName(input.title)}-reading-sheet.pdf`;

  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return fileName;
}
