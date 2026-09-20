(function () {
  'use strict';

  const elephantMarkup = (small = false) => `
    <span class="${small ? 'inline-elephant' : 'walking-elephant'}" aria-hidden="true">
      <svg viewBox="0 0 160 122" focusable="false">
        <ellipse class="elephant-shadow" cx="82" cy="116" rx="50" ry="5.5"></ellipse>
        <g class="elephant-figure">
          <path class="elephant-body" d="M48 18C62 7 82 3 98 8c17 5 27 20 27 38 15 4 26 15 31 30 5 15 1 29-7 40h-30c0-15-7-24-18-24s-19 9-19 24H57V83c0-20-9-34-19-34S22 61 22 76c0 15 5 25 9 31 4 7 0 12-7 12C12 119 4 105 4 85V55c0-20 14-32 34-34 4 0 7-1 10-3Z"></path>
          <circle class="elephant-eye" cx="45" cy="43" r="4"></circle>
          <path class="elephant-ear" d="M74 59c25 1 41-13 46-34"></path>
        </g>
      </svg>
    </span>`;

  let activeRequests = 0;
  let showTimer = null;
  let overlay = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    if (!document.body) return null;
    overlay = document.getElementById('workspaceBootLoader');
    if (overlay) return overlay;
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
      if (node.closest && node.closest('.workspace-loading')) return;
      if (node.querySelector && node.querySelector(':scope > .inline-loading-content')) return;
      const value = node.textContent.trim();
      if (!/^(加载中|正在加载|正在查询|正在生成)(…|\.\.\.)?$/.test(value)) return;
      node.dataset.elephantLoading = 'true';
      node.innerHTML = `<span class="inline-loading-content">${elephantMarkup(true)}<span>${value.replace(/(…|\.\.\.)$/, '')}</span></span>`;
    });
  }

  function balanceActionGrids() {
    const viewportWidth = window.innerWidth;
    document.querySelectorAll('.app-grid').forEach(grid => {
      const items = Array.from(grid.children).filter(item =>
        item.classList.contains('app-tile') && !item.hidden && getComputedStyle(item).display !== 'none'
      );
      grid.classList.remove('app-grid-balanced', 'app-grid-cols-2', 'app-grid-cols-3', 'app-grid-cols-4', 'app-grid-rem-0', 'app-grid-rem-1', 'app-grid-rem-2', 'app-grid-rem-3');
      grid.querySelectorAll('.app-grid-tail').forEach(item => item.classList.remove('app-grid-tail'));
      if (!items.length) return;

      let columns = viewportWidth <= 768 ? 2 : viewportWidth <= 1100 ? 3 : 4;
      if (viewportWidth > 1100 && items.length % 3 === 0 && items.length % 4 !== 0) columns = 3;
      const remainder = items.length % columns;
      grid.classList.add('app-grid-balanced', `app-grid-cols-${columns}`, `app-grid-rem-${remainder}`);
      if (remainder) items.slice(-remainder).forEach(item => item.classList.add('app-grid-tail'));
    });
  }

  function bindBalancedGridResize() {
    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(balanceActionGrids);
    }, { passive: true });
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
    balanceActionGrids();
    bindBalancedGridResize();
    bindNavigationLoading();
    const observer = new MutationObserver(records => {
      records.forEach(record => record.addedNodes.forEach(replaceLoadingCopy));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
