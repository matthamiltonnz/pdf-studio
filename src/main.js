import { $$, toast } from './util.js';
import { initDocuments } from './documents.js';
import { initMarkup } from './markup.js';

const TABS = ['documents', 'help'];

function showTab(name, { focus = false, updateHash = true } = {}) {
  if (name !== 'markup' && !TABS.includes(name)) name = 'documents';
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  $$('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const markupPanel = document.getElementById('panel-markup');
  document.body.classList.toggle('markup-editing', name === 'markup' && Boolean(markupPanel && markupPanel.classList.contains('is-open')));
  if (name === 'markup' && markupPanel && markupPanel.classList.contains('is-open')) window.dispatchEvent(new Event('resize'));
  if (updateHash) {
    const nextHash = `#${name}`;
    if (location.hash !== nextHash) {
      try { history.replaceState(null, '', nextHash); } catch { /* file:// or sandboxed contexts */ }
    }
  }
}

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const markupPanel = document.getElementById('panel-markup');
      const editing = Boolean(markupPanel && !markupPanel.hidden && markupPanel.classList.contains('is-open'));
      if (editing) {
        if (tab.dataset.tab === 'documents') {
          document.getElementById('markup-back').click();
        } else {
          toast('Use ← Documents to save your markup and return first.', 'warn');
        }
        return;
      }
      showTab(tab.dataset.tab);
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const markupPanel = document.getElementById('panel-markup');
      if (markupPanel && !markupPanel.hidden && markupPanel.classList.contains('is-open')) return;
      const current = TABS.indexOf(tab.dataset.tab);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = (current + direction + TABS.length) % TABS.length;
      showTab(TABS[next], { focus: true });
    });
  });
  window.addEventListener('pdfstudio:show-tab', (event) => {
    showTab(event.detail, { updateHash: event.detail !== 'markup' });
  });

  const initial = location.hash.replace('#', '');
  showTab(TABS.includes(initial) ? initial : 'documents', { updateHash: false });
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (TABS.includes(name)) showTab(name, { updateHash: false });
  });
}

function init() {
  initTabs();
  initDocuments();
  initMarkup();

  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    const message = event.reason && event.reason.message ? event.reason.message : String(event.reason);
    toast(`Unexpected error: ${message}`, 'error', 7000);
  });
  window.addEventListener('error', (event) => {
    if (!event.message) return;
    console.error(event.error || event.message);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
