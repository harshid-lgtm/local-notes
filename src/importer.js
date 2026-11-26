// Convert files into Local Notes pages (markdown). Runs in the browser; heavy libraries load on demand.
// Supported: Word (.docx), PDF, web pages (.html), Excel (.xlsx), CSV/TSV, PowerPoint (.pptx),
// OpenDocument text (.odt), Rich Text (.rtf), Markdown, plain text, JSON and images.
// Images inside documents come back as { id, name, blob } and are referenced as ln-image://id.

export const IMPORT_EXTS = ['md', 'markdown', 'txt', 'html', 'htm', 'docx', 'pdf', 'xlsx', 'csv', 'tsv', 'pptx', 'odt', 'rtf', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
export const IMPORT_ACCEPT = IMPORT_EXTS.map((e) => `.${e}`).join(',');
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const OLD_FORMATS = { doc: 'Word', xls: 'Excel', ppt: 'PowerPoint', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation' };
const NEWER = { doc: '.docx', xls: '.xlsx', ppt: '.pptx', ods: '.xlsx', odp: '.pptx' };

export const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const titleOf = (name) => String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim() || 'Imported';
const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

let imgSeq = 0;
const newImage = (blob, name) => ({ id: `i${Date.now().toString(36)}${++imgSeq}`, name, blob });

// ------------------------------------------------------------------ HTML → markdown
let turndownP = null;
async function turndown() {
  if (!turndownP) {
    turndownP = (async () => {
      const [{ default: TurndownService }, gfm] = await Promise.all([import('turndown'), import('turndown-plugin-gfm')]);
      const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', hr: '---' });
      td.use(gfm.gfm);
      td.keep(['u', 'sub', 'sup']);
      td.addRule('mark', { filter: 'mark', replacement: (c) => (c.trim() ? `==${c}==` : c) });
      td.addRule('styledSpan', {
        filter: (n) => n.nodeName === 'SPAN' && /color|font-size/i.test(n.getAttribute('style') || ''),
        replacement: (c, n) => {
          const st = n.getAttribute('style') || '';
          const color = /(?:^|;)\s*color:\s*([^;]+)/i.exec(st)?.[1]?.trim();
          const size = /font-size:\s*([\d.]+(?:px|pt|em|rem|%))/i.exec(st)?.[1];
          const parts = [color && /^(#[0-9a-f]{3,8}|rgb\([\d\s,]+\))$/i.test(color) && !/^(#000(000)?|black|rgb\(0,\s*0,\s*0\))$/i.test(color) && `color: ${color};`, size && `font-size: ${size};`].filter(Boolean);
          return parts.length && c.trim() ? `<span style="${parts.join(' ')}">${c}</span>` : c;
        },
      });
      td.remove(['script', 'style', 'noscript', 'iframe', 'object', 'head', 'title', 'meta', 'link']);
      return td;
    })();
  }
  return turndownP;
}

export async function htmlToMarkdown(html, { baseUrl = null } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // drop page chrome when importing a whole web page
  for (const el of doc.querySelectorAll('nav, header[role=banner], footer, aside, form, button, [aria-hidden=true]')) el.remove();
  const main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  if (baseUrl) for (const el of main.querySelectorAll('a[href], img[src]')) {
    const attr = el.tagName === 'A' ? 'href' : 'src';
    try { el.setAttribute(attr, new URL(el.getAttribute(attr), baseUrl).href); } catch { /* keep as is */ }
  }
  // markdown tables need a header row: promote the first row; keep cells to one line
  for (const table of main.querySelectorAll('table')) {
    const first = table.querySelector('tr');
    if (first && !table.querySelector('th')) for (const cell of [...first.children]) { const th = doc.createElement('th'); th.innerHTML = cell.innerHTML; cell.replaceWith(th); }
    for (const cell of table.querySelectorAll('td, th')) {
      for (const p of [...cell.querySelectorAll('p')]) { p.insertAdjacentHTML('afterend', p.nextElementSibling ? '<br>' : ''); p.replaceWith(...p.childNodes); }
    }
    if (first && first.parentElement.tagName === 'TBODY' && !table.querySelector('thead')) { const thead = doc.createElement('thead'); thead.append(first); table.prepend(thead); }
  }
  const td = await turndown();
  return { markdown: td.turndown(main.innerHTML || '').replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, '$1$2 '), title: doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || '' };
}

// ------------------------------------------------------------------ tables
export function tableMarkdown(rows, { maxRows = 5000 } = {}) {
  const clean = rows.map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, c.getUTCHours() || c.getUTCMinutes() ? 16 : 10).replace('T', ' ') : String(c))));
  while (clean.length && clean[clean.length - 1].every((c) => !c.trim())) clean.pop();
  if (!clean.length) return '_(empty)_';
  const width = Math.max(...clean.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => mdEscape(r[i] ?? '').trim());
  const [head, ...body] = clean;
  const shown = body.slice(0, maxRows);
  const lines = [`| ${pad(head).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...shown.map((r) => `| ${pad(r).join(' | ')} |`)];
  if (body.length > maxRows) lines.push('', `_…and ${body.length - maxRows} more rows (only the first ${maxRows} were imported)._`);
  return lines.join('\n');
}

export function parseDelimited(text, delimiter) {
  const src = text.replace(/^﻿/, '');
  if (!delimiter) {
    const first = src.split(/\r?\n/, 1)[0];
    const count = (ch) => first.split(ch).length - 1;
    delimiter = [['\t', count('\t')], [';', count(';')], [',', count(',')]].sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ------------------------------------------------------------------ formats
async function fromDocx(file) {
  const mammoth = (await import('mammoth/mammoth.browser.js')).default;
  const images = [];
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
    convertImage: mammoth.images.imgElement(async (img) => {
      const bytes = await img.read();
      const ext = (img.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('x-emf', 'emf');
      const im = newImage(new Blob([bytes], { type: img.contentType }), `image-${images.length + 1}.${ext}`);
      images.push(im);
      return { src: `ln-image://${im.id}` };
    }),
    styleMap: ["u => u", "strike => del", "highlight => mark"],
  });
  const { markdown } = await htmlToMarkdown(html);
  return { markdown, images };
}

async function fromPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.js';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  const chars = new Map(); // font size -> characters set in it
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const lines = [];
    for (const it of items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      const size = Math.round((Math.hypot(it.transform[2], it.transform[3]) || it.height || 10) * 10) / 10;
      let line = lines.find((l) => Math.abs(l.y - y) <= Math.max(2, size * 0.3));
      if (!line) { line = { y, size, parts: [] }; lines.push(line); }
      line.parts.push({ x: it.transform[4], w: it.width, str: it.str });
      line.size = Math.max(line.size, size);
      if (it.str.trim()) chars.set(size, (chars.get(size) || 0) + it.str.trim().length);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let end = null;
      for (const p of l.parts) {
        if (end !== null && p.x - end > l.size * 0.2 && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' ';
        text += p.str;
        end = p.x + p.w;
      }
      l.text = text.replace(/\s+/g, ' ').trim();
    }
    pages.push(lines.filter((l) => l.text));
  }
  // body text size = the size most characters use
  const body = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const out = [];
  for (const lines of pages) {
    let para = '';
    let prev = null;
    const flush = () => { if (para.trim()) out.push(para.trim()); para = ''; };
    for (const l of lines) {
      const bullet = /^[•▪◦●○■\-–]\s+/.test(l.text);
      const gap = prev ? prev.y - l.y : 0;
      if (l.size >= body * 1.25 && l.text.length < 90) {
        flush();
        out.push(`${l.size >= body * 1.9 ? '#' : l.size >= body * 1.45 ? '##' : '###'} ${l.text}`);
      } else if (bullet) {
        flush();
        para = `- ${l.text.replace(/^[•▪◦●○■\-–]\s+/, '')}`;
      } else if (!prev || gap > l.size * 1.8 || /[.:!?]$/.test(para) && gap > l.size * 1.4) {
        flush();
        para = l.text;
      } else {
        para = para.endsWith('-') ? para.slice(0, -1) + l.text : `${para} ${l.text}`;
      }
      prev = l;
    }
    flush();
  }
  if (!out.length) return { markdown: '_This PDF has no selectable text (it may be a scanned image)._', images: [] };
  return { markdown: out.join('\n\n'), images: [] };
}

async function fromXlsx(file) {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = await readXlsxFile(file);
  const parts = sheets.map(({ sheet, data }) => (sheets.length > 1 ? `## ${sheet}\n\n` : '') + tableMarkdown(data));
  return { markdown: parts.join('\n\n'), images: [] };
}

const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');

async function fromPptx(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const out = [];
  for (const [i, name] of slides.entries()) {
    const doc = xml(await zip.file(name).async('string'));
    let title = '';
    const lines = [];
    for (const sp of doc.getElementsByTagNameNS('*', 'sp')) {
      const ph = sp.getElementsByTagNameNS('*', 'ph')[0]?.getAttribute('type') || '';
      const paras = [...sp.getElementsByTagNameNS('*', 'p')].map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('').trim()).filter(Boolean);
      if (!paras.length) continue;
      if (!title && /title|ctrTitle/i.test(ph)) title = paras.join(' ');
      else lines.push(...paras);
    }
    out.push(`## ${i + 1}. ${title || `Slide ${i + 1}`}`, ...(lines.length ? [lines.map((l) => `- ${l}`).join('\n')] : []));
  }
  return { markdown: out.join('\n\n') || '_No text found in this presentation._', images: [] };
}

async function fromOdt(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const doc = xml(await zip.file('content.xml').async('string'));
  const textOf = (el) => {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.localName === 's') s += ' '.repeat(+n.getAttribute('text:c') || 1);
      else if (n.localName === 'tab') s += '\t';
      else if (n.localName === 'line-break') s += '  \n';
      else if (n.localName !== 'note') s += textOf(n);
    }
    return s;
  };
  const out = [];
  const walk = (el, depth = 0) => {
    for (const n of el.children) {
      if (n.localName === 'h') out.push(`${'#'.repeat(Math.min(6, +n.getAttribute('text:outline-level') || 1))} ${textOf(n).trim()}`);
      else if (n.localName === 'p') { const t = textOf(n).trim(); if (t) out.push(t); }
      else if (n.localName === 'list') {
        for (const item of n.children) {
          if (item.localName !== 'list-item') continue;
          for (const c of item.children) {
            if (c.localName === 'p' || c.localName === 'h') out.push(`${'  '.repeat(depth)}- ${textOf(c).trim()}`);
            else if (c.localName === 'list') walk({ children: [c] }, depth + 1);
          }
        }
      } else if (n.localName === 'table') {
        const rows = [...n.getElementsByTagNameNS('*', 'table-row')].map((r) => [...r.children].filter((c) => c.localName === 'table-cell').map((c) => textOf(c).trim()));
        out.push(tableMarkdown(rows));
      } else if (n.localName === 'section' || n.localName === 'text') walk(n, depth);
    }
  };
  const body = doc.getElementsByTagNameNS('*', 'text')[0];
  if (body) walk(body);
  return { markdown: out.join('\n\n'), images: [] };
}

function fromRtf(text) {
  let s = text.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((+n + 65536) % 65536));
  s = s.replace(/\\(par|line)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t');
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '');
  return { markdown: s.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean).join('\n\n'), images: [] };
}

// ------------------------------------------------------------------ entry point
// file: a File/Blob with a name. Returns { title, markdown, images }.
export async function convertFile(file, { baseUrl = null } = {}) {
  const ext = extOf(file.name);
  const title = titleOf(file.name);
  if (OLD_FORMATS[ext]) throw new Error(`“${file.name}” is an older ${OLD_FORMATS[ext]} format. Save it as ${NEWER[ext]} and import that.`);
  if (IMAGE_EXTS.includes(ext)) {
    const im = newImage(file, file.name);
    return { title, markdown: `![${title}](ln-image://${im.id})`, images: [im] };
  }
  let r;
  switch (ext) {
    case 'md': case 'markdown': r = { markdown: await file.text(), images: [] }; break;
    case 'txt': r = { markdown: (await file.text()).replace(/\r\n/g, '\n'), images: [] }; break;
    case 'html': case 'htm': {
      const h = await htmlToMarkdown(await file.text(), { baseUrl });
      r = { markdown: h.markdown, images: [], title: h.title };
      break;
    }
    case 'docx': r = await fromDocx(file); break;
    case 'pdf': r = await fromPdf(file); break;
    case 'xlsx': r = await fromXlsx(file); break;
    case 'csv': r = { markdown: tableMarkdown(parseDelimited(await file.text(), ',')), images: [] }; break;
    case 'tsv': r = { markdown: tableMarkdown(parseDelimited(await file.text(), '\t')), images: [] }; break;
    case 'pptx': r = await fromPptx(file); break;
    case 'odt': r = await fromOdt(file); break;
    case 'rtf': r = fromRtf(await file.text()); break;
    case 'json': {
      const t = await file.text();
      let pretty = t;
      try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch { /* keep as is */ }
      r = { markdown: `\`\`\`json\n${pretty}\n\`\`\``, images: [] };
      break;
    }
    default: throw new Error(`Local Notes can’t import .${ext || '?'} files yet.`);
  }
  // web pages fetched from an address are named after their own title
  const useDocTitle = r.title && ['html', 'htm'].includes(ext) && (baseUrl || /^(index|page|download)/i.test(title));
  return { title: useDocTitle ? titleOf(r.title) : title, markdown: r.markdown.trim() + '\n', images: r.images };
}

// Replace ln-image://id references once images are stored somewhere.
export function linkImages(markdown, images, urlFor) {
  let md = markdown;
  for (const im of images) md = md.split(`ln-image://${im.id}`).join(urlFor(im));
  return md;
}

export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
