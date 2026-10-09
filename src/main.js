import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { booleanPointInPolygon, distance, featureCollection, intersect } from '@turf/turf';
import { reachArea, SPEED_KMH } from './isochrones.js';
import { bikeRoute, bikeRoutes, bikeTimes, pointKey, prefetchAreas, schoolDay, transitRoute, transitTimes } from './routing.js';
import { initTermine, nextEventFor, setFavs, setHits } from './termine.js';
import { initSplitters } from './splitters.js';
import { addSearchControl } from './search.js';
import { escapeHtml, safeUrl } from './util.js';
import './style.css';

const STORAGE_KEY = 'schulkarte.points';
const TABLE_KEY = 'schulkarte.table.v2';
const SOURCE_KEY = 'schulkarte.source';
const TIMES_KEY = 'schulkarte.times';
const ROUTES_KEY = 'schulkarte.routes';
const FAV_KEY = 'schulkarte.favoriten';
const COLORS = { A: '#2563eb', B: '#be185d', overlap: '#16a34a' };
const MODE_LABEL = { bike: 'Rad', transit: 'ÖPNV' };
const SOURCE_LABEL = {
  approx: 'Grobe Kreise nach Luftlinie',
  'approx-fallback': 'Genaue Bereiche gerade nicht abrufbar – die Karte zeigt grobe Kreise.',
  valhalla: 'Rad über ruhige Straßen, ca. 12 km/h',
  bvg: 'ÖPNV ab der nächsten Haltestelle, inkl. Fußweg',
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
  gt: new Set(['gebunden', 'teilgebunden', 'offen', 'Halbtag']),
  areas: { A: null, B: null },
  overlap: null,
  source: loadJson(SOURCE_KEY).source === 'real' ? 'real' : 'approx',
  routes: loadJson(ROUTES_KEY), // { "transit|lon,lat": { [Schule]: legs } } – Linien für die Hover-Anzeige
  times: loadJson(TIMES_KEY), // { "bike|lon,lat": {times}, "transit|lon,lat": {date, stop, times} }
  table: { sort: 'max', dir: 1, onlyHits: true, onlyFavs: false, ...loadJson(TABLE_KEY) },
  favs: new Set(loadJson(FAV_KEY).list ?? []), // gemerkte Schulen – nur in diesem Browser, nicht im Link
};

// ---------- Karte ----------
const map = L.map('map', { zoomControl: true, keyboard: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende ' +
    '(<a href="https://www.openstreetmap.org/fixthemap">Karte verbessern</a>) · Routing: ' +
    '<a href="https://valhalla1.openstreetmap.de">Valhalla/FOSSGIS</a>, <a href="https://v6.bvg.transport.rest">transport.rest</a> · Suche: <a href="https://photon.komoot.io">Photon</a>',
}).addTo(map);

// Eigene Ebenen unter den Schul-Markern (overlayPane, z 400): Flächen, darüber Routen.
// So müssen Marker nie nach vorn geholt werden – das würde beim Hovern das mouseout verschlucken.
map.createPane('areas').style.zIndex = 350;
map.createPane('routes').style.zIndex = 380;
// Zeit-Etiketten über Linien und Schul-Markern (overlayPane 400), unter Tooltips/Popups; klick-durchlässig.
const labelPane = map.createPane('routeLabels');
labelPane.style.zIndex = 450;
labelPane.style.pointerEvents = 'none';
// Kleiner Punkt in der Mitte gemerkter Schulen (über den Markern, klick-durchlässig).
const favPane = map.createPane('favStars');
favPane.style.zIndex = 420;
favPane.style.pointerEvents = 'none';
const favLayer = L.layerGroup().addTo(map);
const areaLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
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
    markers[label] = L.marker(latLng, { icon: pinIcon(label), draggable: true, zIndexOffset: 1000, title: `Ort ${label} (verschiebbar)`, alt: `Ort ${label}` })
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

function pointSet(label, lonLat) {
  const moved = Boolean(state.points[label]);
  placePoint(label, lonLat);
  state.armed = null;
  const next = nextLabel();
  toast(`Ort ${label} ${moved ? 'neu ' : ''}gesetzt${next ? ` – jetzt Ort ${next} setzen` : ''}`, label);
  update();
}

map.on('click', (e) => {
  const label = nextLabel();
  if (label) pointSet(label, [e.latlng.lng, e.latlng.lat]);
});

// Schul-Index für die Suche: wird aus den geladenen Daten gebaut (neue Schulen sind automatisch dabei).
const norm = (t) => String(t ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const schoolSearch = {
  find(q) {
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return schools
      .map((s) => {
        const name = norm(s.p.Schule);
        const hay = `${name} ${norm(s.p.Schulnummer)} ${norm(s.p.Ortsteil)} ${norm(s.p.Bezirk)} ${norm(s.category)} ${norm(s.p.Schulform)}`;
        if (!tokens.every((t) => hay.includes(t))) return null;
        const score = name.startsWith(tokens[0]) ? 0 : tokens.every((t) => name.includes(t)) ? 1 : 2;
        return { s, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.s.p.Schule.localeCompare(b.s.p.Schule, 'de'))
      .slice(0, 6)
      .map(({ s }) => ({ name: s.p.Schule, sub: [s.category, s.p.Ortsteil || s.p.Bezirk].filter(Boolean).join(' · ') }));
  },
  open: (name) => focusSchool(name),
};

const search = addSearchControl(map, (label, lonLat) => {
  map.setView([lonLat[1], lonLat[0]], Math.max(map.getZoom(), 14));
  pointSet(label, lonLat);
}, schoolSearch);


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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// Fadenkreuz, solange ein Klick in die Karte einen Punkt setzt.
function updatePlacing() {
  const label = nextLabel();
  map.getContainer().classList.toggle('placing', Boolean(label));
  for (const l of ['A', 'B']) $(`set${l}`).setAttribute('aria-pressed', String(state.armed === l));
}

// ---------- Schulen ----------
// Kurzerklärungen der Schulformen (Berliner Regeln) für Hover-Tooltips.
const FORM_INFO = {
  Gymnasium: 'Gymnasium: Abitur nach 12 Jahren (Klasse 12). Aufnahme nur mit Förderprognose (Notensumme ≤ 14) oder bestandenem Probeunterricht. Höheres Tempo, 2. Fremdsprache ab Klasse 7.',
  ISS: 'Integrierte Sekundarschule (ISS): Klassen 7–10 mit allen Abschlüssen (BBR, MSA); Abitur nach 13 Jahren – an der eigenen Oberstufe oder nach Wechsel. Keine Mindestnote für die Aufnahme, leistungsgemischte Klassen (teils Kurse auf zwei Niveaus), Ganztagsschule.',
  Gemeinschaftsschule: 'Gemeinschaftsschule: wie eine ISS mit allen Abschlüssen und Abitur nach 13 Jahren, oft aber von Klasse 1 an ohne Schulwechsel. Gemeinsames Lernen ohne Aufteilung nach Leistung; teils Lernentwicklungsberichte statt Noten in den unteren Jahrgängen.',
  'Freie Schule': 'Freie Schule: Privatschule mit eigenem pädagogischem Konzept (z. B. Waldorf, Montessori, demokratische Schule). Schulgeld und eigene Aufnahme; Abschlüsse je nach Schule, teils nur über externe Prüfungen.',
};
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

// "Ganztagsform" aus der CSV: gebunden | teilgebunden | offen | Halbtag (sonst unklar – wird nie ausgefiltert).
const GT_VALUES = ['gebunden', 'teilgebunden', 'offen', 'Halbtag'];
const GT_INFO = {
  gebunden: 'Gebundener Ganztag: an (meist) 4 Tagen bis ca. 16 Uhr verpflichtend; Unterricht, Lernzeiten, Mittagessen und Angebote über den ganzen Tag verteilt.',
  teilgebunden: 'Teilgebundener Ganztag: einige Tage verpflichtend bis ca. 16 Uhr, an den anderen sind die Nachmittagsangebote freiwillig.',
  offen: 'Offener Ganztag: Unterricht am Vormittag, Nachmittagsangebote (Sport, Musik, AGs, Lernzeit) freiwillig.',
  Halbtag: 'Halbtagsschule: Unterricht meist bis zum frühen Nachmittag, kein verpflichtender Ganztag (ggf. freiwillige AGs).',
};
function gtCategory(p) {
  const v = (p['Ganztagsform'] ?? '').trim();
  return GT_VALUES.includes(v) ? v : 'unklar';
}

function costCategory(p) {
  return /^kostenfrei/i.test(p.Kosten ?? '') || /^staatlich$/i.test(p['Träger'] ?? '') ? 'staatlich' : 'privat';
}

// Fotos werden erst fürs Popup gebraucht – nicht auf sie warten.
let fotos = {};
fetch(`${import.meta.env.BASE_URL}fotos.json?v=${__BUILD_ID__}`).then((r) => (r.ok ? r.json() : {})).then((f) => (fotos = f)).catch(() => {});

const schools = (await (await fetch(`${import.meta.env.BASE_URL}schulen.geojson?v=${__BUILD_ID__}`)).json()).features.map((f) => {
  const p = f.properties;
  const school = { p, category: formCategory(p), abi: abiCategory(p), cost: costCategory(p), gt: gtCategory(p), lonLat: f.geometry.coordinates, hit: false };
  school.marker = L.circleMarker([school.lonLat[1], school.lonLat[0]], { radius: 7, weight: 2 })
    .bindPopup(() => popupHtml(school), { className: 'school-popup', maxWidth: 380, minWidth: 320, autoPanPaddingTopLeft: [20, 70], autoPanPaddingBottomRight: [20, 40] })
    .bindTooltip(escapeHtml(p.Schule), { direction: 'top', offset: [0, -6] })
    .on('popupopen', () => { selectSchool(p.Schule); hoverRoutes(null); })
    .on('popupclose', () => { if (selected === p.Schule) selectSchool(null); hoverRoutes(null); })
    .on('mouseover', () => { showOnlyTooltip(school.marker); highlightList(p.Schule, true); hoverRoutes(p.Schule); })
    .on('mouseout', () => { school.marker.closeTooltip(); highlightList(p.Schule, false); hoverRoutes(null); });
  return school;
});
const byName = new Map(schools.map((s) => [s.p.Schule, s]));
// Popups nie höher als die Karte (sonst ragen sie heraus); vor dem Öffnen setzen, damit das Verschieben der Karte passt.
function fitPopupHeights() {
  const maxH = Math.max(220, map.getSize().y - 110);
  for (const s of schools) s.marker.getPopup().options.maxHeight = maxH;
}
fitPopupHeights();
// Karte auf die Schulen ausrichten (kein fest eingebauter Mittelpunkt).
map.fitBounds(L.latLngBounds(schools.filter((s) => s.p.Bezirk !== 'Brandenburg').map((s) => [s.lonLat[1], s.lonLat[0]])), { padding: [20, 20] });

function km(school, label) {
  const pt = state.points[label];
  return pt ? distance(pt, school.lonLat, { units: 'kilometers' }) : null;
}

function approxMin(school, label, mode = state.mode) {
  const d = km(school, label);
  return d == null ? null : Math.round((d / SPEED_KMH[mode]) * 60);
}

// Echte Fahrzeit: undefined = noch nicht berechnet, null = keine Verbindung gefunden.
// Einträge pro Render einmal nachschlagen (pointKey baut jedes Mal einen String).
let entryCache = new Map();
function timeEntry(label, mode) {
  const k = `${label}|${mode}`;
  if (!entryCache.has(k)) {
    const pt = state.points[label];
    entryCache.set(k, pt ? state.times[`${mode}|${pointKey(pt)}`] ?? nearbyEntry(state.times, pt, mode) : undefined);
  }
  return entryCache.get(k);
}
// Toleranz für Rundungsgrenzen (z. B. Punkt aus einem Link mit 4 statt voller Nachkommastellen).
function nearbyEntry(store, pt, mode) {
  for (const [key, entry] of Object.entries(store)) {
    const [m, coords] = key.split('|');
    if (m !== mode) continue;
    const [lon, lat] = coords.split(',').map(Number);
    if (Math.abs(lon - pt[0]) <= 0.0011 && Math.abs(lat - pt[1]) <= 0.0011) return entry;
  }
  return undefined;
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

// ---------- Merken (lokal, übersteht Neustarts) ----------
function toggleFav(name) {
  if (state.favs.has(name)) state.favs.delete(name);
  else state.favs.add(name);
  saveJson(FAV_KEY, { list: [...state.favs] });
  renderSchools();
  setFavs(state.favs);
  // offenes Popup aktualisieren
  for (const btn of document.querySelectorAll(`.popup-fav[data-school="${CSS.escape(name)}"]`)) favButtonState(btn, name);
}
function favButtonState(btn, name) {
  const on = state.favs.has(name);
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '★ Gemerkt' : '☆ Merken';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.popup-fav');
  if (b) toggleFav(b.dataset.school);
});

// ---------- Popup ----------
function carouselHtml(name) {
  const list = fotos[name];
  if (!list?.length) return '';
  const nav = list.length > 1
    ? `<button type="button" class="car-prev" aria-label="Vorheriges Foto">‹</button>
       <button type="button" class="car-next" aria-label="Nächstes Foto">›</button>
       <span class="car-count" aria-live="polite">1 / ${list.length}</span>`
    : '';
  return `<figure class="carousel" data-school="${escapeHtml(name)}" data-i="0">
      <div class="car-frame"><img src="${escapeHtml(safeUrl(list[0].thumb))}" alt="${escapeHtml(list[0].title)}" loading="lazy" width="500" height="333" />${nav}</div>
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
  img.src = safeUrl(f.thumb);
  img.alt = f.title;
  const count = fig.querySelector('.car-count');
  if (count) count.textContent = `${idx + 1} / ${n}`;
  const credit = fig.querySelector('.car-credit');
  credit.replaceChildren('Foto: ', f.author, ' · ');
  const link = (href, text) => Object.assign(document.createElement('a'), { href: safeUrl(href), target: '_blank', rel: 'noopener', textContent: text });
  credit.append(link(f.licenseUrl || f.page, f.license || 'Lizenz'), ' · ', link(f.page, 'Wikimedia Commons'));
}

function timeText(s, l) {
  if (!state.points[l]) return '';
  const fmt = (mode) => {
    const r = realInfo(s, l, mode);
    if (r === null) return `${MODE_LABEL[mode]} –`;
    if (r === undefined) return `${MODE_LABEL[mode]} ≈${approxMin(s, l, mode)} min`;
    if (mode === 'bike') return `Rad ${r} min`;
    return `ÖPNV ${r.min} min${r.lines.length ? ` (${r.lines.join(' → ')})` : ' (zu Fuß)'}`;
  };
  return `${fmt('transit')} · ${fmt('bike')}`;
}

function popupHtml(s) {
  const { p } = s;
  const row = (k, v) => (v ? `<tr><th scope="row">${k}</th><td>${escapeHtml(v)}</td></tr>` : '');
  const d = demand(s);
  const next = nextEventFor(p.Schule);
  const abi = `${s.abi}${p['Eigene Oberstufe'] ? ` – ${p['Eigene Oberstufe']}` : ''}`;
  const sites = p['Weitere Standorte']
    ? `<div class="popup-sites" role="note"><strong>Mehrere Standorte.</strong> Karte und Fahrzeiten beziehen sich auf <strong>${escapeHtml(p.Adresse)}</strong>. Weitere: ${escapeHtml(p['Weitere Standorte'])}</div>`
    : '';
  const fav = state.favs.has(p.Schule);
  return `${carouselHtml(p.Schule)}<div class="popup-body"><div class="popup-head"><h3 class="popup-title">${escapeHtml(p.Schule)}</h3><button type="button" class="popup-fav btn" data-school="${escapeHtml(p.Schule)}" aria-pressed="${fav}">${fav ? '★ Gemerkt' : '☆ Merken'}</button></div>${sites}
    <table class="popup">
      ${row('Ab Ort A', timeText(s, 'A'))}
      ${row('Ab Ort B', timeText(s, 'B'))}
      ${row('Schulform', p.Schulform)}
      ${row('Abitur', abi)}
      ${row('Ganztag', [s.gt !== 'unklar' ? s.gt : '', p.Ganztag].filter(Boolean).join(' – '))}
      ${row('Schulbeginn', [p['Unterrichtsbeginn'] ? `Unterricht ab ${p['Unterrichtsbeginn']}` : '', p['Beginn Details']].filter(Boolean).join(' · '))}
      ${row('Kosten', p.Kosten)}
      ${row('Schüler*innen', pupils(s) == null ? '' : `${pupils(s).toLocaleString('de-DE')}${p['Schüler Jg. 7'] ? ` (Jahrgang 7: ${p['Schüler Jg. 7']})` : ''}${p['Schülerzahl Stand'] ? `, Stand ${p['Schülerzahl Stand']}` : ''}`)}
      ${row('Nachfrage', d == null ? '' : `${Math.round(d * 100)} % (${p['Erstwünsche 2026/27']} Erstwünsche auf ${p['Plätze 2026/27']} Plätze, 2026/27)`)}
      ${row('Nächster Termin', next ? `${next.start.slice(8, 10)}.${next.start.slice(5, 7)}. ${next.titel}` : '')}
      ${row('Adresse', p.Adresse)}
      ${row('Notizen', [p['Nachfrage Hinweis'], p.Notizen].filter(Boolean).join(' · '))}
    </table>
    ${safeUrl(p.Quelle) ? `<a class="popup-src" href="${escapeHtml(safeUrl(p.Quelle))}" target="_blank" rel="noopener">Website / Quelle <span class="sr-only">(neuer Tab)</span>↗</a>` : ''}
    </div>`;
}

let returnFocus = null;
map.on('popupopen', (e) => {
  const el = e.popup.getElement();
  const fig = el?.querySelector('.carousel');
  if (fig && fotos[fig.dataset.school]) {
    showFoto(fig, 0);
    fig.querySelector('.car-prev')?.addEventListener('click', () => showFoto(fig, Number(fig.dataset.i) - 1));
    fig.querySelector('.car-next')?.addEventListener('click', () => showFoto(fig, Number(fig.dataset.i) + 1));
    fig.querySelector('img').addEventListener('load', () => { e.popup.update(); e.popup._adjustPan?.(); }, { once: true });
  }
  if (returnFocus) {
    el.setAttribute('tabindex', '-1');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', el.querySelector('.popup-title')?.textContent ?? 'Schule');
    el.focus();
  }
});
map.on('popupclose', () => {
  returnFocus?.focus?.();
  returnFocus = null;
});

// ---------- Routen A/B → Schule (nur mit berechneten Fahrzeiten, auf Abruf) ----------
// Routen erscheinen beim Darüberfahren (Marker, Tabellenzeile, Termin); ohne Hover die der ausgewählten Schule.
// Kurze Hover-Verzögerung, damit Überfliegen der Liste keine Anfragen auslöst.
const HOVER_DELAY_MS = 350;
let hoverTimer;
function hoverRoutes(name) {
  clearTimeout(hoverTimer);
  const target = name ?? selected;
  if (!target) { routeRequest++; routeLayer.clearLayers(); return; }
  // Gespeicherte Routen sofort zeigen; nur wenn noch geladen werden muss, kurz warten.
  const ready = setLabels().every((l) => storedRoutes(l, state.mode, target));
  if (ready || !name) showRoutes(byName.get(target));
  else hoverTimer = setTimeout(() => showRoutes(byName.get(target)), HOVER_DELAY_MS);
}

function storedRoutes(label, mode, name) {
  const pt = state.points[label];
  if (!pt) return undefined;
  const entry = state.routes[`${mode}|${pointKey(pt)}`] ?? nearbyEntry(state.routes, pt, mode);
  if (entry?.[name]) return entry[name];
  // Schulen in Fußnähe: gerade Fußweg-Linie, ohne Abfrage.
  const school = byName.get(name);
  const info = school && realInfo(school, label, mode);
  if (mode === 'transit' && info && !info.lines?.length) return [{ kind: 'walk', coords: [[pt[1], pt[0]], [school.lonLat[1], school.lonLat[0]]] }];
  return undefined;
}
let saveRoutesTimer;
function rememberRoutes(label, mode, name, legs) {
  const key = `${mode}|${pointKey(state.points[label])}`;
  (state.routes[key] ??= {})[name] = legs;
  clearTimeout(saveRoutesTimer);
  saveRoutesTimer = setTimeout(() => saveJson(ROUTES_KEY, state.routes), 500);
}

// Punkt auf halber Streckenlänge (nicht nur mittlerer Stützpunkt).
function midpoint(coords) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], (coords[i][1] - coords[i - 1][1]) * 0.61);
    segs.push(d);
    total += d;
  }
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i] >= total / 2) {
      const t = segs[i] ? (total / 2 - acc) / segs[i] : 0;
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
    }
    acc += segs[i];
  }
  return coords[0];
}

let routeRequest = 0;
async function showRoutes(school) {
  const req = ++routeRequest;
  routeLayer.clearLayers();
  if (!school || !hasRealTimes()) return;
  const mode = state.mode;
  const results = await Promise.allSettled(setLabels().map(async (l) => {
    let legs = storedRoutes(l, mode, school.p.Schule);
    if (!legs) {
      legs = await (mode === 'bike' ? bikeRoute : transitRoute)(state.points[l], school);
      rememberRoutes(l, mode, school.p.Schule, legs);
    }
    return { l, legs };
  }));
  if (req !== routeRequest) return;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { l, legs } = r.value;
    for (const leg of legs) {
      const walk = leg.kind === 'walk';
      L.polyline(leg.coords, { pane: 'routes', color: '#fff', weight: walk ? 4 : 5, opacity: 0.6, interactive: false }).addTo(routeLayer);
      const line = L.polyline(leg.coords, {
        pane: 'routes', color: COLORS[l], weight: walk ? 2 : 3, opacity: 0.75, dashArray: walk ? '3 5' : null, lineCap: 'round',
      }).addTo(routeLayer);
      line.bindTooltip(walk ? `Ort ${l}: zu Fuß` : leg.kind === 'bike' ? `Ort ${l}: Fahrrad` : `Ort ${l}: ${leg.line}`, { sticky: true });
    }
    // Fahrzeit als kleines Etikett auf der Mitte der Route.
    const min = realMin(school, l, mode);
    const path = legs.flatMap((leg) => leg.coords);
    if (min != null && path.length > 1) {
      L.marker(midpoint(path), {
        pane: 'routeLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: `route-label route-label-${l}`, html: `${min} min`, iconSize: null }),
      }).addTo(routeLayer);
    }
  }
}

// ---------- Hover-Verknüpfung Liste ↔ Karte ----------
// Höchstens ein Namensschild gleichzeitig offen.
let openTipMarker = null;
function showOnlyTooltip(marker) {
  if (openTipMarker && openTipMarker !== marker) openTipMarker.closeTooltip();
  openTipMarker = marker;
}

function highlightMarker(name, on) {
  hoverRoutes(on ? name : null);
  const s = byName.get(name);
  if (!s?.base || !schoolLayer.hasLayer(s.marker)) return;
  if (on) {
    s.marker.setStyle({ ...s.base, color: '#111827', weight: 4, radius: s.base.radius + 4, fillOpacity: 1 });
    s.marker.bringToFront(); // Maus ist hier über der Liste, nicht über dem Marker
    showOnlyTooltip(s.marker);
    s.marker.openTooltip();
  } else {
    s.marker.setStyle(s.base);
    if (!s.marker.isPopupOpen()) s.marker.closeTooltip();
  }
}

// Ausgewählte Schule (offenes Popup): Zeile und Termine bleiben markiert, auch nach Neuaufbau der Listen.
let selected = null;
function selectSchool(name) {
  selected = name;
  applySelection(true);
}
function applySelection(scroll = false) {
  for (const el of document.querySelectorAll('#schoolTable tbody tr[data-school], #termList li[data-schools]')) {
    const names = el.dataset.school ? [el.dataset.school] : JSON.parse(el.dataset.schools);
    el.classList.toggle('sel', selected != null && names.includes(selected));
  }
  if (!scroll || !selected) return;
  const row = document.querySelector('#schoolTable tbody tr.sel');
  if (row) scrollIntoWrap(row, row.closest('.table-wrap'));
  const ev = document.querySelector('#termList li.sel');
  if (ev) scrollIntoWrap(ev, ev.closest('.term-list'));
}

function highlightList(name, on) {
  for (const el of document.querySelectorAll('#schoolTable tbody tr[data-school], #termList li[data-schools]')) {
    const names = el.dataset.school ? [el.dataset.school] : JSON.parse(el.dataset.schools);
    if (!names.includes(name)) continue;
    el.classList.toggle('hl', on);
    if (on && el.tagName === 'TR') scrollIntoWrap(el, el.closest('.table-wrap'));
    if (on && el.tagName === 'LI') scrollIntoWrap(el, el.closest('.term-list'));
  }
}

// Nur innerhalb des eigenen Scrollbereichs nachziehen, nie die ganze Seite.
function scrollIntoWrap(el, wrap) {
  if (!wrap || wrap.scrollHeight <= wrap.clientHeight) return;
  const r = el.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const headH = wrap.querySelector('thead')?.offsetHeight ?? 0;
  if (r.top < w.top + headH) wrap.scrollTop -= w.top + headH - r.top + 4;
  else if (r.bottom > w.bottom) wrap.scrollTop += r.bottom - w.bottom + 4;
}

function focusSchool(name) {
  const s = byName.get(name);
  if (!s) return false;
  returnFocus = document.activeElement;
  // Ohne Animation zoomen, damit das anschließende Verschieben fürs Popup nicht mit der Zoom-Animation kollidiert.
  map.setView(s.marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: false });
  s.marker.addTo(schoolLayer).openPopup();
  return true;
}

// ---------- Berechnung ----------
let generation = 0;

async function update() {
  const gen = ++generation;
  const { mode, minutes } = state;
  const labels = setLabels();

  const results = await Promise.all(labels.map((l) => reachArea(state.points[l], mode, minutes, state.source)));
  if (gen !== generation) return; // überholt

  state.areas = { A: null, B: null };
  labels.forEach((l, i) => (state.areas[l] = results[i].feature));
  state.overlap = state.areas.A && state.areas.B
    ? intersect(featureCollection([state.areas.A, state.areas.B]))
    : null;

  const sources = [...new Set(results.map((r) => r.source))];
  $('method').textContent = sources.map((s) => SOURCE_LABEL[s]).join(' · ');
  $('method').classList.toggle('approx', sources.includes('approx-fallback'));

  drawAreas();
  renderSchools();
}

// Erreichbar = echte Fahrzeit von allen gesetzten Orten ≤ Limit; ohne echte Zeiten: liegt in allen Flächen.
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
      pane: 'areas',
      style: { color: COLORS[l], weight: 2, fillOpacity: 0.07, dashArray: '6 4' },
    }).addTo(areaLayer);
  }
  if (state.overlap) {
    L.geoJSON(state.overlap, {
      interactive: false,
      pane: 'areas',
      style: { color: COLORS.overlap, weight: 2, fillColor: COLORS.overlap, fillOpacity: 0.22 },
    }).addTo(areaLayer);
  }
}

const anyArea = () => Boolean(state.areas.A || state.areas.B);

function renderSchools() {
  entryCache = new Map();
  const visible = schools.filter((s) =>
    (state.forms.has(s.category) || s.category === 'Sonstige') &&
    (state.abi.has(s.abi) || s.abi === 'unklar') &&
    (state.gt.has(s.gt) || s.gt === 'unklar') &&
    state.cost.has(s.cost));
  for (const s of schools) s.hit = anyArea() && isHit(s);
  const hits = visible.filter((s) => s.hit);

  const visibleSet = new Set(visible);
  for (const s of schools) {
    if (!visibleSet.has(s)) { schoolLayer.removeLayer(s.marker); continue; }
    const dim = anyArea() && !s.hit;
    s.base = {
      color: s.hit ? '#14532d' : dim ? '#94a3b8' : '#334155',
      fillColor: s.hit ? COLORS.overlap : dim ? '#e2e8f0' : '#64748b',
      fillOpacity: dim ? 0.7 : 0.95,
      weight: s.hit ? 3 : 2,
      radius: s.hit ? 9 : 7,
    };
    s.marker.setStyle(s.base);
    if (!schoolLayer.hasLayer(s.marker)) s.marker.addTo(schoolLayer);
    if (s.hit) s.marker.bringToFront();
  }

  favLayer.clearLayers();
  for (const s of visible) {
    if (!state.favs.has(s.p.Schule)) continue;
    L.marker(s.marker.getLatLng(), {
      pane: 'favStars', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'fav-dot', html: '', iconSize: [7, 7], iconAnchor: [3.5, 3.5] }),
    }).addTo(favLayer);
  }

  const both = state.areas.A && state.areas.B;
  $('resultTitle').textContent = !anyArea()
    ? String(visible.length)
    : `${hits.length} von ${visible.length} erreichbar von ${both ? 'A und B' : state.areas.A ? 'A' : 'B'}`;
  $('export').disabled = hits.length === 0;
  $('export').onclick = () => exportCsv(hits);

  $('hint').textContent = state.armed
    ? `Klick in die Karte oder Adresse suchen, um Ort ${state.armed} zu setzen.`
    : !state.points.A ? 'Adresse über die Lupe auf der Karte suchen (dort findest du auch Schulen) oder in die Karte klicken, um Ort A zu setzen.'
    : !state.points.B ? 'Jetzt Ort B setzen: Adresse suchen oder in die Karte klicken.'
    : 'Die Punkte A und B lassen sich auf der Karte verschieben.';

  renderTable(visible);
  renderTimesInfo();
  updatePlacing();
  syncUrl();
  setHits(anyArea() ? new Set(hits.map((s) => s.p.Schule)) : null);
  applySelection();
}

// ---------- Tabelle ----------
const fmtKm = (v) => (v == null ? '' : `${v.toFixed(1).replace('.', ',')} km`);

function demand(s) {
  const places = Number(s.p['Plätze 2026/27']);
  const wishes = Number(s.p['Erstwünsche 2026/27']);
  return places && s.p['Erstwünsche 2026/27'] !== '' ? wishes / places : null;
}

function pupils(s) {
  const n = Number(s.p['Schülerzahl']);
  return s.p['Schülerzahl'] && Number.isFinite(n) ? n : null;
}

// Fairness: Unterschied der beiden Fahrzeiten im gewählten Modus (nur wenn A und B gesetzt sind).
function delta(s) {
  if (!(state.points.A && state.points.B)) return null;
  const a = bestMin(s, 'A');
  const b = bestMin(s, 'B');
  if (a == null || b == null) return null;
  return { a, b, diff: Math.abs(a - b), longer: a > b ? 'A' : 'B', real: realMin(s, 'A') != null && realMin(s, 'B') != null };
}

function maxMin(s) {
  const mins = setLabels().map((l) => bestMin(s, l));
  return !mins.length || mins.some((m) => m == null) ? null : Math.max(...mins);
}

// Alle Details zu einem Ort für den Hover-Text der Fahrzeit-Spalte.
function detailLine(s, l) {
  if (!state.points[l]) return '';
  const part = (mode) => {
    const r = realInfo(s, l, mode);
    if (r === null) return `${MODE_LABEL[mode]}: keine Verbindung`;
    if (r === undefined) return `${MODE_LABEL[mode]}: ≈${approxMin(s, l, mode)} min (grob)`;
    if (mode === 'bike') return `Rad: ${r} min`;
    if (!r.lines.length) return `ÖPNV: ${r.min} min (zu Fuß)`;
    return `ÖPNV: ${r.min} min (${r.lines.join(' → ')}, ${r.transfers} Umstieg${r.transfers === 1 ? '' : 'e'}, ab ${r.stop} +${r.walkMin} min Fußweg)`;
  };
  return `Ort ${l} – ${part('transit')} · ${part('bike')} · ${fmtKm(km(s, l))} Luftlinie`;
}

const ALL_COLUMNS = [
  { key: 'status', label: 'Beide', title: 'Von den gesetzten Orten in der eingestellten Zeit erreichbar',
    value: (s) => (anyArea() ? (s.hit ? 0 : 1) : 0),
    html: (s) => (anyArea()
      ? `<span class="dot ${s.hit ? 'hit' : 'dim'}" aria-hidden="true"></span><span class="sr-only">${s.hit ? 'erreichbar' : 'nicht erreichbar'}</span>`
      : '') },
  { key: 'fav', label: '★', title: 'Gemerkte Schulen (nur in diesem Browser gespeichert)', cls: 'favcell',
    value: (s) => (state.favs.has(s.p.Schule) ? 0 : 1),
    html: (s) => {
      const on = state.favs.has(s.p.Schule);
      return `<button type="button" class="fav" data-school="${escapeHtml(s.p.Schule)}" aria-pressed="${on}" aria-label="${escapeHtml(s.p.Schule)} ${on ? 'nicht mehr merken' : 'merken'}" title="${on ? 'Gemerkt – klicken zum Entfernen' : 'Merken'}">${on ? '★' : '☆'}</button>`;
    } },
  { key: 'name', label: 'Schule', value: (s) => s.p.Schule, cls: 'name',
    html: (s) => `<button type="button" class="linkish" data-school="${escapeHtml(s.p.Schule)}">${escapeHtml(s.p.Schule)}</button>` },
  { key: 'form', label: 'Form', value: (s) => s.category,
    html: (s) => `<span class="badge b-${s.category.replace(' ', '-')}" title="${escapeHtml(FORM_INFO[s.category] ?? '')}">${s.category}</span>` },
  { key: 'abi', label: 'Abitur', title: 'Abitur an dieser Schule möglich',
    value: (s) => ({ ja: 0, 'im Aufbau': 1, nein: 2 })[s.abi] ?? null,
    html: (s) => `<span class="badge abi-${s.abi.replace(' ', '-')}" title="${escapeHtml(s.p['Eigene Oberstufe'] || '')}">${s.abi}</span>` },
  { key: 'cost', label: 'Träger', value: (s) => s.cost,
    html: (s) => `<span class="badge c-${s.cost}" title="${escapeHtml(s.p.Kosten || '')}">${s.cost === 'privat' ? 'privat €' : 'staatlich'}</span>` },
  { key: 'ganztag', label: 'Ganztag', hideIfEmpty: true,
    value: (s) => (s.gt === 'unklar' ? null : GT_VALUES.indexOf(s.gt)),
    html: (s) => (s.gt === 'unklar' ? ''
      : `<span class="badge gt-${s.gt}" title="${escapeHtml([GT_INFO[s.gt], s.p.Ganztag].filter(Boolean).join(' – '))}">${s.gt}</span>`) },
  { key: 'bezirk', label: 'Bezirk', value: (s) => s.p.Bezirk || null,
    html: (s) => escapeHtml(s.p.Bezirk) },
  { key: 'nachfrage', label: 'Nachfrage', num: true,
    title: 'Erstwünsche pro Platz 2026/27. Über 100 %: keine Plätze für Zweit- und Drittwünsche',
    value: demand,
    html: (s) => {
      const d = demand(s);
      if (d == null) return '';
      const cls = d > 1 ? 'over' : d >= 0.9 ? 'tight' : 'free';
      const tip = `2026/27: ${s.p['Erstwünsche 2026/27']} Erstwünsche auf ${s.p['Plätze 2026/27']} Plätze${s.p['Nachfrage Hinweis'] ? ` – ${s.p['Nachfrage Hinweis']}` : ''}`;
      return `<span class="demand ${cls}" title="${escapeHtml(tip)}">${Math.round(d * 100)} %${s.p['Nachfrage Hinweis'] ? '*' : ''}</span>`;
    } },
  { key: 'schueler', label: 'Größe', num: true, hideIfEmpty: true,
    title: 'Schüler*innen der ganzen Schule (laut Schulverzeichnis bzw. Schule). Beim Darüberfahren: Jahrgang 7 und Stand.',
    value: (s) => pupils(s),
    html: (s) => {
      const n = pupils(s);
      if (n == null) return '';
      const tip = [`${n.toLocaleString('de-DE')} Schüler*innen`, s.p['Schüler Jg. 7'] ? `Jahrgang 7: ${s.p['Schüler Jg. 7']}` : '', s.p['Schülerzahl Stand'] ? `Stand ${s.p['Schülerzahl Stand']}` : ''].filter(Boolean).join(' · ');
      return `<span title="${escapeHtml(tip)}">${n.toLocaleString('de-DE')}</span>`;
    } },
  { key: 'max', label: 'Längster Weg', num: true,
    title: () => `Längerer der beiden Wege ab Ort A und Ort B mit ${state.mode === 'bike' ? 'dem Rad' : 'ÖPNV'}, in Minuten. Details beim Darüberfahren.`,
    value: (s) => maxMin(s),
    html: (s) => {
      const labels = setLabels();
      if (!labels.length) return '';
      const mins = labels.map((l) => bestMin(s, l));
      if (mins.some((m) => m == null)) return `<span class="approx" title="${escapeHtml(labels.map((l) => detailLine(s, l)).join('\n'))}">–</span>`;
      const v = Math.max(...mins);
      const side = labels.length > 1 ? labels[mins.indexOf(v)] : '';
      const real = labels.every((l) => realMin(s, l) != null);
      const tip = labels.map((l) => detailLine(s, l)).join('\n');
      return `<span class="time${real ? '' : ' approx'}" title="${escapeHtml(tip)}">${real ? '' : '≈'}${v}<span class="unit"> min.</span></span>${side ? `<span class="side side-${side}" title="längerer Weg ab Ort ${side}">${side}</span>` : ''}`;
    } },
  { key: 'delta', label: 'Unterschied', num: true, hideIfEmpty: true,
    title: () => `Wie viele Minuten die Wege von Ort A und Ort B auseinanderliegen (${MODE_LABEL[state.mode]}). Klein = fair verteilt.`,
    value: (s) => delta(s)?.diff ?? null,
    html: (s) => {
      const d = delta(s);
      if (!d) return '';
      const cls = d.diff <= 5 ? 'fair' : d.diff <= 15 ? 'mid' : 'unfair';
      const word = { fair: 'ausgeglichen', mid: 'mittel', unfair: 'ungleich' }[cls];
      const tip = `A ${d.a} min · B ${d.b} min – ${d.diff ? `${d.longer} ist ${d.diff} min länger` : 'gleich lang'}${d.real ? '' : ' (grob geschätzt)'}`;
      return `<span class="delta ${cls}${d.real ? '' : ' approx'}" title="${escapeHtml(tip)}">${d.real ? '' : '≈'}${d.diff}<span class="unit"> min.</span></span><span class="sr-only"> (${word}${d.diff ? `, länger ab ${d.longer}` : ''})</span>`;
    } },
  { key: 'next', label: 'Nächster Termin', value: (s) => nextEventFor(s.p.Schule)?.start ?? null, cls: 'clip',
    html: (s) => {
      const t = nextEventFor(s.p.Schule);
      if (!t) return '';
      const [, m, d] = t.start.slice(0, 10).split('-');
      return escapeHtml(`${d}.${m}. ${t.titel}`);
    } },
];

function renderTable(visible) {
  const { sort, dir, onlyHits } = state.table;
  const COLUMNS = ALL_COLUMNS.filter((c) => !c.hideIfEmpty || schools.some((s) => c.value(s) != null));
  const col = COLUMNS.find((c) => c.key === sort) ?? COLUMNS[0];
  const fallback = COLUMNS.find((c) => c.key === (anyArea() ? 'max' : 'name'));
  // Sortierschlüssel einmal pro Zeile berechnen.
  const keyed = visible
    .filter((s) => !onlyHits || !anyArea() || s.hit)
    .filter((s) => !state.table.onlyFavs || state.favs.has(s.p.Schule))
    .map((s) => ({ s, v: col.value(s), f: fallback.value(s) }));
  const cmp = (va, vb, num) => {
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // leere Werte immer ans Ende
    if (vb == null) return -1;
    return num ? va - vb : String(va).localeCompare(String(vb), 'de');
  };
  keyed.sort((a, b) => cmp(a.v, b.v, col.num) * dir || cmp(a.f, b.f, fallback.num) || a.s.p.Schule.localeCompare(b.s.p.Schule, 'de'));
  const rows = keyed.map((k) => k.s);

  const head = document.createElement('tr');
  for (const c of COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (c.cls?.includes('num')) th.className = 'num';
    th.setAttribute('aria-sort', c.key === sort ? (dir > 0 ? 'ascending' : 'descending') : 'none');
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'sort', textContent: typeof c.label === 'function' ? c.label() : c.label });
    const title = typeof c.title === 'function' ? c.title() : c.title;
    if (title) btn.title = title;
    btn.onclick = () => {
      state.table.dir = state.table.sort === c.key ? -state.table.dir : 1;
      state.table.sort = c.key;
      saveJson(TABLE_KEY, state.table);
      renderTable(visible);
      syncUrl();
      $('schoolTable').querySelector(`th:nth-child(${COLUMNS.indexOf(c) + 1}) button`)?.focus();
    };
    th.append(btn);
    head.append(th);
  }
  $('schoolTable').tHead.replaceChildren(head);

  const body = $('schoolTable').tBodies[0];
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = Object.assign(document.createElement('td'), { colSpan: COLUMNS.length, className: 'empty' });
    td.textContent = state.table.onlyFavs && !state.favs.size
      ? 'Noch keine Schule gemerkt. Mit ☆ in der Tabelle oder „Merken“ in der Schulkarte merken.'
      : onlyHits && anyArea()
      ? `Keine Schule ist von beiden Orten in ${state.minutes} Minuten erreichbar. Zeit erhöhen oder Verkehrsmittel wechseln.`
      : 'Keine Schule passt zu den Filtern.';
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(...rows.map((s) => {
    const tr = document.createElement('tr');
    tr.className = anyArea() ? (s.hit ? 'hit' : 'dim') : '';
    for (const c of COLUMNS) {
      const td = document.createElement('td');
      if (c.cls) td.className = c.cls;
      td.innerHTML = c.html(s);
      if (c.cls?.includes('clip')) td.title = td.textContent;
      tr.append(td);
    }
    tr.dataset.school = s.p.Schule;
    tr.onclick = (e) => { if (!e.target.closest('button')) focusSchool(s.p.Schule); };
    tr.onmouseenter = () => highlightMarker(s.p.Schule, true);
    tr.onmouseleave = () => highlightMarker(s.p.Schule, false);
    return tr;
  }));
}
$('schoolTable').addEventListener('click', (e) => {
  const f = e.target.closest('button.fav');
  if (f) { toggleFav(f.dataset.school); return; }
  const b = e.target.closest('button.linkish');
  if (b) focusSchool(b.dataset.school);
});

// CSV ohne Entfernungen/Fahrzeiten: daraus ließen sich A und B zurückrechnen.
function exportCsv(hits) {
  const cols = ['Schule', 'Schulform', 'Bezirk', 'Kosten', 'Abitur vor Ort', 'Eigene Oberstufe', 'Adresse', 'Tag der offenen Tür', 'Quelle'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = hits.map((s) => cols.map((c) => q(s.p[c])).join(','));
  const blob = new Blob(['﻿' + [cols.map(q).join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `schulen_erreichbar_${state.mode}_${state.minutes}min.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Bedienelemente ----------
for (const l of ['A', 'B']) {
  $(`set${l}`).onclick = () => {
    state.armed = state.armed === l ? null : l;
    if (state.armed) {
      toast(`Klick in die Karte setzt Ort ${l}`, l);
      search.open(l);
    }
    renderSchools();
  };
}
document.querySelectorAll('input[name=mode]').forEach((el) =>
  el.addEventListener('change', () => { state.mode = el.value; update(); }));

let sliderTimer;
$('minutes').addEventListener('input', (e) => {
  state.minutes = Number(e.target.value);
  $('minLabel').textContent = state.minutes;
  $('minutes').setAttribute('aria-valuetext', `${state.minutes} Minuten`);
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(update, 150);
});

document.querySelectorAll('#formFilter label').forEach((label) => {
  const info = FORM_INFO[label.querySelector('input').value];
  if (info) label.title = info;
});
// Ganztag-Filter erst zeigen, wenn Daten vorliegen.
$('gtFilter').hidden = !schools.some((s) => s.gt !== 'unklar');
document.querySelectorAll('#gtFilter label').forEach((label) => {
  const info = GT_INFO[label.querySelector('input').value];
  if (info) label.title = info;
});

for (const [selector, set] of [
  ['#formFilter input', state.forms],
  ['#abiFilter input', state.abi],
  ['#costFilter input', state.cost],
  ['#gtFilter input', state.gt],
]) {
  document.querySelectorAll(selector).forEach((el) =>
    el.addEventListener('change', () => {
      el.checked ? set.add(el.value) : set.delete(el.value);
      renderSchools();
    }));
}

function setSource(source) {
  state.source = source;
  saveJson(SOURCE_KEY, { source });
  document.querySelectorAll('input[name=source]').forEach((el) => (el.checked = el.value === source));
}
document.querySelectorAll('input[name=source]').forEach((el) => {
  el.checked = el.value === state.source;
  el.addEventListener('change', () => { setSource(el.value); update(); });
});

// Technische Fehler in verständliche Sätze übersetzen.
function friendlyError(err, label) {
  const msg = String(err?.message ?? err);
  if (/Haltestelle/.test(msg)) return `Keine Haltestelle im Umkreis von 1,5 km um Ort ${label}. Bitte den Punkt direkt auf die Adresse setzen.`;
  if (/valhalla/i.test(msg)) return 'Der Fahrrad-Routendienst antwortet gerade nicht. Bitte in ein paar Minuten erneut versuchen – schon berechnete Zeiten bleiben gespeichert.';
  if (/transport\.rest|bvg/i.test(msg)) return 'Der ÖPNV-Dienst antwortet gerade nicht. Bitte in ein paar Minuten erneut versuchen – schon berechnete Zeiten bleiben gespeichert.';
  return 'Die Berechnung ist fehlgeschlagen. Bitte später erneut versuchen – schon berechnete Zeiten bleiben gespeichert.';
}

$('computeTimes').onclick = async () => {
  const labels = setLabels();
  if (!labels.length) return;
  const btn = $('computeTimes');
  const bar = $('timesProgress');
  btn.disabled = true;
  bar.hidden = false;
  const status = (t) => ($('timesStatus').textContent = t);
  let current = labels[0];
  let lastPct = -1;
  try {
    for (const [li, l] of labels.entries()) {
      current = l;
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
      status(`Radwege ab Ort ${l} …`);
      merge('bike', { times: await bikeTimes(state.points[l], todo('bike')) });
      // ÖPNV-Zeiten (inkl. Routen) und Fahrrad-Routen laufen parallel – verschiedene Dienste.
      const routeKey = (mode) => `${mode}|${key}`;
      const needBike = schools.filter((s) => !state.routes[routeKey('bike')]?.[s.p.Schule]);
      let tDone = 0, bDone = 0;
      const tTotal = todo('transit').length, bTotal = needBike.length || 1;
      const progress = () => {
        bar.value = (li + (tDone / tTotal + bDone / bTotal) / 2) / labels.length;
        const pct = Math.floor(((tDone / tTotal + bDone / bTotal) / 2) * 10);
        if (pct !== lastPct) { lastPct = pct; status(`Ort ${l}: ÖPNV ${tDone} von ${tTotal}, Radrouten ${bDone} von ${needBike.length} …`); }
      };
      const [transit, bikeR] = await Promise.all([
        transitTimes(state.points[l], todo('transit'), (i) => { tDone = i; progress(); }),
        needBike.length ? bikeRoutes(state.points[l], needBike, (i) => { bDone = i; progress(); }) : {},
      ]);
      const { routes: transitR, ...transitRest } = transit;
      merge('transit', transitRest);
      state.routes[routeKey('transit')] = { ...state.routes[routeKey('transit')], ...transitR };
      state.routes[routeKey('bike')] = { ...state.routes[routeKey('bike')], ...bikeR };
      saveJson(TIMES_KEY, state.times);
      saveJson(ROUTES_KEY, state.routes);
      prefetchAreas(state.points[l]);
      lastPct = -1;
      renderSchools();
    }
    status(`Fertig. ÖPNV gerechnet für Dienstag, ${schoolDay().date.split('-').reverse().join('.')}, Ankunft bis 8 Uhr.`);
    if (state.source !== 'real') { setSource('real'); update(); }
  } catch (err) {
    console.error(err);
    status(friendlyError(err, current));
  } finally {
    btn.disabled = false;
    bar.hidden = true;
    bar.value = 0;
    renderTimesInfo();
  }
};

function renderTimesInfo() {
  const labels = setLabels();
  const complete = (l, mode) => timeEntry(l, mode) && schools.every((s) => s.p.Schule in timeEntry(l, mode).times)
    && schools.every((s) => realInfo(s, l, mode) == null || storedRoutes(l, mode, s.p.Schule)
      || (mode === 'transit' && !realInfo(s, l, mode).lines?.length)); // Fußweg-Schulen brauchen keine gespeicherte Route
  const missing = labels.filter((l) => !complete(l, 'bike') || !complete(l, 'transit'));
  const partial = missing.some((l) => timeEntry(l, 'bike') || timeEntry(l, 'transit'));
  const btn = $('computeTimes');
  if (!btn.disabled || !labels.length) {
    btn.textContent = !missing.length ? 'Fahrzeiten neu berechnen'
      : partial ? 'Fehlende Fahrzeiten ergänzen'
      : 'Genaue Fahrzeiten berechnen (ca. 2 Min.)';
  }
  btn.disabled = !labels.length || !$('timesProgress').hidden;
  if (!$('timesStatus').textContent || !missing.length) {
    $('timesStatus').textContent = !labels.length ? 'Erst Ort A und B setzen.'
      : missing.length ? `Für Ort ${missing.join(' und ')} ${partial ? 'unvollständig' : 'noch nicht berechnet'} – bis dahin grobe Schätzung (≈).`
      : 'Genaue Fahrzeiten sind berechnet.';
  }
}

$('privacyToggle').onclick = () => {
  const note = $('privacyNote');
  note.hidden = !note.hidden;
  $('privacyToggle').setAttribute('aria-expanded', String(!note.hidden));
};

$('tableOnlyFavs').checked = state.table.onlyFavs;
$('tableOnlyFavs').addEventListener('change', (e) => {
  state.table.onlyFavs = e.target.checked;
  saveJson(TABLE_KEY, state.table);
  renderSchools();
});

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

// ---------- Auswahl per Link teilen (im #-Teil: wird nie an einen Server gesendet) ----------
const FORMS = ['Gymnasium', 'ISS', 'Gemeinschaftsschule', 'Freie Schule'];
const ABIS = ['ja', 'im Aufbau', 'nein'];
const COSTS = ['staatlich', 'privat'];

// Adresszeile immer mit der aktuellen Auswahl aktualisieren (ohne neuen Verlaufseintrag).
function syncUrl() {
  const url = shareUrl(true);
  if (url !== location.href) history.replaceState(null, '', url);
}

function shareUrl(withPoints) {
  const q = new URLSearchParams();
  if (withPoints) {
    for (const l of ['A', 'B']) {
      const p = state.points[l];
      if (p) q.set(l.toLowerCase(), `${p[1].toFixed(4)},${p[0].toFixed(4)}`);
    }
  }
  q.set('m', state.mode);
  q.set('t', state.minutes);
  q.set('k', state.source);
  if (state.forms.size < FORMS.length) q.set('f', [...state.forms].join('|'));
  if (state.abi.size < ABIS.length) q.set('abi', [...state.abi].join('|'));
  if (state.cost.size < COSTS.length) q.set('tr', [...state.cost].join('|'));
  if (state.gt.size < GT_VALUES.length) q.set('gt', [...state.gt].join('|'));
  // Sortierung, z. B. s=nachfrage oder s=-nachfrage (absteigend); Standard (Fahrzeit aufsteigend) weglassen.
  if (state.table.sort !== 'max' || state.table.dir !== 1) q.set('s', `${state.table.dir < 0 ? '-' : ''}${state.table.sort}`);
  if (!state.table.onlyHits) q.set('alle', '1');
  const hash = q.toString().replace(/%2C/g, ',').replace(/%7C/g, '|');
  return `${location.origin}${location.pathname}${location.search}#${hash}`;
}

// Gibt true zurück, wenn der Link Orte enthielt.
function applySharedHash() {
  if (!location.hash.includes('=')) return false;
  const q = new URLSearchParams(location.hash.slice(1));
  const pick = (v, allowed) => (v ?? '').split('|').filter((x) => allowed.includes(x));
  let hadPoints = false;
  // Orte aus dem Link nur übernehmen, wenn sie mehr als ~10 m von den gespeicherten abweichen –
  // sonst bleiben die genaueren gespeicherten Koordinaten (und damit die berechneten Zeiten) erhalten.
  const near = (p, o) => p && o && Math.abs(p[0] - o[0]) < 2e-4 && Math.abs(p[1] - o[1]) < 2e-4;
  for (const l of ['A', 'B']) {
    const v = q.get(l.toLowerCase());
    const m = v?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const pt = [Number(m[2]), Number(m[1])];
    if (pt[1] > 51 && pt[1] < 54 && pt[0] > 12 && pt[0] < 15 && !near(pt, state.points[l])) {
      state.points[l] = pt;
      hadPoints = true;
    }
  }
  if (['bike', 'transit'].includes(q.get('m'))) state.mode = q.get('m');
  const t = Number(q.get('t'));
  if (t >= 10 && t <= 60) state.minutes = Math.round(t / 5) * 5;
  if (['approx', 'real'].includes(q.get('k'))) state.source = q.get('k');
  // Sets in place ändern – die Checkbox-Handler halten Referenzen darauf.
  const replace = (set, values) => { set.clear(); values.forEach((v) => set.add(v)); };
  if (q.has('f')) replace(state.forms, pick(q.get('f'), FORMS));
  if (q.has('abi')) replace(state.abi, pick(q.get('abi'), ABIS));
  if (q.has('tr')) replace(state.cost, pick(q.get('tr'), COSTS));
  if (q.has('gt')) replace(state.gt, pick(q.get('gt'), GT_VALUES));
  const sort = q.get('s');
  if (sort) {
    const key = sort.replace(/^-/, '');
    if (ALL_COLUMNS.some((c) => c.key === key)) { state.table.sort = key; state.table.dir = sort.startsWith('-') ? -1 : 1; }
  } else if (q.has('m')) {
    state.table.sort = 'max';
    state.table.dir = 1;
  }
  if (q.has('m')) state.table.onlyHits = !q.has('alle');
  saveJson(TABLE_KEY, state.table);
  if (hadPoints) savePoints();
  saveJson(SOURCE_KEY, { source: state.source });
  return hadPoints;
}

// Bedienelemente an den Zustand angleichen (nach Laden eines geteilten Links).
function syncControls() {
  document.querySelectorAll('input[name=mode]').forEach((el) => (el.checked = el.value === state.mode));
  document.querySelectorAll('input[name=source]').forEach((el) => (el.checked = el.value === state.source));
  $('minutes').value = state.minutes;
  $('minLabel').textContent = state.minutes;
  $('minutes').setAttribute('aria-valuetext', `${state.minutes} Minuten`);
  document.querySelectorAll('#formFilter input').forEach((el) => (el.checked = state.forms.has(el.value)));
  document.querySelectorAll('#abiFilter input').forEach((el) => (el.checked = state.abi.has(el.value)));
  document.querySelectorAll('#costFilter input').forEach((el) => (el.checked = state.cost.has(el.value)));
  document.querySelectorAll('#gtFilter input').forEach((el) => (el.checked = state.gt.has(el.value)));
  $('tableOnlyHits').checked = state.table.onlyHits;
}

const sharedWithPoints = applySharedHash();
syncControls();

initSplitters(() => { map.invalidateSize(); fitPopupHeights(); });

// ---------- Tabs (schmale Ansicht) ----------
const TAB_KEY = 'schulkarte.tab';
function showTab(id) {
  document.body.dataset.tab = id;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === id)));
  saveJson(TAB_KEY, { tab: id });
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
showTab(loadJson(TAB_KEY).tab ?? 'sidebar');
window.matchMedia('(max-width: 1099px)').addEventListener('change', () => setTimeout(() => { map.invalidateSize(); fitPopupHeights(); }, 50));

initTermine({ focusSchool, hasSchool: (n) => byName.has(n), highlight: highlightMarker, favs: state.favs });
for (const l of ['A', 'B']) if (state.points[l]) placePoint(l, state.points[l]);
if (!state.points.A) search.open('A');
function announceShared(withPoints) {
  if (withPoints) map.fitBounds(L.latLngBounds(setLabels().map((l) => [state.points[l][1], state.points[l][0]])).pad(0.6));
  toast(withPoints ? 'Geteilte Auswahl geladen – für genaue Zeiten „Fahrzeiten berechnen“ klicken' : 'Geteilte Auswahl geladen');
}
if (sharedWithPoints) announceShared(true);
// Link in einem schon offenen Tab eingefügt: ohne Neuladen übernehmen.
window.addEventListener('hashchange', () => {
  if (!location.hash.includes('=') || location.href === shareUrl(true)) return;
  const withPoints = applySharedHash();
  syncControls();
  for (const l of ['A', 'B']) if (state.points[l]) placePoint(l, state.points[l]);
  announceShared(withPoints);
  update();
});
renderSchools(); // sofort zeigen, Flächen kommen danach
update();
