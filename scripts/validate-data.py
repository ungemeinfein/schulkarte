"""Prüft die Datendateien, bevor ein automatischer Daten-PR gemergt wird.

Aufruf: python3 scripts/validate-data.py <basis-csv>
<basis-csv> ist data/schulen.csv aus main (zum Vergleich: keine Schule darf verschwinden).
"""
import csv, json, re, sys

errors = []
def check(cond, msg):
    if not cond:
        errors.append(msg)

rows = list(csv.DictReader(open('data/schulen.csv', encoding='utf-8-sig')))
names = [r['Schule'] for r in rows]
check(len(names) == len(set(names)), 'doppelte Schule-Namen')
bsn = [r['Schulnummer'] for r in rows if r['Schulnummer']]
check(len(bsn) == len(set(bsn)), 'doppelte Schulnummern')
for r in rows:
    n = r['Schule']
    check(r['Abitur vor Ort'] in ('ja', 'im Aufbau', 'nein', 'unklar'), f'{n}: Abitur vor Ort = {r["Abitur vor Ort"]!r}')
    check(re.search(r'Gymnasium|Integrierte Sekundarschule|Gemeinschaftsschule|Waldorf|Montessori|Freie Alternativschule|Freie Schule|Ersatzschule|Gesamtschule', r['Schulform']), f'{n}: Schulform unbekannt')
    check(r['Adresse'].strip() != '', f'{n}: Adresse fehlt')
    for col in ('Quelle', 'Schülerzahl Quelle'):
        check(r.get(col, '') == '' or r[col].startswith('https://'), f'{n}: {col} ist keine https-URL')
    total, jg7 = r.get('Schülerzahl', ''), r.get('Schüler Jg. 7', '')
    check(total == '' or total.isdigit(), f'{n}: Schülerzahl keine Zahl')
    check(jg7 == '' or jg7.isdigit(), f'{n}: Schüler Jg. 7 keine Zahl')
    if total.isdigit() and jg7.isdigit():
        check(int(jg7) <= int(total), f'{n}: Jg. 7 > Schülerzahl')

if len(sys.argv) > 1:
    base = {r['Schule'] for r in csv.DictReader(open(sys.argv[1], encoding='utf-8-sig'))}
    gone = base - set(names)
    check(not gone, f'Schulen verschwunden: {sorted(gone)}')

# Karte: jede Schule braucht einen Punkt im Großraum Berlin
geo = json.load(open('public/schulen.geojson', encoding='utf-8'))
feats = {f['properties']['Schule']: f['geometry']['coordinates'] for f in geo['features']}
check(set(feats) == set(names), f'schulen.geojson passt nicht zur CSV: {sorted(set(names) ^ set(feats))}')
for n, (lon, lat) in feats.items():
    check(12.9 <= lon <= 14.2 and 52.2 <= lat <= 52.75, f'{n}: Koordinate außerhalb des Gebiets')

# Termine
ev = json.load(open('data/termine.json', encoding='utf-8'))
starts = [e['start'] for e in ev]
check(starts == sorted(starts), 'termine.json nicht nach start sortiert')
for e in ev:
    s = e.get('schule')
    for n in ([s] if isinstance(s, str) else s):
        check(n == 'Allgemein' or n in names, f'Termin mit unbekannter Schule: {n}')
    check(e.get('art') in ('tdot', 'info', 'schnupper', 'frist'), f'Termin mit art {e.get("art")!r}')
    check(re.fullmatch(r'\d{4}-\d\d-\d\d(T\d\d:\d\d)?', e.get('start', '')), f'Termin mit start {e.get("start")!r}')
    check(str(e.get('quelle', '')).startswith('https://'), f'Termin ohne https-Quelle: {e.get("titel")}')
    check(e.get('titel'), 'Termin ohne Titel')

# Prüf-Protokoll: jede Schule genau einmal, Daten im ISO-Format
led = json.load(open('data/pruefung.json', encoding='utf-8'))
check(set(led) == set(names), f'pruefung.json passt nicht zur CSV: {sorted(set(names) ^ set(led))}')
for n, v in led.items():
    for k in ('termine', 'schuldaten'):
        check(v.get(k) is None or re.fullmatch(r'\d{4}-\d\d-\d\d', v[k]), f'{n}: pruefung.{k} = {v.get(k)!r}')

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'OK: {len(rows)} Schulen, {len(ev)} Termine')
