// Geocodiert data/schulen.csv einmalig über Nominatim und schreibt public/schulen.geojson.
// Bereits geocodierte Schulen (gleiche Adresse) werden aus dem Cache übernommen.
// Nominatim-Policy: max. 1 Request/s, eigener User-Agent.
import fs from 'node:fs';
import Papa from 'papaparse';

const CSV = 'data/schulen.csv';
const OUT = 'public/schulen.geojson';
const OVERRIDES = 'data/geocode-overrides.json'; // optional: { "Schule": [lon, lat] }
const UA = 'schulkarte/0.1 (https://github.com/ungemeinfein/schulkarte)';
const BERLIN_VIEWBOX = '13.08,52.68,13.77,52.33';

const csv = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '');
const rows = Papa.parse(csv, { header: true, skipEmptyLines: true }).data;

const cache = new Map();
if (fs.existsSync(OUT)) {
  for (const f of JSON.parse(fs.readFileSync(OUT, 'utf8')).features) {
    cache.set(f.properties.Adresse, f.geometry.coordinates);
  }
}
const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};

// "Hoernlestraße 80 und Mittelheide 49, 12555 Berlin" -> "Hoernlestraße 80, 12555 Berlin"
// "Uranusstraße 15-17, …" -> "Uranusstraße 15, …"; Klammerzusätze entfernen.
function cleanAddress(addr) {
  let a = addr.replace(/\(.*?\)/g, '').trim();
  const plz = a.match(/\b\d{5}\b/)?.[0];
  a = a.split(/\s+und\s+/)[0].split(',')[0];
  a = a.replace(/(\d+)\s*[-/]\s*\d+/, '$1');
  return `${a}, ${plz ? plz + ' ' : ''}Berlin`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(q) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    q, format: 'jsonv2', limit: '1', countrycodes: 'de', viewbox: BERLIN_VIEWBOX, bounded: '1',
  });
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  return hit ? [Number(hit.lon), Number(hit.lat)] : null;
}

const features = [];
const failed = [];
for (const row of rows) {
  let coords = overrides[row.Schule] ?? cache.get(row.Adresse);
  if (!coords) {
    const q = cleanAddress(row.Adresse);
    coords = await geocode(q);
    console.log(`${coords ? '✓' : '✗'} ${row.Schule}  ←  ${q}`);
    await sleep(1100);
  }
  if (!coords) { failed.push(row.Schule); continue; }
  features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: row });
}

fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }, null, 1));
console.log(`\n${features.length} Schulen → ${OUT}`);
if (failed.length) console.log(`Nicht gefunden (in ${OVERRIDES} eintragen): ${failed.join(', ')}`);
