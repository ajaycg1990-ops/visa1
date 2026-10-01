/**
 * Turn a question file into plain text - one line per paragraph, spreadsheet
 * row or text line - right in the browser, with no libraries.
 *
 *   .txt .csv .tsv .md   decoded as UTF-8, or as Windows-1252 when that is
 *                        what it really is (Excel's "CSV" on Windows)
 *   .docx                Word: paragraphs, and table rows as tab-separated cells
 *   .xlsx                Excel: every sheet, one row per line, cells tab-separated
 *
 * Word and Excel files are zip archives of XML; the browser's own
 * DecompressionStream unpacks them. The server's parser then works out which
 * part of each line is the question (see interviewer.mjs).
 */

export const ACCEPT = ".txt,.csv,.tsv,.md,.docx,.xlsx,text/plain,text/csv";

/** Formats people will try, and what to do instead. */
const UNSUPPORTED = {
  pdf: "PDF files can't be read here. Open the PDF, select the questions, and copy and paste them into the box - or save it as a Word (.docx) file and load that.",
  doc: "This is the old Word format. In Word choose File › Save As › Word Document (.docx), then load the new file.",
  xls: "This is the old Excel format. In Excel choose File › Save As › Excel Workbook (.xlsx) or CSV, then load the new file.",
  odt: "Save this document as Word (.docx) first, then load it.",
  ods: "Save this spreadsheet as Excel (.xlsx) or CSV first, then load it.",
  pages: "Export this from Pages as Word (.docx) first, then load it.",
  numbers: "Export this from Numbers as Excel (.xlsx) or CSV first, then load it.",
  rtf: "Save this document as Word (.docx) or plain text first, then load it.",
};

export class FileReadError extends Error {}

const extensionOf = (name) => String(name ?? "").toLowerCase().split(".").pop();

/**
 * Read one file. Resolves to { text, lines } or throws a FileReadError whose
 * message is written for the person who chose the file.
 */
export async function readQuestionFile(file) {
  const extension = extensionOf(file.name);
  if (UNSUPPORTED[extension]) throw new FileReadError(UNSUPPORTED[extension]);
  // Word and Excel files are mostly images and styling; only their text is read.
  const limit = extension === "docx" || extension === "xlsx" ? 40 : 5;
  if (file.size > limit * 1024 * 1024) throw new FileReadError(`${file.name} is larger than ${limit} MB. Split it into smaller files.`);

  const buffer = await file.arrayBuffer();
  let text;
  if (extension === "docx") text = await docxText(buffer, file.name);
  else if (extension === "xlsx") text = await xlsxText(buffer, file.name);
  else if (isZip(buffer)) throw new FileReadError(`${file.name} looks like a Word or Excel file with the wrong name. Rename it to end in .docx or .xlsx.`);
  else text = decodeText(buffer);

  text = text.replace(/\r\n?/g, "\n");
  const lines = text.split("\n").filter((line) => line.trim()).length;
  if (!lines) throw new FileReadError(`${file.name} has no text in it.`);
  return { text, lines };
}

/* ------------------------------ plain text ------------------------------ */

/**
 * Bytes to text. Handles a UTF-8 or UTF-16 byte-order mark, and falls back to
 * Windows-1252 when the bytes are not valid UTF-8 - which is what Excel on
 * Windows writes, and why its apostrophes otherwise come out as "�".
 */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/* --------------------------------- zip ---------------------------------- */

const isZip = (buffer) => buffer.byteLength > 4 && new DataView(buffer).getUint32(0, true) === 0x04034b50;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files in a zip archive whose names pass `wanted`, as text. Reads the
 * central directory, which always has the real sizes.
 */
async function unzip(buffer, wanted) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = {};
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = utf8.decode(new Uint8Array(buffer, offset + 46, nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;

    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = new Uint8Array(buffer, start, compressedSize);
    if (method === 0) files[name] = utf8.decode(data);
    else if (method === 8) files[name] = utf8.decode(await inflate(data));
  }
  return files;
}

/* ---------------------------------- xml --------------------------------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()];
    return String.fromCodePoint(code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  });
}

/* --------------------------------- Word --------------------------------- */

/** The text of one piece of Word XML: runs, tabs and line breaks, in order. */
function wordRuns(xml) {
  let text = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<w:noBreakHyphen\/>/g)) {
    if (m[1] !== undefined) text += unescapeXml(m[1]);
    else if (m[0] === "<w:noBreakHyphen/>") text += "-";
    else text += m[0] === "<w:tab/>" ? "\t" : "\n";
  }
  return text;
}

async function docxText(buffer, name) {
  let files;
  try {
    files = await unzip(buffer, (entry) => entry === "word/document.xml");
  } catch {
    throw new FileReadError(`${name} could not be opened as a Word file. Open it in Word and save it again as .docx.`);
  }
  let xml = files["word/document.xml"];
  if (!xml) throw new FileReadError(`${name} could not be opened as a Word file. Open it in Word and save it again as .docx.`);

  // A table row becomes one line with its cells separated by tabs, so a
  // "No. | Question | Category" table stays together.
  xml = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((cell) =>
      cell[0]
        .split(/<\/w:p>/)
        .map(wordRuns)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
    return `<w:p><w:r><w:t>${escapeXml(cells.join("\t"))}</w:t></w:r></w:p>`;
  });

  return xml.split(/<\/w:p>/).map(wordRuns).join("\n");
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* --------------------------------- Excel -------------------------------- */

const columnIndex = (ref) => {
  let index = 0;
  for (const ch of String(ref).replace(/\d+/g, "")) index = index * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return index;
};

async function xlsxText(buffer, name) {
  let files;
  try {
    files = await unzip(buffer, (entry) => entry === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  } catch {
    throw new FileReadError(`${name} could not be opened as an Excel file. Open it in Excel and save it again as .xlsx.`);
  }

  // Excel keeps each distinct piece of text once, and cells point to it.
  const shared = [...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1])).join("")
  );

  const sheets = Object.keys(files)
    .filter((entry) => entry.startsWith("xl/worksheets/"))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) throw new FileReadError(`${name} has no sheets with data in it.`);

  const lines = [];
  for (const sheet of sheets) {
    for (const row of files[sheet].matchAll(/<row[ >][\s\S]*?<\/row>/g)) {
      const cells = [];
      for (const cell of row[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1];
        const inner = cell[2] ?? "";
        const ref = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = attributes.match(/\bt="(\w+)"/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(inner.match(/<v>(\d+)<\/v>/)?.[1])] ?? "";
        else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1])).join("");
        else value = unescapeXml(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
        cells[ref ? columnIndex(ref) - 1 : cells.length] = value.replace(/[\t\n\r]+/g, " ").trim();
      }
      const line = Array.from(cells, (c) => c ?? "").join("\t").replace(/\t+$/, "");
      if (line.trim()) lines.push(line);
    }
  }
  return lines.join("\n");
}
