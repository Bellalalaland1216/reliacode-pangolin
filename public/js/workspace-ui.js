(function () {
  'use strict';

  const elephantMarkup = (small = false) => `
    <span class="${small ? 'inline-elephant' : 'walking-elephant'}" aria-hidden="true">
      <svg viewBox="0 0 160 118" focusable="false">
        <ellipse class="elephant-shadow" cx="82" cy="105" rx="48" ry="7"></ellipse>
        <g class="elephant-figure">
          <path class="elephant-body" d="M47 28C59 9 93 4 116 18c11 7 18 18 20 32 12 4 20 14 20 28v22h-29V82c0-7-5-12-12-12s-12 5-12 12v18H61V71c0-10-6-18-14-18-9 0-15 8-15 18v21c0 8-5 14-12 14S8 100 8 91V55c0-22 16-37 39-27Z"></path>
          <circle class="elephant-eye" cx="43" cy="43" r="4"></circle>
          <path class="elephant-ear" d="M72 50c20 1 31-8 35-24"></path>
          <path class="elephant-tail" d="M137 55c12-7 16-1 12 8"></path>
          <rect class="elephant-leg elephant-leg-a" x="65" y="83" width="15" height="22" rx="6"></rect>
          <rect class="elephant-leg elephant-leg-b" x="111" y="83" width="15" height="22" rx="6"></rect>
        </g>
      </svg>
    </span>`;

  let activeRequests = 0;
  let showTimer = null;
  let overlay = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    if (!document.body) return null;
    overlay = document.createElement('div');
    overlay.className = 'workspace-loading';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-label', '正在处理');
    overlay.innerHTML = `<div class="workspace-loading-inner">${elephantMarkup()}<span>正在处理</span></div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showLoading() {
    activeRequests += 1;
    if (activeRequests !== 1) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      const node = ensureOverlay();
      if (node && activeRequests > 0) node.classList.add('is-visible');
    }, 120);
  }

  function hideLoading() {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests > 0) return;
    clearTimeout(showTimer);
    if (overlay) overlay.classList.remove('is-visible');
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      showLoading();
      let request;
      try {
        request = originalFetch.apply(this, args);
      } catch (error) {
        hideLoading();
        throw error;
      }
      return Promise.resolve(request).finally(hideLoading);
    };
  }

  window.WorkspaceLoading = { show: showLoading, hide: hideLoading };

  function foldHelp() {
    document.querySelectorAll('.page-header > p, .page-heading > p, .page-heading > .eyebrow').forEach(node => {
      node.hidden = true;
    });

    const helpSelector = [
      '.section-help',
      '.supporting-text',
      '.card > .form-help',
      '.group-card > .form-help',
      '.card > p:not(.empty-state):not(.empty-list-state):not(.form-hint):not([role="status"])',
      '.group-card > p:not(.empty-state):not(.empty-list-state):not(.form-hint):not([role="status"])'
    ].join(', ');
    const unique = new Map();
    document.querySelectorAll(helpSelector).forEach(copy => {
      if (copy.closest('details') || copy.dataset.keepVisible === 'true') return;
      const text = copy.textContent.replace(/\s+/g, ' ').trim();
      if (!text) {
        copy.remove();
        return;
      }
      const section = copy.closest('.card, .group-card, section');
      const heading = section && section.querySelector('.card-title > span:first-child, .card-title, h2, h3');
      if (!unique.has(text)) unique.set(text, { text, title: heading ? heading.textContent.trim() : '' });
      copy.remove();
    });

    document.querySelectorAll('details.page-help').forEach(details => {
      const text = (details.querySelector('.page-help-content') || details).textContent.replace(/\s+/g, ' ').trim();
      if (text && !unique.has(text)) unique.set(text, { text, title: '' });
      details.remove();
    });

    if (!unique.size) return;
    const details = document.createElement('details');
    details.className = 'page-help page-help-hub';
    const summary = document.createElement('summary');
    summary.textContent = '页面说明';
    const body = document.createElement('div');
    body.className = 'page-help-content page-help-list';
    unique.forEach(item => {
      const row = document.createElement('p');
      row.className = 'page-help-item';
      if (item.title) {
        const label = document.createElement('strong');
        label.textContent = item.title;
        row.append(label, document.createTextNode(' · ' + item.text));
      } else {
        row.textContent = item.text;
      }
      body.appendChild(row);
    });
    details.append(summary, body);
    const host = document.querySelector('.container');
    if (!host) return;
    const heading = host.querySelector(':scope > .page-header, :scope > .page-heading');
    if (heading) {
      details.classList.add('page-help-inline');
      heading.append(details);
    }
    else host.prepend(details);
  }

  function replaceLoadingCopy(root) {
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE && root.parentElement) nodes.push(root.parentElement);
    if (root.nodeType === Node.ELEMENT_NODE) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll('td, .empty-list-state, .form-hint, [role="status"]'));
    nodes.forEach(node => {
      if (node.querySelector && node.querySelector(':scope > .inline-loading-content')) return;
      const value = node.textContent.trim();
      if (!/^(加载中|正在加载|正在查询|正在生成)(…|\.\.\.)?$/.test(value)) return;
      node.dataset.elephantLoading = 'true';
      node.innerHTML = `<span class="inline-loading-content">${elephantMarkup(true)}<span>${value.replace(/(…|\.\.\.)$/, '')}</span></span>`;
    });
  }

  function bindNavigationLoading() {
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.target === '_blank' || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return;
      showLoading();
    }, true);
    document.addEventListener('submit', event => {
      if (!event.defaultPrevented) showLoading();
    }, true);
    window.addEventListener('pageshow', () => {
      activeRequests = 0;
      clearTimeout(showTimer);
      if (overlay) overlay.classList.remove('is-visible');
    });
  }

  function init() {
    foldHelp();
    replaceLoadingCopy(document.body);
    bindNavigationLoading();
    const observer = new MutationObserver(records => {
      records.forEach(record => record.addedNodes.forEach(replaceLoadingCopy));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
