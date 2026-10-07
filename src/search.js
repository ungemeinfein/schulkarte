// Adresssuche auf der Karte (Nominatim/OpenStreetMap). Nur auf Enter/Knopf, keine
// Autovervollständigung (Nominatim-Nutzungsregeln). Treffer lassen sich als A oder B setzen.
import L from 'leaflet';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const VIEWBOX = '12.9,52.75,14.1,52.2'; // Berlin + Umland

export function addSearchControl(map, onPick) {
  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-search');
      box.innerHTML = `
        <form role="search">
          <input id="placeSearch" type="search" placeholder="Adresse oder Ort suchen …" aria-label="Adresse oder Ort suchen" autocomplete="off" />
          <button type="submit" aria-label="Suchen">Suchen</button>
        </form>
        <ol class="map-search-results" hidden></ol>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);

      const form = box.querySelector('form');
      const input = box.querySelector('input');
      const list = box.querySelector('ol');
      const close = () => { list.hidden = true; list.replaceChildren(); };

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (q.length < 3) return;
        list.hidden = false;
        list.innerHTML = '<li class="msg">Suche …</li>';
        try {
          const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: 5, countrycodes: 'de', viewbox: VIEWBOX, bounded: 1, 'accept-language': 'de' })}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(res.status);
          const hits = await res.json();
          if (!hits.length) {
            list.innerHTML = '<li class="msg">Nichts gefunden. Straße mit Hausnummer und Ort probieren.</li>';
            return;
          }
          list.replaceChildren(...hits.map((h) => {
            const li = document.createElement('li');
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = h.display_name.split(',').slice(0, 3).join(',');
            name.title = h.display_name;
            const lonLat = [Number(h.lon), Number(h.lat)];
            name.onclick = () => map.setView([lonLat[1], lonLat[0]], 16);
            li.append(name);
            for (const label of ['A', 'B']) {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = `pick pick-${label}`;
              b.textContent = label;
              b.title = `Als ${label} setzen`;
              b.onclick = () => { onPick(label, lonLat); close(); input.value = ''; };
              li.append(b);
            }
            return li;
          }));
        } catch {
          list.innerHTML = '<li class="msg">Suche gerade nicht erreichbar. Punkt per Klick in die Karte setzen.</li>';
        }
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); input.blur(); } });
      return box;
    },
  });
  map.addControl(new Control());
}
