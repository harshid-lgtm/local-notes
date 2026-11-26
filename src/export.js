// Export the open page: PDF, Word (.docx), web page (.html), Markdown and plain text.
// Shared by the local vault app and team workspaces. Heavy libraries load on first use.
import { toast } from './ui.js';

const safeName = (s) => (String(s || 'Untitled').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled').slice(0, 120);

export const EXPORT_FORMATS = [
  { id: 'pdf', label: 'PDF', icon: 'file-down', ext: 'pdf' },
  { id: 'docx', label: 'Word document (.docx)', icon: 'file-down', ext: 'docx' },
  { id: 'html', label: 'Web page (.html)', icon: 'file-down', ext: 'html' },
  { id: 'md', label: 'Markdown (.md)', icon: 'file-down', ext: 'md' },
  { id: 'txt', label: 'Plain text (.txt)', icon: 'file-down', ext: 'txt' },
];

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
};

// Save bytes or text: native save dialog in the desktop app, a download in a browser.
export async function saveAs(name, ext, data) {
  const file = `${safeName(name)}.${ext}`;
  if (window.desktop?.saveFile) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    const saved = await window.desktop.saveFile({ name: file, ext, data: bytes });
    if (saved) toast(`Saved ${saved.split(/[\\/]/).pop()}`, { kind: 'success', action: window.desktop.reveal ? { label: 'Show in folder', run: () => window.desktop.reveal(saved) } : undefined });
    return !!saved;
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast(`Downloaded ${file}`, { kind: 'success' });
  return true;
}

// ------------------------------------------------------------------ HTML
const blobToDataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(blob); });

async function fetchImage(src) {
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.blob();
  } catch { return null; }
}

export const EXPORT_CSS = `
  @page { margin: 18mm 16mm; }
  body { font-family: -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif; color: #1f1f1d; line-height: 1.6; font-size: 11.5pt; max-width: 760px; margin: 32px auto; padding: 0 24px; }
  @media print { body { margin: 0; padding: 0; max-width: none; } }
  h1.doc-title { font-size: 26pt; line-height: 1.15; margin: 0 0 18px; letter-spacing: -0.01em; }
  h1 { font-size: 20pt; margin: 26px 0 8px; } h2 { font-size: 16pt; margin: 22px 0 6px; } h3 { font-size: 13.5pt; margin: 18px 0 4px; }
  h4, h5, h6 { font-size: 12pt; margin: 14px 0 4px; }
  p { margin: 0 0 8px; } a { color: #2f6fb3; }
  ul, ol { margin: 0 0 8px; padding-left: 24px; }
  ul[data-type="taskList"] { list-style: none; padding-left: 4px; }
  ul[data-type="taskList"] li { display: flex; gap: 8px; align-items: flex-start; }
  ul[data-type="taskList"] li > label { margin-top: 2px; }
  ul[data-type="taskList"] li[data-checked="true"] > div { text-decoration: line-through; color: #8a8985; }
  blockquote { margin: 8px 0; padding: 4px 14px; border-left: 3px solid #d6d4cf; color: #4a4946; }
  code { font-family: "Cascadia Code", Consolas, "SF Mono", Menlo, monospace; font-size: 0.9em; background: #f1f0ee; padding: 1px 4px; border-radius: 4px; color: #c2410c; }
  pre { background: #f6f5f3; padding: 12px 14px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  th, td { border: 1px solid #dddbd6; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f6f5f3; font-weight: 600; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  hr { border: 0; border-top: 1px solid #e3e1dc; margin: 18px 0; }
  mark { background: #fff3a3; padding: 0 1px; border-radius: 2px; }
  .wikilink { color: #2f6fb3; }
  .comment-mark { background: none; }
`;

// Skip the export's own title when the page already starts with that heading.
const startsWithTitle = (editor, title) => {
  const first = editor.state.doc.firstChild;
  return first?.type.name === 'heading' && first.textContent.trim().toLowerCase() === String(title).trim().toLowerCase();
};

export async function pageHtml(editor, title, { forPrint = false } = {}) {
  const doc = new DOMParser().parseFromString(`<div id="x">${editor.getHTML()}</div>`, 'text/html');
  const root = doc.getElementById('x');
  for (const m of root.querySelectorAll('mark[data-color]')) m.style.background = m.dataset.color;
  for (const img of root.querySelectorAll('img')) {
    const blob = await fetchImage(img.getAttribute('src'));
    const data = blob && await blobToDataUrl(blob);
    if (data) img.setAttribute('src', data);
    img.removeAttribute('loading');
    img.removeAttribute('data-src');
  }
  for (const cb of root.querySelectorAll('input[type=checkbox]')) { cb.setAttribute('disabled', ''); if (cb.closest('li')?.dataset.checked === 'true') cb.setAttribute('checked', ''); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="generator" content="Local Notes"><style>${EXPORT_CSS}</style></head>
<body${forPrint ? ' class="print"' : ''}>${startsWithTitle(editor, title) ? '' : `<h1 class="doc-title">${esc(title)}</h1>`}
${root.innerHTML}
</body></html>`;
}

// ------------------------------------------------------------------ PDF
async function exportPdf(editor, title) {
  const html = await pageHtml(editor, title, { forPrint: true });
  if (window.desktop?.exportPdf) {
    const saved = await window.desktop.exportPdf({ html, name: `${safeName(title)}.pdf` });
    if (saved) toast(`Saved ${saved.split(/[\\/]/).pop()}`, { kind: 'success', action: { label: 'Show in folder', run: () => window.desktop.reveal(saved) } });
    return;
  }
  // browser: the print dialog's "Save as PDF"
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  frame.srcdoc = html;
  await new Promise((r) => { frame.onload = r; });
  await Promise.all([...frame.contentDocument.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
  toast('Choose “Save as PDF” in the print window', { timeout: 6000 });
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
}

// ------------------------------------------------------------------ Word
async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const out = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  } catch { return { w: 600, h: 400 }; }
}

async function toDocx(editor, title) {
  const d = await import('docx');
  const json = editor.getJSON();
  const pxToHalfPt = (v) => { const n = parseFloat(v); if (!n) return undefined; return Math.round((/pt$/i.test(v) ? n : n * 0.75) * 2); };
  const hex = (c) => (c && /^#?[0-9a-f]{6}$/i.test(c.replace('#', '').slice(0, 6)) ? c.replace('#', '').slice(0, 6).toUpperCase() : undefined);
  const imgSrc = (src) => editor.view.dom.querySelector(`img[data-src="${CSS.escape(src)}"]`)?.getAttribute('src') || src;
  let listInstance = 0;

  function runs(nodes = [], extra = {}) {
    const out = [];
    for (const n of nodes) {
      if (n.type === 'hardBreak') { out.push(new d.TextRun({ text: '', break: 1 })); continue; }
      if (n.type === 'wikilink') { out.push(new d.TextRun({ text: n.attrs.alias || n.attrs.target, color: '2F6FB3', ...extra })); continue; }
      if (n.type === 'wikiEmbed') { out.push(new d.TextRun({ text: `[${n.attrs.target}]`, italics: true, color: '6B6A66' })); continue; }
      if (n.type === 'image') continue; // inline images are added as their own paragraphs
      if (n.type !== 'text') continue;
      const o = { text: n.text, ...extra };
      let href = null;
      for (const m of n.marks || []) {
        if (m.type === 'bold') o.bold = true;
        else if (m.type === 'italic') o.italics = true;
        else if (m.type === 'underline') o.underline = {};
        else if (m.type === 'strike') o.strike = true;
        else if (m.type === 'code') { o.font = 'Consolas'; o.shading = { type: d.ShadingType.CLEAR, fill: 'F1F0EE', color: 'auto' }; }
        else if (m.type === 'highlight') o.shading = { type: d.ShadingType.CLEAR, fill: hex(m.attrs.color) || 'FFF3A3', color: 'auto' };
        else if (m.type === 'textStyle') { if (hex(m.attrs.color)) o.color = hex(m.attrs.color); if (m.attrs.fontSize) o.size = pxToHalfPt(m.attrs.fontSize); }
        else if (m.type === 'link') href = m.attrs.href;
      }
      if (href) out.push(new d.ExternalHyperlink({ link: href, children: [new d.TextRun({ ...o, style: 'Hyperlink' })] }));
      else out.push(new d.TextRun(o));
    }
    return out;
  }

  async function imagesIn(nodes = []) {
    const out = [];
    for (const n of nodes) {
      if (n.type !== 'image') continue;
      const blob = await fetchImage(imgSrc(n.attrs.src));
      if (!blob) { out.push(new d.Paragraph({ children: [new d.TextRun({ text: `[image: ${n.attrs.alt || n.attrs.src}]`, italics: true })] })); continue; }
      const type = /png/.test(blob.type) ? 'png' : /gif/.test(blob.type) ? 'gif' : /bmp/.test(blob.type) ? 'bmp' : 'jpg';
      if (/svg|webp/.test(blob.type)) { out.push(new d.Paragraph({ children: [new d.TextRun({ text: `[image: ${n.attrs.alt || ''}]`, italics: true })] })); continue; }
      const { w, h } = await imageSize(blob);
      const width = Math.min(600, w);
      out.push(new d.Paragraph({ children: [new d.ImageRun({ type, data: new Uint8Array(await blob.arrayBuffer()), transformation: { width, height: Math.round(h * (width / w)) } })] }));
    }
    return out;
  }

  async function blocks(nodes = [], ctx = {}) {
    const out = [];
    for (const n of nodes) {
      switch (n.type) {
        case 'paragraph': {
          out.push(new d.Paragraph({
            children: runs(n.content),
            ...(ctx.list ? { numbering: ctx.list.first ? { reference: ctx.list.ref, level: ctx.list.level, instance: ctx.list.instance } : undefined, indent: ctx.list.first ? undefined : { left: 720 * (ctx.list.level + 1) } } : {}),
            ...(ctx.quote ? { indent: { left: 480 }, border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: 'D6D4CF', space: 8 } } } : {}),
          }));
          if (ctx.list) ctx.list.first = false;
          out.push(...await imagesIn(n.content));
          break;
        }
        case 'heading': {
          const lvl = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6][(n.attrs?.level || 1) - 1];
          out.push(new d.Paragraph({ heading: lvl, children: runs(n.content) }));
          break;
        }
        case 'bulletList':
        case 'orderedList':
        case 'taskList': {
          const instance = ++listInstance;
          const level = ctx.list ? ctx.list.level + 1 : 0;
          for (const item of n.content || []) {
            const prefix = n.type === 'taskList' ? (item.attrs?.checked ? '☑ ' : '☐ ') : '';
            const list = { ref: n.type === 'orderedList' ? 'ln-numbered' : 'ln-bullets', level: Math.min(level, 8), instance, first: true };
            const kids = item.content || [];
            if (n.type === 'taskList') {
              const [firstPara, ...rest] = kids;
              out.push(new d.Paragraph({ indent: { left: 360 + 720 * level, hanging: 360 }, children: [new d.TextRun({ text: prefix }), ...runs(firstPara?.content, item.attrs?.checked ? { strike: true, color: '8A8985' } : {})] }));
              out.push(...await blocks(rest, { ...ctx, list: { ...list, first: false } }));
            } else {
              out.push(...await blocks(kids, { ...ctx, list }));
            }
          }
          break;
        }
        case 'blockquote': out.push(...await blocks(n.content, { ...ctx, quote: true })); break;
        case 'codeBlock': {
          const lines = (n.content?.map((t) => t.text).join('') || '').split('\n');
          for (const line of lines) {
            out.push(new d.Paragraph({ spacing: { before: 0, after: 0 }, shading: { type: d.ShadingType.CLEAR, fill: 'F6F5F3', color: 'auto' }, children: [new d.TextRun({ text: line || ' ', font: 'Consolas', size: 19 })] }));
          }
          out.push(new d.Paragraph({ children: [] }));
          break;
        }
        case 'horizontalRule': out.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'D6D4CF', space: 1 } }, children: [] })); break;
        case 'table': {
          const rows = [];
          for (const row of n.content || []) {
            const cells = [];
            for (const cell of row.content || []) {
              const kids = await blocks(cell.content || [], {});
              cells.push(new d.TableCell({
                children: kids.length ? kids : [new d.Paragraph('')],
                columnSpan: cell.attrs?.colspan || 1,
                rowSpan: cell.attrs?.rowspan || 1,
                shading: cell.type === 'tableHeader' ? { type: d.ShadingType.CLEAR, fill: 'F6F5F3', color: 'auto' } : undefined,
              }));
            }
            rows.push(new d.TableRow({ children: cells }));
          }
          if (rows.length) out.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } }), new d.Paragraph(''));
          break;
        }
        case 'image': out.push(...await imagesIn([n])); break;
        default: if (n.content) out.push(...await blocks(n.content, ctx));
      }
    }
    return out;
  }

  const levels = (fmt) => Array.from({ length: 9 }, (_, i) => ({
    level: i,
    format: fmt === 'bullet' ? d.LevelFormat.BULLET : [d.LevelFormat.DECIMAL, d.LevelFormat.LOWER_LETTER, d.LevelFormat.LOWER_ROMAN][i % 3],
    text: fmt === 'bullet' ? ['•', '◦', '▪'][i % 3] : `%${i + 1}.`,
    alignment: d.AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
  }));
  const body = await blocks(json.content);
  const doc = new d.Document({
    creator: 'Local Notes',
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'ln-bullets', levels: levels('bullet') }, { reference: 'ln-numbered', levels: levels('number') }] },
    sections: [{ children: [...(startsWithTitle(editor, title) ? [] : [new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(title)] })]), ...body] }],
  });
  return d.Packer.toBlob(doc);
}

// ------------------------------------------------------------------ text
function plainText(editor, title) {
  const lines = [];
  editor.state.doc.forEach((block) => {
    if (block.type.name === 'taskList' || block.type.name === 'bulletList' || block.type.name === 'orderedList') {
      let i = block.attrs.start || 1;
      block.forEach((item) => {
        const mark = block.type.name === 'taskList' ? (item.attrs.checked ? '[x] ' : '[ ] ') : block.type.name === 'orderedList' ? `${i++}. ` : '• ';
        lines.push(mark + item.textBetween(0, item.content.size, '\n   ', ' '));
      });
      lines.push('');
    } else {
      lines.push(block.textBetween(0, block.content.size, '\n', ' '), '');
    }
  });
  return `${title}\n${'='.repeat(Math.min(60, title.length))}\n\n${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ------------------------------------------------------------------ entry point
export async function exportPage({ editor, title, markdown, format }) {
  if (!editor) return;
  const name = title || 'Untitled';
  try {
    if (format === 'pdf') return await exportPdf(editor, name);
    if (format === 'docx') return await saveAs(name, 'docx', await toDocx(editor, name));
    if (format === 'html') return await saveAs(name, 'html', await pageHtml(editor, name));
    if (format === 'md') return await saveAs(name, 'md', markdown ?? '');
    if (format === 'txt') return await saveAs(name, 'txt', plainText(editor, name));
  } catch (e) {
    console.error(e);
    toast(`Couldn’t export: ${e.message}`, { kind: 'error' });
  }
}

export async function printPage({ editor, title }) {
  if (!editor) return;
  const html = await pageHtml(editor, title || 'Untitled', { forPrint: true });
  if (window.desktop?.printHtml) { await window.desktop.printHtml(html); return; }
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  frame.srcdoc = html;
  await new Promise((r) => { frame.onload = r; });
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
}

export const exportMenuItems = (opts) => EXPORT_FORMATS.map((f) => ({ label: f.label, icon: f.icon, run: () => exportPage({ ...opts(), format: f.id }) }));
