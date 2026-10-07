import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { booleanPointInPolygon, distance, featureCollection, intersect } from '@turf/turf';
import { reachArea, SPEED_KMH } from './isochrones.js';
import { bikeTimes, pointKey, schoolDay, transitTimes } from './routing.js';
import { initTermine, nextEventFor, setHits } from './termine.js';
import { initSplitters } from './splitters.js';
import { addSearchControl } from './search.js';
import './style.css';

const STORAGE_KEY = 'schulkarte.points';
const TABLE_KEY = 'schulkarte.table';
const SOURCE_KEY = 'schulkarte.source';
const TIMES_KEY = 'schulkarte.times';
const COLORS = { A: '#2563eb', B: '#db2777', overlap: '#16a34a' };
const SOURCE_LABEL = {
  approx: 'Näherung: Kreis (Luftlinie)',
  'approx-fallback': 'Näherung: Kreis – API-Abruf fehlgeschlagen',
  valhalla: 'Echt: Valhalla-Radrouting (12 km/h, ruhige Straßen)',
  bvg: 'Echt: BVG-Haltestellen + Fußweg (Di 7:15)',
};

const $ = (id) => document.getElementById(id);

const state = {
  points: loadPoints(), // { A: [lon, lat] | null, B: … }
  armed: null,
  mode: 'transit',
  minutes: 40,
  forms: new Set(['Gymnasium', 'ISS', 'Gemeinschaftsschule', 'Freie Schule']),
  abi: new Set(['ja', 'im Aufbau', 'nein']),
  cost: new Set(['staatlich', 'privat']),
  areas: { A: null, B: null },
  overlap: null,
  source: loadJson(SOURCE_KEY).source === 'real' ? 'real' : 'approx',
  times: loadJson(TIMES_KEY), // { "bike|lon,lat": {times}, "transit|lon,lat": {date, stop, times} }
  table: { sort: 'status', dir: 1, onlyHits: false, ...loadJson(TABLE_KEY) },
};

// ---------- Karte ----------
const map = L.map('map', { zoomControl: true }).setView([52.445, 13.56], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende ' +
    '(<a href="https://www.openstreetmap.org/fixthemap">Karte verbessern</a>) · Routing: ' +
    '<a href="https://valhalla1.openstreetmap.de">Valhalla/FOSSGIS</a>, <a href="https://v6.bvg.transport.rest">transport.rest</a>',
}).addTo(map);

const areaLayer = L.layerGroup().addTo(map);
const schoolLayer = L.layerGroup().addTo(map);
const markers = {};

function pinIcon(label) {
  return L.divIcon({ className: `pin pin-${label}`, html: label, iconSize: [30, 30], iconAnchor: [15, 15] });
}

function placePoint(label, lonLat) {
  state.points[label] = lonLat;
  const latLng = [lonLat[1], lonLat[0]];
  if (markers[label]) {
    markers[label].setLatLng(latLng);
  } else {
    markers[label] = L.marker(latLng, { icon: pinIcon(label), draggable: true, zIndexOffset: 1000 })
      .addTo(map)
      .on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng();
        state.points[label] = [lng, lat];
        savePoints();
        toast(`Ort ${label} verschoben`, label);
        update();
      });
  }
  savePoints();
}

const nextLabel = () => state.armed ?? (!state.points.A ? 'A' : !state.points.B ? 'B' : null);

map.on('click', (e) => {
  const label = nextLabel();
  if (!label) return;
  const moved = Boolean(state.points[label]);
  placePoint(label, [e.latlng.lng, e.latlng.lat]);
  state.armed = null;
  const next = nextLabel();
  toast(`Ort ${label} ${moved ? 'neu ' : ''}gesetzt${next ? ` – jetzt ${next} setzen` : ''}`, label);
  update();
});

addSearchControl(map, (label, lonLat) => {
  const moved = Boolean(state.points[label]);
  placePoint(label, lonLat);
  state.armed = null;
  map.setView([lonLat[1], lonLat[0]], Math.max(map.getZoom(), 14));
  const next = nextLabel();
  toast(`Ort ${label} ${moved ? 'neu ' : ''}gesetzt${next ? ` – jetzt ${next} setzen` : ''}`, label);
  update();
});

// Kurze Rückmeldung oben auf der Karte.
const toastEl = Object.assign(document.createElement('div'), { className: 'map-toast', role: 'status' });
toastEl.setAttribute('aria-live', 'polite');
map.getContainer().append(toastEl);
let toastTimer;
function toast(text, label) {
  toastEl.textContent = text;
  toastEl.dataset.label = label ?? '';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// Fadenkreuz, solange ein Klick in die Karte einen Punkt setzt.
function updatePlacing() {
  const label = nextLabel();
  map.getContainer().classList.toggle('placing', Boolean(label));
  map.getContainer().dataset.placing = label ?? '';
  for (const l of ['A', 'B']) $(`set${l}`).setAttribute('aria-pressed', String(state.armed === l));
}

// ---------- Schulen ----------
function formCategory({ Schule, Schulform }) {
  if (/Waldorf|Montessori|Alternativ|Freie Schule|anthroposoph/i.test(`${Schule} ${Schulform}`)) return 'Freie Schule';
  const schulform = Schulform ?? '';
  if (/Gymnasium/i.test(schulform)) return 'Gymnasium';
  if (/Gemeinschaftsschule/i.test(schulform)) return 'Gemeinschaftsschule';
  if (/Sekundarschule|ISS|Gesamtschule/i.test(schulform)) return 'ISS'; // Brandenburger Gesamtschule ≈ ISS
  return 'Sonstige';
}

// "Abitur vor Ort" aus der CSV: ja | im Aufbau | nein (alles andere: unklar, wird nie ausgefiltert).
function abiCategory(p) {
  const v = (p['Abitur vor Ort'] ?? '').trim().toLowerCase();
  return v === 'ja' ? 'ja' : v === 'im aufbau' ? 'im Aufbau' : v === 'nein' ? 'nein' : 'unklar';
}

function costCategory(p) {
  return /^kostenfrei/i.test(p.Kosten ?? '') || /^staatlich$/i.test(p['Träger'] ?? '') ? 'staatlich' : 'privat';
}

const schools = (await (await fetch(`${import.meta.env.BASE_URL}schulen.geojson`)).json()).features.map((f) => {
  const p = f.properties;
  const school = { p, category: formCategory(p), abi: abiCategory(p), cost: costCategory(p), lonLat: f.geometry.coordinates, hit: false };
  school.marker = L.circleMarker([school.lonLat[1], school.lonLat[0]], { radius: 7, weight: 2 })
    .bindPopup(() => popupHtml(school), { className: 'school-popup', maxWidth: 380, minWidth: 320, autoPanPaddingTopLeft: [20, 70], autoPanPaddingBottomRight: [20, 20] })
    .bindTooltip(p.Schule, { direction: 'top', offset: [0, -6] });
  return school;
});
const byName = new Map(schools.map((s) => [s.p.Schule, s]));
// Freie Fotos von Wikimedia Commons (public/fotos.json, erzeugt mit npm run fotos).
const fotos = await fetch(`${import.meta.env.BASE_URL}fotos.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

function km(school, label) {
  const pt = state.points[label];
  return pt ? distance(pt, school.lonLat, { units: 'kilometers' }) : null;
}

function approxMin(school, label, mode = state.mode) {
  const d = km(school, label);
  return d == null ? null : Math.round((d / SPEED_KMH[mode]) * 60);
}

// Echte Fahrzeit: undefined = noch nicht berechnet, null = keine Verbindung gefunden.
function timeEntry(label, mode) {
  const pt = state.points[label];
  return pt ? state.times[`${mode}|${pointKey(pt)}`] : undefined;
}
function realInfo(school, label, mode) {
  const e = timeEntry(label, mode);
  if (!e || !(school.p.Schule in e.times)) return undefined; // für diese Schule noch nicht berechnet
  return e.times[school.p.Schule];
}
function realMin(school, label, mode = state.mode) {
  const v = realInfo(school, label, mode);
  return v == null ? v : mode === 'bike' ? v : v.min;
}
const setLabels = () => ['A', 'B'].filter((l) => state.points[l]);
const hasRealTimes = (mode = state.mode) => setLabels().length > 0 && setLabels().every((l) => timeEntry(l, mode));
// Beste verfügbare Minuten: echt, sonst Näherung.
function bestMin(school, label, mode = state.mode) {
  const r = realMin(school, label, mode);
  return r === undefined ? approxMin(school, label, mode) : r;
}

function carouselHtml(name) {
  const list = fotos[name];
  if (!list?.length) return '';
  const nav = list.length > 1
    ? `<button type="button" class="car-prev" aria-label="Vorheriges Foto">‹</button>
       <button type="button" class="car-next" aria-label="Nächstes Foto">›</button>
       <span class="car-count">1 / ${list.length}</span>`
    : '';
  return `<figure class="carousel" data-school="${escapeHtml(name)}" data-i="0">
      <div class="car-frame"><img src="${escapeHtml(list[0].thumb)}" alt="${escapeHtml(list[0].title)}" loading="lazy" />${nav}</div>
      <figcaption class="car-credit"></figcaption>
    </figure>`;
}

function showFoto(fig, i) {
  const list = fotos[fig.dataset.school];
  const n = list.length;
  const idx = ((i % n) + n) % n;
  const f = list[idx];
  fig.dataset.i = idx;
  const img = fig.querySelector('img');
  img.src = f.thumb;
  img.alt = f.title;
  const count = fig.querySelector('.car-count');
  if (count) count.textContent = `${idx + 1} / ${n}`;
  const credit = fig.querySelector('.car-credit');
  credit.replaceChildren('Foto: ', f.author, ' · ');
  const lic = Object.assign(document.createElement('a'), { href: f.licenseUrl || f.page, target: '_blank', rel: 'noopener', textContent: f.license || 'Lizenz' });
  const src = Object.assign(document.createElement('a'), { href: f.page, target: '_blank', rel: 'noopener', textContent: 'Wikimedia Commons' });
  credit.append(lic, ' · ', src);
}

map.on('popupopen', (e) => {
  const fig = e.popup.getElement()?.querySelector('.carousel');
  if (!fig) return;
  showFoto(fig, 0);
  fig.querySelector('.car-prev')?.addEventListener('click', () => showFoto(fig, Number(fig.dataset.i) - 1));
  fig.querySelector('.car-next')?.addEventListener('click', () => showFoto(fig, Number(fig.dataset.i) + 1));
  fig.querySelector('img').addEventListener('load', () => e.popup.update(), { once: true });
});

function popupHtml({ p }) {
  const row = (k, v) => (v ? `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>` : '');
  return `${carouselHtml(p.Schule)}<div class="popup-body"><strong>${escapeHtml(p.Schule)}</strong>
    <table class="popup">
      ${row('Schulform', p.Schulform)}
      ${row('Adresse', p.Adresse)}
      ${row('Oberstufe', p['Eigene Oberstufe'])}
      ${row('Termine', p['Tag der offenen Tür'])}
      ${row('Notizen', p.Notizen)}
    </table></div>`;
}

function focusSchool(name) {
  const s = byName.get(name);
  if (!s) return false;
  map.setView(s.marker.getLatLng(), Math.max(map.getZoom(), 14));
  s.marker.addTo(schoolLayer).openPopup();
  return true;
}

// ---------- Berechnung ----------
let generation = 0;

async function update() {
  const gen = ++generation;
  const { mode, minutes } = state;
  const labels = ['A', 'B'].filter((l) => state.points[l]);

  const results = await Promise.all(labels.map((l) => reachArea(state.points[l], mode, minutes, state.source)));
  if (gen !== generation) return; // überholt

  state.areas = { A: null, B: null };
  labels.forEach((l, i) => (state.areas[l] = results[i].feature));
  state.overlap = state.areas.A && state.areas.B
    ? intersect(featureCollection([state.areas.A, state.areas.B]))
    : null;

  const sources = [...new Set(results.map((r) => r.source))];
  $('method').textContent = sources.length
    ? sources.map((s) => SOURCE_LABEL[s]).join(' · ') +
      (sources.some((s) => s.startsWith('approx')) ? ` – ${SPEED_KMH[mode]} km/h` : '')
    : '';
  $('method').classList.toggle('approx', sources.some((s) => s.startsWith('approx')));

  drawAreas();
  renderSchools();
}

// Treffer = in allen gesetzten Bereichen (bei einem Punkt: in dessen Bereich).
function isHit(school) {
  if (hasRealTimes()) {
    return setLabels().every((l) => {
      const m = realMin(school, l);
      return m != null && m <= state.minutes;
    });
  }
  if (state.overlap) return booleanPointInPolygon(school.lonLat, state.overlap);
  if (state.areas.A && state.areas.B) return false; // keine Überlappung
  const only = state.areas.A ?? state.areas.B;
  return only ? booleanPointInPolygon(school.lonLat, only) : false;
}

function drawAreas() {
  areaLayer.clearLayers();
  for (const l of ['A', 'B']) {
    if (!state.areas[l]) continue;
    L.geoJSON(state.areas[l], {
      interactive: false,
      style: { color: COLORS[l], weight: 2, fillOpacity: 0.07, dashArray: '6 4' },
    }).addTo(areaLayer);
  }
  if (state.overlap) {
    L.geoJSON(state.overlap, {
      interactive: false,
      style: { color: COLORS.overlap, weight: 2, fillColor: COLORS.overlap, fillOpacity: 0.22 },
    }).addTo(areaLayer);
  }
}

const anyArea = () => Boolean(state.areas.A || state.areas.B);

function renderSchools() {
  const visible = schools.filter((s) =>
    (state.forms.has(s.category) || s.category === 'Sonstige') &&
    (state.abi.has(s.abi) || s.abi === 'unklar') &&
    state.cost.has(s.cost));
  for (const s of schools) s.hit = anyArea() && isHit(s);
  const hits = visible.filter((s) => s.hit);

  schoolLayer.clearLayers();
  for (const s of visible) {
    const dim = anyArea() && !s.hit;
    s.marker.setStyle({
      color: dim ? '#9ca3af' : '#14532d',
      fillColor: dim ? '#d1d5db' : s.hit ? COLORS.overlap : '#f59e0b',
      fillOpacity: dim ? 0.6 : 0.95,
      radius: s.hit ? 9 : 7,
    });
    s.marker.addTo(schoolLayer);
    if (s.hit) s.marker.bringToFront();
  }

  const both = state.areas.A && state.areas.B;
  $('resultTitle').textContent = !anyArea()
    ? String(visible.length)
    : `${hits.length} von ${visible.length} ${both ? 'erreichbar von A und B' : 'erreichbar von ' + (state.areas.A ? 'A' : 'B')}`;
  $('export').disabled = hits.length === 0;
  $('export').onclick = () => exportCsv(hits);

  $('hint').textContent = state.armed
    ? `Klick in die Karte setzt ${state.armed}.`
    : !state.points.A ? 'Klick in die Karte setzt Wohnort A.'
    : !state.points.B ? 'Klick in die Karte setzt Wohnort B.'
    : 'Marker sind verschiebbar.';

  renderTable(visible);
  renderTimesInfo();
  updatePlacing();
  setHits(anyArea() ? new Set(hits.map((s) => s.p.Schule)) : null);
}

// ---------- Tabelle ----------
const fmtKm = (v) => (v == null ? '' : v.toFixed(1).replace('.', ','));
const fmtMin = (v, real) => (v == null ? '' : real ? String(v) : `≈${v}`);

function demand(s) {
  const places = Number(s.p['Plätze 2026/27']);
  const wishes = Number(s.p['Erstwünsche 2026/27']);
  return places && s.p['Erstwünsche 2026/27'] !== '' ? wishes / places : null;
}

function maxMin(s) {
  if (!(state.points.A && state.points.B)) return null;
  const a = bestMin(s, 'A');
  const b = bestMin(s, 'B');
  return a == null || b == null ? null : Math.max(a, b);
}

function timeColumn(l, mode, label) {
  return {
    key: `${mode}${l}`, label, num: true, cls: `num col-${l}`,
    title: `${mode === 'bike' ? 'Fahrrad' : 'ÖPNV (Ankunft 8:00)'} ab ${l} – echte Zeit, sonst ≈ Näherung`,
    value: (s) => bestMin(s, l, mode),
    html: (s) => {
      const real = realInfo(s, l, mode);
      if (real === undefined) return state.points[l] ? `<span class="approx">${fmtMin(approxMin(s, l, mode))}</span>` : '';
      if (real === null) return '<span class="approx" title="keine Verbindung gefunden">–</span>';
      if (mode === 'bike') return `<strong>${real}</strong>`;
      const tip = real.lines.length
        ? `${real.lines.join(' → ')} · ${real.transfers} Umstieg(e) · ab ${real.stop} (+${real.walkMin} min Fußweg)`
        : `zu Fuß (${real.walkMin} min, geschätzt)`;
      return `<strong title="${escapeHtml(tip)}">${real.min}</strong><span class="tr">${real.transfers ? `${real.transfers}×` : ''}</span>`;
    },
  };
}
const plz = (s) => s.p.Adresse.match(/\b\d{5}\b/)?.[0] ?? '';

const COLUMNS = [
  { key: 'status', label: '', title: 'In der Überlappung',
    value: (s) => (anyArea() ? (s.hit ? 0 : 1) : 0),
    html: (s) => (anyArea() ? `<span class="dot ${s.hit ? 'hit' : 'dim'}"></span>` : '') },
  { key: 'name', label: 'Schule', value: (s) => s.p.Schule, text: (s) => s.p.Schule, cls: 'name' },
  { key: 'form', label: 'Form', value: (s) => s.category,
    html: (s) => `<span class="badge b-${s.category}">${s.category}</span>` },
  { key: 'cost', label: 'Träger', value: (s) => s.cost,
    html: (s) => `<span class="badge c-${s.cost}">${s.cost === 'privat' ? 'privat €' : 'staatlich'}</span>` },
  { key: 'abi', label: 'Abitur', title: 'Abitur an dieser Schule möglich',
    value: (s) => ({ ja: 0, 'im Aufbau': 1, nein: 2 })[s.abi] ?? null,
    html: (s) => `<span class="badge abi-${s.abi.replace(' ', '-')}">${s.abi}</span>` },
  { key: 'bezirk', label: 'Bezirk', value: (s) => s.p.Bezirk || null,
    html: (s) => `<span class="${s.p.Bezirk === 'Treptow-Köpenick' ? '' : 'other-district'}" title="${s.p.Bezirk === 'Treptow-Köpenick' ? 'Eigener Bezirk: auch als Zweit-/Drittwunsch realistisch' : 'Anderer Bezirk: bei Zweit-/Drittwunsch haben Kinder aus dem Bezirk Vorrang'}">${escapeHtml(s.p.Bezirk)}</span>` },
  { key: 'nachfrage', label: 'Nachfrage', num: true,
    title: 'Erstwünsche pro Platz 2026/27 (Drs. 19/26317). Über 100 %: Schule vergibt keine Plätze an Zweit-/Drittwünsche',
    value: demand,
    html: (s) => {
      const d = demand(s);
      if (d == null) return '';
      const cls = d > 1 ? 'over' : d >= 0.9 ? 'tight' : 'free';
      const tip = `2026/27: ${s.p['Erstwünsche 2026/27']} Erstwünsche auf ${s.p['Plätze 2026/27']} Plätze${s.p['Nachfrage Hinweis'] ? ` – ${s.p['Nachfrage Hinweis']}` : ''}`;
      return `<span class="demand ${cls}" title="${escapeHtml(tip)}">${Math.round(d * 100)} %${s.p['Nachfrage Hinweis'] ? '*' : ''}</span>`;
    } },
  { key: 'plz', label: 'PLZ', value: plz, text: plz },
  { key: 'oberstufe', label: 'Oberstufe (Details)', value: (s) => s.p['Eigene Oberstufe'] || '',
    text: (s) => s.p['Eigene Oberstufe'] || '' , cls: 'clip' },
  ...['A', 'B'].flatMap((l) => [
    { key: `km${l}`, label: `${l} km`, num: true, title: 'Luftlinie', value: (s) => km(s, l), text: (s) => fmtKm(km(s, l)), cls: `num col-${l}` },
    timeColumn(l, 'bike', `${l} Rad`),
    timeColumn(l, 'transit', `${l} ÖPNV`),
  ]),
  { key: 'max', label: 'max min', num: true, title: 'Längerer der beiden Wege im gewählten Modus',
    value: (s) => maxMin(s),
    text: (s) => fmtMin(maxMin(s), setLabels().every((l) => realMin(s, l) != null)), cls: 'num' },
  { key: 'next', label: 'Nächster Termin', value: (s) => nextEventFor(s.p.Schule)?.start ?? null,
    text: (s) => {
      const t = nextEventFor(s.p.Schule);
      if (!t) return '';
      const [, m, d] = t.start.slice(0, 10).split('-');
      return `${d}.${m}. ${t.titel}`;
    }, cls: 'clip' },
  { key: 'kosten', label: 'Kosten', value: (s) => s.p.Kosten || '', text: (s) => s.p.Kosten || '', cls: 'clip' },
];

function compare(a, b, col) {
  const va = col.value(a);
  const vb = col.value(b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1; // leere Werte immer ans Ende
  if (vb == null) return -1;
  const r = col.num ? va - vb : String(va).localeCompare(String(vb), 'de');
  return r * state.table.dir;
}

function renderTable(visible) {
  const { sort, dir, onlyHits } = state.table;
  const col = COLUMNS.find((c) => c.key === sort) ?? COLUMNS[0];
  const fallback = COLUMNS.find((c) => c.key === (anyArea() ? 'max' : 'name'));
  const rows = visible
    .filter((s) => !onlyHits || !anyArea() || s.hit)
    .sort((a, b) => compare(a, b, col) || compare(a, b, fallback) * state.table.dir || a.p.Schule.localeCompare(b.p.Schule));

  const head = document.createElement('tr');
  for (const c of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.className = [c.cls?.includes('num') ? 'num' : '', c.key === sort ? (dir > 0 ? 'asc' : 'desc') : ''].join(' ');
    if (c.title) th.title = c.title;
    th.onclick = () => {
      state.table.dir = state.table.sort === c.key ? -state.table.dir : 1;
      state.table.sort = c.key;
      saveJson(TABLE_KEY, state.table);
      renderTable(visible);
    };
    head.append(th);
  }
  $('schoolTable').tHead.replaceChildren(head);

  const body = $('schoolTable').tBodies[0];
  body.replaceChildren(...rows.map((s) => {
    const tr = document.createElement('tr');
    tr.className = anyArea() ? (s.hit ? 'hit' : 'dim') : '';
    for (const c of COLUMNS) {
      const td = document.createElement('td');
      if (c.cls) td.className = c.cls;
      if (c.html) td.innerHTML = c.html(s);
      else td.textContent = c.text(s);
      if (c.cls?.includes('clip')) td.title = td.textContent;
      tr.append(td);
    }
    tr.onclick = () => focusSchool(s.p.Schule);
    return tr;
  }));
}

function exportCsv(hits) {
  const cols = ['Schule', 'Schulform', 'Kosten', 'Abitur vor Ort', 'Eigene Oberstufe', 'Adresse', 'Tag der offenen Tür'];
  const header = [...cols, 'Luftlinie A (km)', 'Luftlinie B (km)', 'Modus', 'Minuten'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = hits.map((s) =>
    [...cols.map((c) => s.p[c]), km(s, 'A')?.toFixed(1), km(s, 'B')?.toFixed(1), state.mode, state.minutes]
      .map(q).join(','));
  const blob = new Blob(['﻿' + [header.map(q).join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `schulen_treffer_${state.mode}_${state.minutes}min.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Bedienelemente ----------
for (const l of ['A', 'B']) {
  $(`set${l}`).onclick = () => {
    state.armed = state.armed === l ? null : l;
    if (state.armed) toast(`Klick in die Karte setzt ${l}`, l);
    renderSchools();
  };
}
document.querySelectorAll('input[name=mode]').forEach((el) =>
  el.addEventListener('change', () => { state.mode = el.value; update(); }));

let sliderTimer;
$('minutes').addEventListener('input', (e) => {
  state.minutes = Number(e.target.value);
  $('minLabel').textContent = state.minutes;
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(update, 150);
});

for (const [selector, set] of [
  ['#formFilter input', state.forms],
  ['#abiFilter input', state.abi],
  ['#costFilter input', state.cost],
]) {
  document.querySelectorAll(selector).forEach((el) =>
    el.addEventListener('change', () => {
      el.checked ? set.add(el.value) : set.delete(el.value);
      renderSchools();
    }));
}

document.querySelectorAll('input[name=source]').forEach((el) => {
  el.checked = el.value === state.source;
  el.addEventListener('change', () => {
    state.source = el.value;
    saveJson(SOURCE_KEY, { source: state.source });
    update();
  });
});

$('computeTimes').onclick = async () => {
  const labels = setLabels();
  if (!labels.length) return;
  const btn = $('computeTimes');
  btn.disabled = true;
  const status = (t) => ($('timesStatus').textContent = t);
  try {
    for (const l of labels) {
      const key = pointKey(state.points[l]);
      // Nur fehlende Schulen nachrechnen; sind alle da, alles neu berechnen.
      const todo = (mode) => {
        const e = state.times[`${mode}|${key}`];
        const missing = e ? schools.filter((s) => !(s.p.Schule in e.times)) : schools;
        return missing.length ? missing : schools;
      };
      const merge = (mode, res) => {
        const prev = state.times[`${mode}|${key}`];
        const full = todo(mode).length === schools.length;
        state.times[`${mode}|${key}`] = { ...(full ? {} : prev), ...res, times: { ...(full ? {} : prev?.times), ...res.times } };
      };
      status(`Fahrrad ab ${l} …`);
      merge('bike', { times: await bikeTimes(state.points[l], todo('bike')) });
      merge('transit', await transitTimes(state.points[l], todo('transit'), (i, n) => status(`ÖPNV ab ${l}: ${i}/${n}`)));
      saveJson(TIMES_KEY, state.times);
      renderSchools();
    }
    status(`Fertig (ÖPNV: Di ${schoolDay().date.split('-').reverse().join('.')}, Ankunft 8:00).`);
  } catch (err) {
    console.error(err);
    status(`Fehler: ${err.message}. Bereits Berechnetes bleibt erhalten.`);
  } finally {
    btn.disabled = false;
    renderTimesInfo();
  }
};

function renderTimesInfo() {
  const labels = setLabels();
  const complete = (l, mode) => timeEntry(l, mode) && schools.every((s) => s.p.Schule in timeEntry(l, mode).times);
  const missing = labels.filter((l) => !complete(l, 'bike') || !complete(l, 'transit'));
  const partial = missing.some((l) => timeEntry(l, 'bike') || timeEntry(l, 'transit'));
  $('computeTimes').textContent = !missing.length ? 'Fahrzeiten neu berechnen' : partial ? 'Fehlende Fahrzeiten ergänzen' : 'Echte Fahrzeiten berechnen';
  $('computeTimes').disabled = !labels.length;
  const stops = labels.map((l) => timeEntry(l, 'transit') && `${l}: ab ${timeEntry(l, 'transit').stop}`).filter(Boolean);
  if (!$('timesStatus').textContent || !missing.length) {
    $('timesStatus').textContent = missing.length
      ? (labels.length ? `Für ${missing.join(' & ')} ${partial ? 'unvollständig' : 'noch nicht berechnet'}.` : 'Erst A/B setzen.')
      : `Echte Zeiten vorhanden. ${stops.join(' · ')}`;
  }
}

$('privacyToggle').onclick = () => {
  const note = $('privacyNote');
  note.hidden = !note.hidden;
  $('privacyToggle').setAttribute('aria-expanded', String(!note.hidden));
};

$('tableOnlyHits').checked = state.table.onlyHits;
$('tableOnlyHits').addEventListener('change', (e) => {
  state.table.onlyHits = e.target.checked;
  saveJson(TABLE_KEY, state.table);
  renderSchools();
});

// ---------- localStorage (nur in diesem Browser) ----------
function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* egal */ }
}
function loadPoints() {
  return { A: null, B: null, ...loadJson(STORAGE_KEY) };
}
function savePoints() {
  saveJson(STORAGE_KEY, state.points);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

initSplitters(() => map.invalidateSize());

// ---------- Tabs (schmale Ansicht) ----------
const TAB_KEY = 'schulkarte.tab';
function showTab(id) {
  document.body.dataset.tab = id;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  saveJson(TAB_KEY, { tab: id });
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
showTab(loadJson(TAB_KEY).tab ?? 'sidebar');
window.matchMedia('(max-width: 1099px)').addEventListener('change', () => setTimeout(() => map.invalidateSize(), 50));
initTermine({ focusSchool, hasSchool: (n) => byName.has(n) });
for (const l of ['A', 'B']) if (state.points[l]) placePoint(l, state.points[l]);
renderSchools(); // sofort zeigen, Flächen kommen danach
update();
