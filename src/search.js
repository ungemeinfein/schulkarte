// Adresssuche auf der Karte mit Ergebnissen beim Tippen.
// Photon (komoot, OpenStreetMap-Daten) ist für Suche-beim-Tippen gedacht – anders als Nominatim,
// dessen Nutzungsregeln Autovervollständigung verbieten. Treffer lassen sich als A oder B setzen.
import L from 'leaflet';

const PHOTON = 'https://photon.komoot.io/api/';
const BBOX = '12.9,52.2,14.1,52.75'; // Berlin + Umland (minLon,minLat,maxLon,maxLat)
const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

function label(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const main = p.name && p.name !== street ? p.name : street || p.name || '';
  const place = [p.postcode, p.district || p.city || p.county].filter(Boolean).join(' ');
  return {
    title: main || place,
    sub: [main && street && main !== street ? street : '', place].filter(Boolean).join(', '),
  };
}

export function addSearchControl(map, onPick) {
  let api = { open() {} };
  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-search collapsed');
      box.innerHTML = `
        <button type="button" class="map-search-toggle" aria-label="Adresse suchen" title="Adresse suchen" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
        <form role="search">
          <input id="placeSearch" type="search" placeholder="Adresse oder Ort suchen …" aria-label="Adresse oder Ort suchen" autocomplete="off" />
        </form>
        <ol class="map-search-results" hidden aria-live="polite"></ol>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);

      const form = box.querySelector('form');
      const input = box.querySelector('input');
      const list = box.querySelector('ol');
      const toggle = box.querySelector('.map-search-toggle');
      let timer;
      let controller;
      let lastQuery = '';

      const close = () => { list.hidden = true; list.replaceChildren(); lastQuery = ''; };
      const setOpen = (open) => {
        box.classList.toggle('collapsed', !open);
        toggle.setAttribute('aria-expanded', String(open));
        if (open) input.focus();
        else { clearTimeout(timer); controller?.abort(); close(); input.value = ''; }
      };
      toggle.addEventListener('click', () => setOpen(box.classList.contains('collapsed')));
      api = { open: (l) => { setOpen(true); input.placeholder = `Adresse für Ort ${l} suchen …`; } };

      const message = (text) => {
        list.hidden = false;
        list.replaceChildren(Object.assign(document.createElement('li'), { className: 'msg', textContent: text }));
      };

      async function search(q) {
        if (q === lastQuery) return;
        lastQuery = q;
        controller?.abort();
        controller = new AbortController();
        // Bewusst ohne Kartenmitte als Ortsbezug: die könnte in der Nähe der Wohnorte liegen.
        const url = `${PHOTON}?${new URLSearchParams({ q, lang: 'de', limit: 6, bbox: BBOX })}`;
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(res.status);
          const { features = [] } = await res.json();
          if (input.value.trim() !== q) return; // inzwischen weitergetippt
          if (!features.length) return message('Nichts gefunden. Straße mit Hausnummer probieren.');
          // Doppelte Treffer (gleicher Name und gleiche Adresse) nur einmal zeigen.
          const seen = new Set();
          const unique = features.filter((f) => {
            const { title, sub } = label(f.properties);
            const key = `${title}|${sub}`;
            return seen.has(key) ? false : seen.add(key);
          });
          list.hidden = false;
          list.replaceChildren(...unique.map((f) => {
            const lonLat = f.geometry.coordinates;
            const { title, sub } = label(f.properties);
            const li = document.createElement('li');
            const name = Object.assign(document.createElement('button'), { type: 'button', className: 'name' });
            name.append(Object.assign(document.createElement('span'), { className: 'title', textContent: title }));
            if (sub) name.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: sub }));
            name.title = 'Auf der Karte zeigen';
            name.onclick = () => map.setView([lonLat[1], lonLat[0]], 16);
            li.append(name);
            for (const l of ['A', 'B']) {
              const b = Object.assign(document.createElement('button'), { type: 'button', className: `pick pick-${l}`, textContent: l, title: `Als Ort ${l} setzen` });
              b.setAttribute('aria-label', `${title}${sub ? `, ${sub}` : ''} als Ort ${l} setzen`);
              b.onclick = () => { onPick(l, lonLat); setOpen(false); };
              li.append(b);
            }
            return li;
          }));
        } catch (err) {
          if (err.name === 'AbortError') return;
          lastQuery = '';
          message('Suche gerade nicht erreichbar. Punkt per Klick in die Karte setzen.');
        }
      }

      input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < MIN_CHARS) { controller?.abort(); close(); return; }
        timer = setTimeout(() => search(q), DEBOUNCE_MS);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length >= MIN_CHARS) { lastQuery = ''; search(q); }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { setOpen(false); toggle.focus(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button')?.focus(); }
      });
      // Pfeiltasten in der Ergebnisliste
      list.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
        e.preventDefault();
        const items = [...list.querySelectorAll('button.name')];
        const i = items.indexOf(document.activeElement.closest('li')?.querySelector('button.name'));
        const next = e.key === 'ArrowDown' ? items[i + 1] : items[i - 1];
        (next ?? (e.key === 'ArrowUp' ? input : null))?.focus();
      });
      return box;
    },
  });
  map.addControl(new Control());
  return { open: (l) => api.open(l) };
}
