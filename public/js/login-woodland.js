(() => {
  'use strict';
  const page = document.querySelector('.login-page');
  const scene = document.getElementById('sceneControl');
  const truck = document.getElementById('deliveryTruck');
  const pin = document.getElementById('transportPin');
  const parcel = document.getElementById('deliveryParcel');
  const route = document.getElementById('transportRoute');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const duration = 12000;
  const drivingTime = 10000;
  const routeLength = route.getTotalLength();
  let elapsed = 4500;
  let lastFrame = null;
  let frameId = null;
  let manuallyPaused = false;

  // One clock controls each vehicle, the route marker and one parcel shake per pass.
  function renderScene(time) {
    const cycle = time % duration;
    const progress = Math.min(cycle / drivingTime, 1);
    const point = route.getPointAtLength(routeLength * progress);
    const x = 70 + 660 * progress;
    truck.setAttribute('transform', `translate(${x.toFixed(2)} ${(Math.sin(time / 160) * .45).toFixed(2)})`);
    truck.setAttribute('opacity', cycle < drivingTime ? '1' : '0');
    pin.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
    pin.setAttribute('opacity', cycle > 11300 ? String((12000 - cycle) / 700) : '1');
    const shakeTime = cycle - 5400;
    if (shakeTime >= 0 && shakeTime < 1000) {
      const amplitude = Math.sin(Math.PI * shakeTime / 1000);
      const shakeX = Math.sin(shakeTime / 37) * 3.2 * amplitude;
      const shakeY = -Math.abs(Math.sin(shakeTime / 61)) * 5.2 * amplitude;
      const angle = Math.sin(shakeTime / 49) * 2.2 * amplitude;
      parcel.setAttribute('transform', `translate(${shakeX.toFixed(2)} ${shakeY.toFixed(2)}) rotate(${angle.toFixed(2)} 415 731)`);
    } else {
      parcel.removeAttribute('transform');
    }
  }
  function animate(now) {
    if (lastFrame !== null) elapsed += Math.min(now - lastFrame, 80);
    lastFrame = now;
    renderScene(elapsed);
    frameId = requestAnimationFrame(animate);
  }
  function syncMotion() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    lastFrame = null;
    const paused = manuallyPaused || reducedMotion.matches || document.hidden;
    page.classList.toggle('motion-paused', paused);
    scene.setAttribute('aria-pressed', String(paused));
    scene.setAttribute('aria-label', reducedMotion.matches ? '查看下一段运输场景，已减少动态效果' : paused ? '播放运输与自然动画' : '暂停运输与自然动画');
    if (!paused) frameId = requestAnimationFrame(animate);
  }
  renderScene(elapsed);
  scene.addEventListener('click', () => {
    if (reducedMotion.matches) {
      // Keep the system's reduced-motion choice, but permit a single scene step.
      elapsed += 2400;
      renderScene(elapsed);
      return;
    }
    manuallyPaused = !manuallyPaused;
    syncMotion();
  });
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);
  window.addEventListener('pagehide', () => { if (frameId !== null) cancelAnimationFrame(frameId); });
  window.addEventListener('pageshow', syncMotion);
  syncMotion();

  const username = document.getElementById('loginUsername');
  const password = document.getElementById('loginPassword');
  document.querySelector('.brand-title').addEventListener('click', event => {
    event.preventDefault();
    username.focus();
  });
  document.getElementById('usernameNote').addEventListener('click', () => username.focus());
  document.getElementById('passwordNote').addEventListener('click', () => password.focus());
  document.getElementById('loginStatus').addEventListener('click', () => {
    (username.value.trim() ? password : username).focus();
  });

  const help = document.getElementById('loginHelp');
  const dialog = document.getElementById('helpDialog');
  const close = document.getElementById('closeHelp');
  let focusAfterHelp = help;
  help.addEventListener('click', () => {
    dialog.showModal();
    help.setAttribute('aria-expanded', 'true');
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    help.setAttribute('aria-expanded', 'false');
    focusAfterHelp.focus();
    focusAfterHelp = help;
  });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  document.getElementById('backToAccount').addEventListener('click', () => {
    focusAfterHelp = username;
    dialog.close();
  });
})();
