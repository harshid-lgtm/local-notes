// Find & replace inside the open page (Ctrl+F / Ctrl+H). Works in local and team editors.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { icon } from './icons.js';
import { h } from './ui.js';

const key = new PluginKey('ln-find');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// All matches as document ranges. Each textblock's text maps 1:1 onto positions,
// because inline leaves (images, wikilinks, line breaks) are one position each.
function findAll(doc, { query, caseSensitive, wholeWord }) {
  if (!query) return [];
  const re = new RegExp(wholeWord ? `\\b${escapeRe(query)}\\b` : escapeRe(query), caseSensitive ? 'g' : 'gi');
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = doc.textBetween(pos + 1, pos + 1 + node.content.size, '\n', '￼');
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      if (out.length > 5000) return false;
    }
    return false;
  });
  return out;
}

export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ query: '', caseSensitive: false, wholeWord: false, results: [], index: -1 }),
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(key);
          if (!meta && !tr.docChanged) return prev;
          const next = { ...prev, ...(meta || {}) };
          next.results = findAll(state.doc, next);
          if (meta && 'index' in meta) next.index = meta.index;
          if (next.index >= next.results.length) next.index = next.results.length ? 0 : -1;
          if (next.index < 0 && next.results.length) next.index = 0;
          return next;
        },
      },
      props: {
        decorations(state) {
          const f = key.getState(state);
          if (!f?.query || !f.results.length) return null;
          return DecorationSet.create(state.doc, f.results.map((r, i) => Decoration.inline(r.from, r.to, { class: i === f.index ? 'find-hit current' : 'find-hit' })));
        },
      },
    })];
  },
});

const findState = (editor) => key.getState(editor.state);
function setFind(editor, patch) { editor.view.dispatch(editor.state.tr.setMeta(key, patch)); }
function reveal(editor) {
  const f = findState(editor);
  const r = f?.results[f.index];
  if (!r) return;
  const { tr } = editor.state;
  tr.setSelection(TextSelection.create(tr.doc, r.from, r.to)).scrollIntoView();
  editor.view.dispatch(tr);
  // keep the match away from the top bar
  requestAnimationFrame(() => document.querySelector('.find-hit.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}

let bar = null;
export const closeFindBar = () => bar?.close();

export function openFindBar(editor, { replace = false, host = document.body } = {}) {
  if (!editor?.extensionManager.extensions.some((e) => e.name === 'findReplace')) return;
  const canReplace = editor.isEditable;
  const selected = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ').trim();
  if (bar && bar.editor === editor) {
    bar.showReplace(replace && canReplace);
    if (selected && !selected.includes('\n') && selected.length < 120) bar.setQuery(selected);
    bar.focus();
    return;
  }
  bar?.close();
  const el = h(`<div class="find-bar pop" role="search">
    <div class="fb-row">
      <button class="fb-toggle-rep" title="Find and replace (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+H)" ${canReplace ? '' : 'hidden'}>${icon('chevron-right', 14, 2)}</button>
      <div class="fb-field">${icon('search', 15)}<input class="fb-q" placeholder="Find in page" spellcheck="false"><span class="fb-count"></span></div>
      <button class="fb-opt" data-opt="caseSensitive" title="Match case">${icon('match-case', 16)}</button>
      <button class="fb-opt" data-opt="wholeWord" title="Whole words">${icon('whole-word', 16)}</button>
      <button class="fb-btn" data-go="-1" title="Previous (Shift+Enter)">${icon('chevron-up', 16, 2)}</button>
      <button class="fb-btn" data-go="1" title="Next (Enter)">${icon('chevron-down', 16, 2)}</button>
      <button class="fb-btn" data-close title="Close (Esc)">${icon('x', 16)}</button>
    </div>
    <div class="fb-row fb-rep" hidden>
      <span class="fb-indent"></span>
      <div class="fb-field">${icon('replace', 15)}<input class="fb-r" placeholder="Replace with" spellcheck="false"></div>
      <button class="btn ghost small" data-rep>Replace</button>
      <button class="btn ghost small" data-rep-all>Replace all</button>
    </div>
  </div>`);
  host.append(el);
  const q = el.querySelector('.fb-q');
  const r = el.querySelector('.fb-r');
  const count = el.querySelector('.fb-count');
  const update = () => {
    const f = findState(editor);
    count.textContent = !f?.query ? '' : f.results.length ? `${f.index + 1} of ${f.results.length}` : 'No results';
    count.classList.toggle('none', !!f?.query && !f.results.length);
    el.querySelectorAll('[data-opt]').forEach((b) => b.classList.toggle('on', !!f?.[b.dataset.opt]));
  };
  const onTx = () => update();
  editor.on('transaction', onTx);
  const go = (d) => {
    const f = findState(editor);
    if (!f?.results.length) return;
    setFind(editor, { index: (f.index + d + f.results.length) % f.results.length });
    reveal(editor);
    update();
  };
  const run = () => {
    setFind(editor, { query: q.value, index: 0 });
    // start from the match nearest the cursor
    const f = findState(editor);
    const from = editor.state.selection.from;
    const near = f.results.findIndex((x) => x.from >= from);
    if (near > 0) setFind(editor, { index: near });
    if (f.results.length) reveal(editor);
    update();
  };
  const replaceOne = () => {
    const f = findState(editor);
    const m = f?.results[f.index];
    if (!m || !canReplace) return;
    editor.view.dispatch(editor.state.tr.insertText(r.value, m.from, m.to));
    const after = findState(editor);
    if (after.results.length) { setFind(editor, { index: Math.min(f.index, after.results.length - 1) }); reveal(editor); }
    update();
  };
  const replaceAll = () => {
    const f = findState(editor);
    if (!f?.results.length || !canReplace) return;
    const { tr } = editor.state;
    for (const m of [...f.results].reverse()) tr.insertText(r.value, m.from, m.to);
    editor.view.dispatch(tr);
    count.textContent = `Replaced ${f.results.length}`;
    count.classList.remove('none');
  };
  q.addEventListener('input', run);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  });
  r.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  });
  el.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.go) go(+b.dataset.go);
    else if (b.dataset.opt) { const f = findState(editor); setFind(editor, { [b.dataset.opt]: !f[b.dataset.opt] }); if (findState(editor).results.length) reveal(editor); update(); }
    else if ('close' in b.dataset) close(true);
    else if ('rep' in b.dataset) replaceOne();
    else if ('repAll' in b.dataset) replaceAll();
    else if (b.classList.contains('fb-toggle-rep')) showReplace(el.querySelector('.fb-rep').hidden);
  });
  function showReplace(on) {
    el.querySelector('.fb-rep').hidden = !on;
    el.querySelector('.fb-toggle-rep').classList.toggle('open', on);
    if (on) setTimeout(() => r.focus(), 0);
  }
  function close(refocus = false) {
    editor.off('transaction', onTx);
    if (!editor.isDestroyed) setFind(editor, { query: '' });
    el.remove();
    if (bar?.el === el) bar = null;
    if (refocus && !editor.isDestroyed) editor.commands.focus();
  }
  bar = {
    el, editor, close: () => close(false),
    showReplace,
    setQuery: (v) => { q.value = v; run(); },
    focus: () => { q.focus(); q.select(); },
  };
  showReplace(replace && canReplace);
  if (selected && !selected.includes('\n') && selected.length < 120) q.value = selected;
  q.focus();
  q.select();
  if (q.value) run();
  update();
  editor.on('destroy', () => close(false));
}

export const findBarOpen = () => !!bar;
