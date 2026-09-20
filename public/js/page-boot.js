(() => {
  'use strict';

  const root = document.documentElement;
  const startedAt = performance.now();
  let revealed = false;

  function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function waitForImages() {
    return Promise.allSettled(Array.from(document.images, image => {
      if (typeof image.decode === 'function') return image.decode();
      if (image.complete) return Promise.resolve();
      return new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }));
  }

  async function revealPage() {
    if (revealed) return;
    const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    await Promise.allSettled([fontsReady, waitForImages()]);
    const minimumDelay = Math.max(0, 180 - (performance.now() - startedAt));
    if (minimumDelay) await new Promise(resolve => window.setTimeout(resolve, minimumDelay));
    await nextPaint();
    if (revealed) return;
    revealed = true;
    window.clearTimeout(window.__reliacodeBootFallback);
    const loader = document.getElementById('workspaceBootLoader');
    root.classList.remove('page-booting');
    root.classList.add('page-ready');
    if (loader) {
      loader.classList.remove('is-visible', 'is-booting');
      loader.setAttribute('aria-hidden', 'true');
    }
    window.dispatchEvent(new CustomEvent('reliacode:page-ready'));
  }

  if (document.readyState === 'complete') revealPage();
  else window.addEventListener('load', revealPage, { once: true });
  window.addEventListener('pageshow', event => {
    if (event.persisted) revealPage();
  });
})();
