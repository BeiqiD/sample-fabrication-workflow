const CARD_SELECTOR = ".sample-details-card";
const EDIT_FORM_SELECTOR = ".detail-form";
const DESCRIPTION_SELECTOR = 'textarea[name="description"]';
const MIN_DESCRIPTION_HEIGHT = 48;

const observers = new WeakMap<HTMLElement, MutationObserver>();

function clearSizing(card: HTMLElement) {
  card.style.removeProperty("height");
  delete card.dataset.sampleDetailsViewHeight;
  delete card.dataset.sampleDetailsEditHeightLocked;
  observers.get(card)?.disconnect();
  observers.delete(card);
}

function fitDescription(card: HTMLElement) {
  const baseline = Number(card.dataset.sampleDetailsViewHeight);
  const form = card.querySelector<HTMLFormElement>(EDIT_FORM_SELECTOR);
  const description = card.querySelector<HTMLTextAreaElement>(DESCRIPTION_SELECTOR);
  if (!form || !description || !Number.isFinite(baseline) || baseline <= 0) return;

  card.dataset.sampleDetailsEditHeightLocked = "true";
  card.style.height = `${baseline}px`;

  description.style.height = `${MIN_DESCRIPTION_HEIGHT}px`;
  const cardRect = card.getBoundingClientRect();
  const formRect = form.getBoundingClientRect();
  const paddingBottom = Number.parseFloat(getComputedStyle(card).paddingBottom) || 0;
  const remaining = Math.max(0, cardRect.bottom - paddingBottom - formRect.bottom);
  description.style.height = `${MIN_DESCRIPTION_HEIGHT + remaining}px`;
}

function watchEdit(card: HTMLElement) {
  observers.get(card)?.disconnect();
  const observer = new MutationObserver(() => {
    if (!card.querySelector(EDIT_FORM_SELECTOR)) {
      clearSizing(card);
      return;
    }
    fitDescription(card);
  });
  observer.observe(card, { childList: true, subtree: true });
  observers.set(card, observer);
}

export function installSampleDetailsEditSizing() {
  function onClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const toggle = target.closest<HTMLElement>(`${CARD_SELECTOR} > .card-title-row .text-button`);
    if (!toggle) return;
    const card = toggle.closest<HTMLElement>(CARD_SELECTOR);
    if (!card) return;

    if (card.querySelector(EDIT_FORM_SELECTOR)) return;

    card.dataset.sampleDetailsViewHeight = String(card.getBoundingClientRect().height);
    requestAnimationFrame(() => {
      if (!card.isConnected || !card.querySelector(EDIT_FORM_SELECTOR)) return;
      fitDescription(card);
      watchEdit(card);
    });
  }

  function onResize() {
    document.querySelectorAll<HTMLElement>(`${CARD_SELECTOR}[data-sample-details-edit-height-locked="true"]`).forEach(fitDescription);
  }

  document.addEventListener("click", onClick, true);
  window.addEventListener("resize", onResize);
}
