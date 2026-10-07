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
const MAX_TRANSIT_MIN = 45;

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

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

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
    const p = valhallaPost('isochrone', {
      locations: [{ lat, lon }],
      costing: 'bicycle',
      costing_options: BIKE_COSTING,
      contours: [{ time: minutes }],
      polygons: true,
    }, stale).then((fc) => fc.features.find((f) => /Polygon/.test(f.geometry.type)));
    p.catch(() => bikeIsoCache.delete(key));
    bikeIsoCache.set(key, p);
  }
  return bikeIsoCache.get(key);
}

// ---------- ÖPNV ----------

const bvgGet = (path, params) => bvgQueue(() => getJson(`${BVG}${path}?${new URLSearchParams(params)}`));

const stopCache = new Map();
// Nächste Haltestelle zum (gerundeten) Punkt + geschätzter Fußweg dorthin.
export function nearestStop(point) {
  const key = pointKey(point);
  if (!stopCache.has(key)) {
    const [lon, lat] = round(point);
    const p = bvgGet('/locations/nearby', { latitude: lat, longitude: lon, results: 5, distance: 1500, poi: false })
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
      });
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

// { [Schulname]: { min, lines, transfers, stop, walkMin } | null }; Ankunft bis 08:00 am nächsten Dienstag.
export async function transitTimes(point, schools, onProgress) {
  const stop = await nearestStop(point);
  const { date, offset } = schoolDay();
  const out = {};
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
        stopovers: false,
        remarks: false,
      });
      const best = journeys
        .map((j) => ({ j, dur: minutesBetween(j.legs[0].departure ?? j.legs[0].plannedDeparture, j.legs.at(-1).arrival ?? j.legs.at(-1).plannedArrival) }))
        .sort((a, b) => a.dur - b.dur)[0];
      const lines = best ? best.j.legs.filter((l) => !l.walking && l.line).map((l) => l.line.name) : [];
      const ride = best ? { min: best.dur + stop.walkMin, lines, transfers: Math.max(0, lines.length - 1), stop: stop.name, walkMin: stop.walkMin } : null;
      out[s.p.Schule] = pickWalkIfBetter(ride, point, s);
    } catch (err) {
      console.warn('ÖPNV-Abfrage fehlgeschlagen', s.p.Schule, err);
      out[s.p.Schule] = pickWalkIfBetter(null, point, s);
    }
    onProgress?.(++done, schools.length);
  }
  return { date, stop: stop.name, walkMin: stop.walkMin, times: out };
}

const reachCache = new Map();
function reachableStops(point) {
  const key = pointKey(point);
  if (!reachCache.has(key)) {
    const p = (async () => {
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
    })();
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
