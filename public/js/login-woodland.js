(() => {
  'use strict';
  const page = document.querySelector('.login-page');
  const truck = document.getElementById('deliveryTruck');
  const wheels = [...truck.querySelectorAll('.truck-wheel')].map(element => ({
    element, radius: Number(element.dataset.radius)
  }));
  const pin = document.getElementById('transportPin');
  const parcel = document.getElementById('deliveryParcel');
  const route = document.getElementById('transportRoute');
  const leaves = [...document.querySelectorAll('.reference-leaf')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const duration = 14000;
  const drivingTime = 12000;
  const routeLength = route.getTotalLength();
  let elapsed = 6600;
  let lastFrame = null;
  let frameId = null;

  // A single clock keeps the vehicle, route marker and parcel in step.
  // Artwork is decorative: clicking, typing, hovering or focusing never pauses it.
  function renderScene(time) {
    const cycle = time % duration;
    const progress = Math.min(cycle / drivingTime, 1);
    const point = route.getPointAtLength(routeLength * progress);
    const x = -410 + 760 * progress;
    truck.setAttribute('transform', `translate(${x.toFixed(2)} ${(Math.sin(time / 190) * .25).toFixed(2)})`);
    truck.setAttribute('opacity', cycle < drivingTime ? '1' : '0');
    // Rolling distance / tyre radius gives clockwise rotation as the van moves right.
    // Share the vehicle clock so wheel motion also respects reduced motion and visibility.
    wheels.forEach(({ element, radius }) => {
      const angle = (760 * progress / radius * 180 / Math.PI) % 360;
      element.setAttribute('transform', `rotate(${angle.toFixed(2)})`);
    });
    pin.setAttribute('transform', `translate(${(point.x - 741).toFixed(2)} ${(point.y - 354).toFixed(2)})`);
    pin.setAttribute('opacity', cycle > 13300 ? String((14000 - cycle) / 700) : '1');
    const shakeTime = cycle - 6900;
    if (shakeTime >= 0 && shakeTime < 1250) {
      const amplitude = Math.sin(Math.PI * shakeTime / 1250);
      const shakeX = Math.sin(shakeTime / 49) * 6 * amplitude;
      const shakeY = -Math.abs(Math.sin(shakeTime / 73)) * 10 * amplitude;
      const angle = Math.sin(shakeTime / 59) * 3.6 * amplitude;
      parcel.setAttribute('transform', `translate(${shakeX.toFixed(2)} ${shakeY.toFixed(2)}) rotate(${angle.toFixed(2)} 610 787)`);
    } else parcel.removeAttribute('transform');
    leaves.forEach((leaf, index) => {
      const period = 24000 + index * 1900;
      const initialPhase = 1800 / period;
      const phase = ((time - 6600 + 1800) % period + period) % period / period;
      const dx = (Math.sin(phase * Math.PI * 3) - Math.sin(initialPhase * Math.PI * 3)) * 20;
      const dy = (phase - initialPhase) * 160;
      const angle = (Math.sin(phase * Math.PI * 2) - Math.sin(initialPhase * Math.PI * 2)) * 15;
      leaf.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${angle.toFixed(2)} ${leaf.dataset.leafX} ${leaf.dataset.leafY})`);
      leaf.setAttribute('opacity', String(Math.min(1, phase / .05, (1 - phase) / .2)));
    });
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
    const paused = reducedMotion.matches || document.hidden;
    page.classList.toggle('motion-paused', paused);
    if (!paused) frameId = requestAnimationFrame(animate);
  }
  renderScene(elapsed);
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
