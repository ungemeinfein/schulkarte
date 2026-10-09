// Echte Fahrzeiten und Erreichbarkeitsflächen.
// Fahrrad: Valhalla (FOSSGIS-Server, ohne Key, max. 1 Anfrage/s).
// ÖPNV: v6.bvg.transport.rest (inoffizieller BVG-HAFAS-Proxy, ohne Key, max. 100 Anfragen/min).
// Datenschutz: Wohnorte werden vor dem Senden auf 3 Nachkommastellen (~100 m) gerundet;
// beim ÖPNV geht nur die nächste Haltestelle als Start raus, der Fußweg wird lokal geschätzt.
import { circle, distance, featureCollection, union } from '@turf/turf';

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const BVG = 'https://v6.bvg.transport.rest';

export const BIKE_KMH = 12; // Kind, Stadtverkehr (research/fahrrad_daten.md)
const BIKE_COSTING = { bicycle: { cycling_speed: BIKE_KMH, use_roads: 0.1, avoid_bad_surfaces: 0.5 } };
const WALK_M_PER_MIN = 75;
const WALK_DETOUR = 1.3; // Luftlinie → Fußweg
const MAX_TRANSIT_MIN = 60; // = Maximum des Zeit-Schiebereglers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rateLimited(ms) {
  let last = 0;
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(async () => {
      const wait = last + ms - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    tail = run.catch(() => {});
    return run;
  };
}
const valhallaQueue = rateLimited(1100);
const bvgQueue = rateLimited(650);

export const round = ([lon, lat]) => [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000];
export const pointKey = (p) => round(p).join(',');

// Abruf mit Zeitlimit und 2 Wiederholungen bei Überlast/Netzfehlern (die freien Dienste sind manchmal träge).
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
async function getJson(url, init) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1) ** 2); continue; }
      throw new Error(`${host} nicht erreichbar (${err.name})`);
    }
    if (res.ok) return res.json();
    if (RETRY_STATUS.has(res.status) && attempt < 2) { await sleep(2000 * (attempt + 1) ** 2); continue; }
    throw new Error(`${host} ${res.status}`);
  }
}

// ---------- Dauerhafter Zwischenspeicher (localStorage) ----------
// Haltestellen, erreichbare Haltestellen und Fahrrad-Flächen ändern sich kaum: einmal holen, dann aus dem Speicher.
// Nach MAX_AGE_DAYS wird neu geholt (Fahrplanwechsel im Dezember); schlägt das fehl, gilt der alte Stand weiter.
const STORE_KEY = 'schulkarte.netcache.v1';
const MAX_AGE_DAYS = 120;
let store = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { return {}; } })();
let storeTimer;
function storeSave() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      // Speicher voll: älteste Fahrrad-Flächen verwerfen und erneut versuchen.
      const iso = Object.entries(store).filter(([k]) => k.startsWith('bikeiso|')).sort((a, b) => a[1].t - b[1].t);
      for (const [k] of iso.slice(0, Math.ceil(iso.length / 2))) delete store[k];
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* dann eben nur im Speicher */ }
    }
  }, 300);
}
const fresh = (e) => e && Date.now() - e.t < MAX_AGE_DAYS * 864e5;
// Holt über fetcher(), wenn nichts Frisches gespeichert ist; bei Fehler alter Stand, falls vorhanden.
async function persisted(key, fetcher, pack = (v) => v, unpack = (v) => v) {
  const e = store[key];
  if (fresh(e)) return unpack(e.v);
  try {
    const v = await fetcher();
    store[key] = { t: Date.now(), v: pack(v) };
    storeSave();
    return v;
  } catch (err) {
    if (e) return unpack(e.v);
    throw err;
  }
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;

// Nächster Dienstag ab morgen, mit Berliner UTC-Offset (Sommer-/Winterzeit).
export function schoolDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const noon = new Date(`${date}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' })
    .formatToParts(noon).find((p) => p.type === 'timeZoneName').value; // "GMT+02:00"
  return { date, offset: tz.replace('GMT', '') || '+00:00' };
}

// ---------- Fahrrad ----------

const valhallaPost = (path, body, stale = () => false) => valhallaQueue(() => {
  if (stale()) throw new Error('veraltet');
  return getJson(`${VALHALLA}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// { [Schulname]: Minuten | null }
export async function bikeTimes(point, schools) {
  const [lon, lat] = round(point);
  const data = await valhallaPost('sources_to_targets', {
    sources: [{ lat, lon }],
    targets: schools.map((s) => ({ lat: s.lonLat[1], lon: s.lonLat[0] })),
    costing: 'bicycle',
    costing_options: BIKE_COSTING,
    units: 'km',
  });
  const row = data.sources_to_targets[0];
  return Object.fromEntries(schools.map((s, i) => [s.p.Schule, row[i]?.time == null ? null : Math.round(row[i].time / 60)]));
}

const bikeIsoCache = new Map();
const latestBikeReq = new Map(); // pointKey → zuletzt gewünschte Minuten
export function bikeIsochrone(point, minutes) {
  const key = `${pointKey(point)}|${minutes}`;
  latestBikeReq.set(pointKey(point), minutes);
  if (!bikeIsoCache.has(key)) {
    const [lon, lat] = round(point);
    // Veraltete Anfragen (Schieberegler weitergezogen) gar nicht erst senden.
    const stale = () => latestBikeReq.get(pointKey(point)) !== minutes;
    const p = persisted(`bikeiso|${key}`, () => valhallaPost('isochrone', {
      locations: [{ lat, lon }],
      costing: 'bicycle',
      costing_options: BIKE_COSTING,
      contours: [{ time: minutes }],
      polygons: true,
    }, stale).then((fc) => fc.features.find((f) => /Polygon/.test(f.geometry.type))), shrinkPolygon);
    p.catch(() => bikeIsoCache.delete(key));
    bikeIsoCache.set(key, p);
  }
  return bikeIsoCache.get(key);
}

// Fläche für die Speicherung verkleinern: 4 Nachkommastellen (~10 m), doppelte Punkte weg.
function shrinkPolygon(f) {
  if (!f) return f;
  const ring = (r) => r.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])
    .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  const g = f.geometry;
  const coordinates = g.type === 'Polygon' ? g.coordinates.map(ring) : g.coordinates.map((poly) => poly.map(ring));
  return { type: 'Feature', properties: {}, geometry: { type: g.type, coordinates } };
}

// ---------- ÖPNV ----------

const bvgGet = (path, params) => bvgQueue(() => getJson(`${BVG}${path}?${new URLSearchParams(params)}`));

const stopCache = new Map();
// Nächste Haltestelle zum (gerundeten) Punkt + geschätzter Fußweg dorthin.
export function nearestStop(point) {
  const key = pointKey(point);
  if (!stopCache.has(key)) {
    const [lon, lat] = round(point);
    const p = persisted(`stop|${key}`, () => bvgGet('/locations/nearby', { latitude: lat, longitude: lon, results: 5, distance: 1500, poi: false })
      .then((list) => {
        const stops = list.filter((l) => l.type === 'stop' || l.type === 'station').sort((a, b) => a.distance - b.distance);
        if (!stops.length) throw new Error('Keine Haltestelle in 1,5 km gefunden');
        const s = stops[0];
        return {
          id: s.id,
          name: s.name,
          location: [s.location.longitude, s.location.latitude],
          walkMin: Math.ceil((s.distance * WALK_DETOUR) / WALK_M_PER_MIN),
        };
      }));
    p.catch(() => stopCache.delete(key));
    stopCache.set(key, p);
  }
  return stopCache.get(key);
}

// Sehr nahe Schulen: HAFAS liefert oft keine Verbindung – dann (oder wenn schneller) zu Fuß.
function pickWalkIfBetter(ride, point, school) {
  const walk = Math.ceil((distance(round(point), school.lonLat, { units: 'meters' }) * WALK_DETOUR) / WALK_M_PER_MIN);
  if (walk <= 30 && (!ride || walk <= ride.min)) return { min: walk, lines: [], transfers: 0, stop: 'zu Fuß', walkMin: walk };
  return ride;
}

const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

// Linien für die Speicherung verkleinern: 5 Nachkommastellen, Punkte mit < ~20 m Abstand weglassen.
export function compress(coords) {
  const out = [];
  for (const [lat, lon] of coords) {
    const p = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
    const last = out.at(-1);
    if (!last || Math.abs(last[0] - p[0]) > 0.00018 || Math.abs(last[1] - p[1]) > 0.0003) out.push(p);
  }
  const end = coords.at(-1);
  if (end && out.length) out[out.length - 1] = [Math.round(end[0] * 1e5) / 1e5, Math.round(end[1] * 1e5) / 1e5];
  return out;
}

// Route-Abschnitte einer Verbindung: Fußweg zur Start-Haltestelle (Gerade) + alle Abschnitte mit Gleis-/Straßenverlauf.
function journeyLegs(journey, stop, point) {
  const home = round(point);
  const loc = (x) => {
    const l = x?.location ?? x;
    return l && Number.isFinite(l.latitude) ? [l.latitude, l.longitude] : null;
  };
  const legs = journey.legs.map((leg) => {
    const pts = leg.polyline?.features?.map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]) ?? [];
    const coords = compress(pts.length > 1 ? pts : [loc(leg.origin), loc(leg.destination)].filter(Boolean));
    return leg.walking ? { kind: 'walk', coords } : { kind: 'ride', line: leg.line?.name ?? '', coords };
  }).filter((l) => l.coords.length > 1);
  return [{ kind: 'walk', coords: [[home[1], home[0]], [stop.location[1], stop.location[0]]] }, ...legs];
}

// { [Schulname]: { min, lines, transfers, stop, walkMin } | null }; Ankunft bis 08:00 am nächsten Dienstag.
export async function transitTimes(point, schools, onProgress) {
  const stop = await nearestStop(point);
  const { date, offset } = schoolDay();
  const out = {};
  const routes = {};
  let done = 0;
  for (const s of schools) {
    try {
      const { journeys = [] } = await bvgGet('/journeys', {
        from: stop.id,
        'to.latitude': s.lonLat[1],
        'to.longitude': s.lonLat[0],
        'to.address': s.p.Schule,
        arrival: `${date}T08:00${offset}`,
        results: 3,
        polylines: true,
        stopovers: false,
        remarks: false,
      });
      const best = journeys
        .map((j) => ({ j, dur: minutesBetween(j.legs[0].departure ?? j.legs[0].plannedDeparture, j.legs.at(-1).arrival ?? j.legs.at(-1).plannedArrival) }))
        .sort((a, b) => a.dur - b.dur)[0];
      const lines = best ? best.j.legs.filter((l) => !l.walking && l.line).map((l) => l.line.name) : [];
      const ride = best ? { min: best.dur + stop.walkMin, lines, transfers: Math.max(0, lines.length - 1), stop: stop.name, walkMin: stop.walkMin } : null;
      out[s.p.Schule] = pickWalkIfBetter(ride, point, s);
      routes[s.p.Schule] = out[s.p.Schule]?.lines.length && best
        ? journeyLegs(best.j, stop, point)
        : [{ kind: 'walk', coords: [[round(point)[1], round(point)[0]], [s.lonLat[1], s.lonLat[0]]] }];
    } catch (err) {
      console.warn('ÖPNV-Abfrage fehlgeschlagen', s.p.Schule, err);
      out[s.p.Schule] = pickWalkIfBetter(null, point, s);
      if (out[s.p.Schule]) routes[s.p.Schule] = [{ kind: 'walk', coords: [[round(point)[1], round(point)[0]], [s.lonLat[1], s.lonLat[0]]] }];
    }
    onProgress?.(++done, schools.length);
  }
  return { date, stop: stop.name, walkMin: stop.walkMin, times: out, routes };
}

const reachCache = new Map();
function reachableStops(point) {
  const key = pointKey(point);
  if (!reachCache.has(key)) {
    const p = persisted(`reach|${key}|${MAX_TRANSIT_MIN}`, async () => {
      const stop = await nearestStop(point);
      const { date, offset } = schoolDay();
      const data = await bvgGet('/stops/reachable-from', {
        latitude: stop.location[1],
        longitude: stop.location[0],
        address: stop.name,
        when: `${date}T07:15${offset}`,
        maxDuration: MAX_TRANSIT_MIN,
      });
      const best = new Map(); // id → { duration, location }
      best.set(stop.id, { duration: 0, location: stop.location });
      for (const group of data.reachable ?? []) {
        for (const st of group.stations ?? group.stops ?? []) {
          const prev = best.get(st.id);
          if (!prev || group.duration < prev.duration) {
            best.set(st.id, { duration: group.duration, location: [st.location.longitude, st.location.latitude] });
          }
        }
      }
      return { stop, stops: [...best.values()] };
    },
    (v) => ({ stop: v.stop, s: v.stops.map((x) => [r5(x.location[0]), r5(x.location[1]), x.duration]) }),
    (v) => (v.s ? { stop: v.stop, stops: v.s.map(([lo, la, d]) => ({ location: [lo, la], duration: d })) } : v));
    p.catch(() => reachCache.delete(key));
    reachCache.set(key, p);
  }
  return reachCache.get(key);
}

// Fläche = Vereinigung von Fußweg-Kreisen um alle in der Restzeit erreichbaren Haltestellen.
// Ergebnis pro Punkt und Minuten zwischenspeichern; die Vereinigung kostet einige 100 ms.
const transitIsoCache = new Map();
export async function transitIsochrone(point, minutes) {
  const key = `${pointKey(point)}|${minutes}`;
  if (!transitIsoCache.has(key)) {
    const p = buildTransitIsochrone(point, minutes);
    p.catch(() => transitIsoCache.delete(key));
    transitIsoCache.set(key, p);
  }
  return transitIsoCache.get(key);
}

async function buildTransitIsochrone(point, minutes) {
  const { stop, stops } = await reachableStops(point);
  const budget = minutes - stop.walkMin;
  const candidates = stops
    .map((s) => ({ ...s, radius: Math.min(1000, (budget - s.duration) * WALK_M_PER_MIN / WALK_DETOUR) }))
    .filter((s) => s.radius >= 50)
    .sort((a, b) => b.radius - a.radius);
  // Kreise weglassen, die vollständig in einem größeren liegen.
  const kept = [];
  for (const s of candidates) {
    if (!kept.some((o) => distance(o.location, s.location, { units: 'meters' }) + s.radius <= o.radius)) kept.push(s);
  }
  const circles = kept.map((s) => circle(s.location, s.radius / 1000, { steps: 16, units: 'kilometers' }));
  // Startpunkt selbst (zu Fuß)
  const homeRadius = Math.min(1500, (minutes * WALK_M_PER_MIN) / WALK_DETOUR);
  circles.push(circle(round(point), homeRadius / 1000, { steps: 24, units: 'kilometers' }));
  return circles.length === 1 ? circles[0] : union(featureCollection(circles));
}

// ---------- Routen für die Kartenanzeige (auf Abruf beim Öffnen einer Schule) ----------

// Valhalla liefert Polyline6-kodierte Linien.
function decodePolyline6(str) {
  const coords = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    coords.push([lat / 1e6, lon / 1e6]);
  }
  return coords;
}

const routeCache = new Map();
const cached = (key, fn) => {
  if (!routeCache.has(key)) {
    const p = fn();
    p.catch(() => routeCache.delete(key));
    routeCache.set(key, p);
  }
  return routeCache.get(key);
};

// [{ kind: 'bike', coords: [[lat, lon], …] }]
export function bikeRoute(point, school) {
  return cached(`bike|${pointKey(point)}|${school.p.Schule}`, async () => {
    const [lon, lat] = round(point);
    const data = await valhallaPost('route', {
      locations: [{ lat, lon }, { lat: school.lonLat[1], lon: school.lonLat[0] }],
      costing: 'bicycle',
      costing_options: BIKE_COSTING,
      directions_options: { units: 'km' },
    });
    return [{ kind: 'bike', coords: compress(decodePolyline6(data.trip.legs[0].shape)) }];
  });
}

// [{ kind: 'walk' | 'ride', line?, product?, coords }] – Start an der nächsten Haltestelle, Fußweg dorthin als Gerade.
export function transitRoute(point, school) {
  return cached(`transit|${pointKey(point)}|${school.p.Schule}`, async () => {
    const stop = await nearestStop(point);
    const { date, offset } = schoolDay();
    const { journeys = [] } = await bvgGet('/journeys', {
      from: stop.id,
      'to.latitude': school.lonLat[1],
      'to.longitude': school.lonLat[0],
      'to.address': school.p.Schule,
      arrival: `${date}T08:00${offset}`,
      results: 3,
      polylines: true,
      stopovers: false,
      remarks: false,
    });
    const home = round(point);
    const best = journeys
      .map((j) => ({ j, dur: minutesBetween(j.legs[0].departure ?? j.legs[0].plannedDeparture, j.legs.at(-1).arrival ?? j.legs.at(-1).plannedArrival) }))
      .sort((a, b) => a.dur - b.dur)[0];
    if (!best) return [{ kind: 'walk', coords: [[home[1], home[0]], [school.lonLat[1], school.lonLat[0]]] }];
    return journeyLegs(best.j, stop, point);
  });
}

// Alle Fahrrad-Routen eines Ortes (für die Speicherung beim Berechnen).
export async function bikeRoutes(point, schools, onProgress) {
  const out = {};
  let done = 0;
  for (const s of schools) {
    try { out[s.p.Schule] = await bikeRoute(point, s); } catch { /* fehlt dann, wird beim Darüberfahren nachgeladen */ }
    onProgress?.(++done, schools.length);
  }
  return out;
}

// Nach dem Berechnen der Fahrzeiten: ÖPNV-Erreichbarkeit gleich mitholen und speichern (1 Anfrage pro Ort).
export function prefetchAreas(point) {
  return reachableStops(point).catch(() => {});
}
