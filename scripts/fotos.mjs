// Holt zu den in data/fotos-auswahl.json ausgewählten Wikimedia-Commons-Dateien
// Vorschau-URL, Urheber und Lizenz und schreibt public/fotos.json.
// Nur frei lizenzierte Commons-Fotos; Bilder werden von upload.wikimedia.org geladen.
import fs from 'node:fs';

const UA = 'schulkarte/0.1 (https://github.com/ungemeinfein/schulkarte)';
const auswahl = JSON.parse(fs.readFileSync('data/fotos-auswahl.json', 'utf8'));
const schulen = new Map(JSON.parse(fs.readFileSync('public/schulen.geojson', 'utf8')).features.map((f) => [f.properties.Schule, f.geometry.coordinates]));

const strip = (html = '') => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const distM = ([lon1, lat1], [lon2, lat2]) => {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.round(Math.sqrt(x * x + y * y) * 6371000);
};

const out = {};
for (const [schule, files] of Object.entries(auswahl)) {
  if (!schulen.has(schule)) throw new Error(`Unbekannte Schule: ${schule}`);
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query', format: 'json', prop: 'imageinfo|coordinates', iiprop: 'url|extmetadata', iiurlwidth: '640',
    titles: files.map((f) => `File:${f}`).join('|'),
  });
  const data = await (await fetch(u, { headers: { 'User-Agent': UA } })).json();
  const pages = Object.values(data.query.pages);
  out[schule] = files.map((f) => {
    const p = pages.find((x) => x.title.replace(/^File:/, '') === f.replace(/_/g, ' ') || data.query.normalized?.some((n) => n.to === x.title && n.from === `File:${f}`));
    if (!p || !p.imageinfo) { console.warn(`✗ fehlt: ${f}`); return null; }
    const ii = p.imageinfo[0];
    const m = ii.extmetadata ?? {};
    const coord = p.coordinates?.[0];
    const dist = coord ? distM(schulen.get(schule), [coord.lon, coord.lat]) : null;
    console.log(`${dist == null ? '   ?' : String(dist).padStart(4)} m  ${m.LicenseShortName?.value ?? '?'}  ${schule} ← ${f}`);
    return {
      thumb: ii.thumburl,
      page: ii.descriptionurl,
      author: strip(m.Artist?.value) || 'unbekannt',
      license: m.LicenseShortName?.value ?? '',
      licenseUrl: m.LicenseUrl?.value ?? '',
      title: strip(m.ImageDescription?.value).slice(0, 140) || f.replace(/\.[a-z]+$/i, ''),
    };
  }).filter(Boolean);
  await new Promise((r) => setTimeout(r, 300));
}
fs.writeFileSync('public/fotos.json', JSON.stringify(out, null, 1));
console.log(`\n${Object.keys(out).length} Schulen mit Fotos → public/fotos.json`);
