// Presentation only: viewport, orientation and popovers never alter the game session.
const root = document.documentElement;
const app = document.querySelector('#app');
const dialog = document.querySelector('#info-dialog');
const guide = document.querySelector('#rotation-guide');
const portrait = matchMedia('(orientation: portrait) and (max-width: 900px)');
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
  markScrollableKnowledge();
})).observe(app, { childList: true });
document.fonts.ready.then(markScrollableKnowledge);

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
  if (!menu || ['sound', 'fullscreen'].includes(button.dataset.action)) return;
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
