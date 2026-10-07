// Minimaler iCalendar-Export (RFC 5545) für Termine aus data/termine.json.
// Zeiten sind lokal (Europe/Berlin) und werden mit TZID + VTIMEZONE geschrieben.

const DEFAULT_DURATION_MIN = 120;

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// "2026-11-07T10:00" | "2026-11-07" -> { y, m, d, hh, mm, allDay }
export function parseLocal(s) {
  const [date, time] = s.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time ? time.split(':').map(Number) : [0, 0];
  return { y, m, d, hh, mm, allDay: !time };
}

// Rechnen über UTC, damit die Zeitzone des Browsers keine Rolle spielt.
function shift(p, minutes) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) + minutes * 60000);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    hh: t.getUTCHours(), mm: t.getUTCMinutes(), allDay: p.allDay,
  };
}

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (p) => `${p.y}${pad(p.m)}${pad(p.d)}`;
const icsDateTime = (p) => `${icsDate(p)}T${pad(p.hh)}${pad(p.mm)}00`;

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Zeilen > 75 Oktette falten (UTF-8-sicher, Faltung nur zwischen Zeichen).
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h.toString(36);
}

export function schoolNames(t) {
  return Array.isArray(t.schule) ? t.schule : [t.schule];
}

function vevent(t, stamp) {
  const start = parseLocal(t.start);
  const names = schoolNames(t).join(' / ');
  const lines = ['BEGIN:VEVENT', `UID:${hash(names + t.titel + t.start)}@schulkarte.local`, `DTSTAMP:${stamp}`];

  const desc = [];
  if (start.allDay) {
    const end = shift(parseLocal(t.ende ?? t.start), 24 * 60); // DTEND exklusiv
    lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(end)}`);
  } else {
    const end = t.ende ? parseLocal(t.ende) : shift(start, DEFAULT_DURATION_MIN);
    if (!t.ende) desc.push('Ende unbekannt (2 h angenommen).');
    lines.push(`DTSTART;TZID=Europe/Berlin:${icsDateTime(start)}`, `DTEND;TZID=Europe/Berlin:${icsDateTime(end)}`);
  }
  if (t.hinweis) desc.push(t.hinweis);
  if (t.quelle) desc.push(`Quelle: ${t.quelle}`);

  lines.push(`SUMMARY:${escapeText(`${names}: ${t.titel}`)}`);
  if (t.ort) lines.push(`LOCATION:${escapeText(t.ort)}`);
  if (desc.length) lines.push(`DESCRIPTION:${escapeText(desc.join('\n'))}`);
  if (t.quelle) lines.push(`URL:${t.quelle}`);
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(termine) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//schulkarte//local//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...VTIMEZONE,
    ...termine.flatMap((t) => vevent(t, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadIcs(termine, filename) {
  const blob = new Blob([buildIcs(termine)], { type: 'text/calendar;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
