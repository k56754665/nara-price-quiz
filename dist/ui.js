// Presentation only: viewport, orientation and popovers never alter the game session.
const root = document.documentElement;
const app = document.querySelector('#app');
const dialog = document.querySelector('#info-dialog');
const guide = document.querySelector('#rotation-guide');
const portrait = matchMedia('(orientation: portrait) and (max-width: 900px)');
// Rasterize this animated 9-slice at its layout size before its outer group
// scales. Chromium can otherwise reveal subpixel gaps between border-image tiles.
const bubbleArt = new Image();
bubbleArt.src = new URL('./assets/designer/bubble-box.png', import.meta.url).href;
const bubbleSurfaces = new Set();
const bubbleResize = new ResizeObserver(entries => { for (const entry of entries) paintBubbleSurface(entry.target); });
const hintMeasure = document.createElement('canvas').getContext('2d');
function fitHintLabel() {
  const label = document.querySelector('.art-hint-word');
  if (!label || !hintMeasure) return;
  label.style.removeProperty('font-size');
  const style = getComputedStyle(label), size = parseFloat(style.fontSize);
  hintMeasure.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
  const width = parseFloat(getComputedStyle(label.parentElement).width);
  // Keep the existing UP! spacing as the reference for both directions.
  const padding = Math.max(8, (width - hintMeasure.measureText('UP!').width) / 2);
  const available = Math.max(1, width - padding * 2);
  const textWidth = hintMeasure.measureText(label.textContent.trim()).width;
  label.style.setProperty('--hint-padding-inline', `${padding}px`);
  label.style.fontSize = `${size * Math.min(1, available / Math.max(1, textWidth))}px`;
}
function paintBubbleSurface(surface) {
  if (!surface.isConnected || !bubbleArt.complete || !bubbleArt.naturalWidth) return;
  const style = getComputedStyle(surface);
  const ratio = devicePixelRatio || 1;
  const width = Math.round(parseFloat(style.width) * ratio);
  const height = Math.round(parseFloat(style.height) * ratio);
  if (!width || !height) return;
  let canvas = surface.querySelector('.art-bubble-texture');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'art-bubble-texture';
    canvas.setAttribute('aria-hidden', 'true');
    surface.prepend(canvas);
  }
  if (canvas.width === width && canvas.height === height && canvas.dataset.ratio === String(ratio) && surface.dataset.flattened) return;
  canvas.width = width; canvas.height = height;
  canvas.dataset.ratio = String(ratio);
  const context = canvas.getContext('2d');
  if (!context) return;
  const sourceCorner = parseFloat(style.getPropertyValue('--bubble-source-slice')) || 200;
  const corner = Math.min(Math.round((parseFloat(style.getPropertyValue('--bubble-corner')) || 20) * ratio), Math.floor(width / 2), Math.floor(height / 2));
  const sx = [0, sourceCorner, bubbleArt.naturalWidth - sourceCorner, bubbleArt.naturalWidth];
  const sy = [0, sourceCorner, bubbleArt.naturalHeight - sourceCorner, bubbleArt.naturalHeight];
  const dx = [0, corner, width - corner, width], dy = [0, corner, height - corner, height];
  context.imageSmoothingQuality = 'high';
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    context.drawImage(bubbleArt, sx[column], sy[row], sx[column + 1] - sx[column], sy[row + 1] - sy[row], dx[column], dy[row], dx[column + 1] - dx[column], dy[row + 1] - dy[row]);
  }
  surface.dataset.flattened = 'true';
}
function syncBubbleSurfaces() {
  fitHintLabel();
  for (const surface of bubbleSurfaces) if (!surface.isConnected) { bubbleResize.unobserve(surface); bubbleSurfaces.delete(surface); }
  for (const surface of document.querySelectorAll('.art-reveal-total-surface, .art-hint > .art-bubble-body')) {
    if (!bubbleSurfaces.has(surface)) { bubbleSurfaces.add(surface); bubbleResize.observe(surface); }
    paintBubbleSurface(surface);
  }
}
bubbleArt.decode().then(syncBubbleSurfaces).catch(() => {});
let previousFocus;
let restoreModal = false;
function syncStageLayout() {
  // Native dialogs are outside the stage's container query. Mirror its actual
  // fitted width (including safe-area insets) for their type/spacing tokens.
  const stage = document.querySelector('.art-stage, .art-title-stage, .art-reveal-stage, .art-result-stage');
  const width = stage?.getBoundingClientRect().width || Math.min(root.clientWidth, innerHeight * 16 / 9);
  root.dataset.stageLayout = width <= 900 ? 'compact' : 'desktop';
}
function markScrollableKnowledge() {
  document.querySelectorAll('.art-reveal-info .inline-knowledge').forEach(card => {
    card.dataset.scrollable = String(card.scrollHeight > card.clientHeight + 1);
    card.tabIndex = 0;
  });
}
function updateViewport() {
  // Layout viewport stays stable while a phone's software keyboard is open.
  root.style.setProperty('--viewport-width', `${root.clientWidth}px`);
  root.style.setProperty('--viewport-height', `${window.innerHeight}px`);
  syncStageLayout();
  syncBubbleSurfaces();
  const rotate = portrait.matches;
  if (rotate && !app.inert) {
    previousFocus = document.activeElement;
    document.activeElement?.blur();
  }
  app.inert = rotate;
  guide.hidden = !rotate;
  root.classList.toggle('needs-rotation', rotate);
  // Release native modal inertness so the rotation message stays accessible.
  if (rotate && dialog.open) {
    dialog.dataset.rotationClosing = 'true';
    dialog.close();
    restoreModal = true;
  } else if (!rotate && restoreModal) {
    restoreModal = false;
    dialog.showModal();
  }
  requestAnimationFrame(markScrollableKnowledge);
  if (!rotate && previousFocus) {
    if (previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
}
window.addEventListener('resize', updateViewport);
portrait.addEventListener('change', updateViewport);
updateViewport();
new MutationObserver(() => requestAnimationFrame(() => {
  syncStageLayout();
  syncBubbleSurfaces();
  markScrollableKnowledge();
})).observe(app, { childList: true });
app.addEventListener('game-rendered', syncBubbleSurfaces);
document.fonts.ready.then(() => { fitHintLabel(); markScrollableKnowledge(); });

const popovers = '.art-popover, .art-reveal-menu';
document.addEventListener('toggle', event => {
  if (!event.target.matches?.(popovers) || !event.target.open) return;
  document.querySelectorAll(`${popovers}`).forEach(other => {
    if (other !== event.target) other.open = false;
  });
}, true);
document.addEventListener('pointerdown', event => {
  document.querySelectorAll(`${popovers}`).forEach(popover => {
    if (popover.open && !popover.contains(event.target)) popover.open = false;
  });
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  const menu = button?.closest('.art-menu-content')?.closest('details');
  if (!menu || ['sound', 'music', 'fullscreen'].includes(button.dataset.action)) return;
  menu.open = false;
  menu.querySelector('summary')?.focus({ preventScroll: true });
}, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || dialog.open) return;
  document.querySelectorAll(`${popovers}`).forEach(popover => {
    if (popover.open) { popover.open = false; popover.querySelector('summary')?.focus(); }
  });
});
// Status messages must also be visible above a native modal dialog.
const toast = document.querySelector('#toast');
const modalStatus = document.createElement('div');
modalStatus.className = 'dialog-status';
modalStatus.setAttribute('role', 'status');
new MutationObserver(() => {
  if (!dialog.open || !toast.classList.contains('show')) { modalStatus.remove(); return; }
  modalStatus.textContent = toast.textContent;
  dialog.append(modalStatus);
}).observe(toast, { attributes: true, childList: true });
