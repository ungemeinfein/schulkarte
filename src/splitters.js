// Ziehbare Trenner zwischen den Bereichen. Größen landen als CSS-Variablen auf <body>
// und werden im localStorage gemerkt. Doppelklick setzt auf den Standardwert zurück.
const STORAGE_KEY = 'schulkarte.layout';
const LIMITS = { '--left': [200, 600], '--right': [240, 700], '--bottom': [80, 900] };

export function initSplitters(onResize) {
  const sizes = load();
  const apply = (name, px) => {
    const [min, max] = LIMITS[name];
    const v = Math.round(Math.min(max, Math.max(min, px)));
    document.body.style.setProperty(name, `${v}px`);
    sizes[name] = v;
  };
  for (const [name, px] of Object.entries(sizes)) if (LIMITS[name]) apply(name, px);

  let frame = 0;
  const notify = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onResize);
  };

  for (const el of document.querySelectorAll('.splitter')) {
    const name = el.dataset.var;
    const dir = Number(el.dataset.dir);
    const vertical = el.classList.contains('v');

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = vertical ? e.clientX : e.clientY;
      const startSize = parseFloat(getComputedStyle(document.body).getPropertyValue(name)) || Number(el.dataset.default);
      document.body.classList.add('resizing', vertical ? 'resizing-v' : 'resizing-h');

      const move = (ev) => {
        apply(name, startSize + dir * ((vertical ? ev.clientX : ev.clientY) - start));
        notify();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing', 'resizing-v', 'resizing-h');
        save(sizes);
        notify();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });

    el.addEventListener('dblclick', () => {
      apply(name, Number(el.dataset.default));
      save(sizes);
      notify();
    });
  }
  window.addEventListener('resize', notify);
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); } catch { return {}; }
}
function save(sizes) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes)); } catch { /* egal */ }
}
