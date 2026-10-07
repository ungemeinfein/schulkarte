// Termine-Spalte: chronologische Liste aus data/termine.json mit .ics-Download.
import termine from '../data/termine.json';
import { downloadIcs, parseLocal, schoolNames } from './ics.js';
import { safeUrl } from './util.js';

const STORAGE_KEY = 'schulkarte.termine.v2';
const ART_LABEL = { tdot: 'Offene Tür', info: 'Infoabend', schnupper: 'Schnuppern', frist: 'Frist' };
const ARTS = Object.keys(ART_LABEL);
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const $ = (id) => document.getElementById(id);

const prefs = loadPrefs();
let ctx = { hitNames: null, focusSchool: () => false, hasSchool: () => false, highlight: () => {} };

function dayKey(s) {
  return s.slice(0, 10);
}

function todayKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function filtered() {
  const today = todayKey();
  return termine
    .filter((t) => prefs.arts[t.art] !== false)
    .filter((t) => prefs.past || dayKey(t.ende ?? t.start) >= today)
    .filter((t) => {
      if (!prefs.onlyHits || !ctx.hitNames) return true;
      return t.schule === 'Allgemein' || schoolNames(t).some((n) => ctx.hitNames.has(n));
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

function timeText(t) {
  const s = parseLocal(t.start);
  if (s.allDay) {
    if (t.ende && t.ende !== t.start) {
      const e = parseLocal(t.ende);
      return `bis ${String(e.d).padStart(2, '0')}.${String(e.m).padStart(2, '0')}.`;
    }
    return 'ganztägig';
  }
  const hm = (p) => `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  return t.ende ? `${hm(s)}–${hm(parseLocal(t.ende))}` : `ab ${hm(s)}`;
}

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
}

export function render() {
  const list = filtered();
  const today = todayKey();
  const ul = $('termList');
  ul.replaceChildren();
  let month = null;

  for (const t of list) {
    const p = parseLocal(t.start);
    const mKey = `${p.y}-${p.m}`;
    if (mKey !== month) {
      month = mKey;
      const h = document.createElement('li');
      h.className = 'month';
      h.textContent = `${MONTHS[p.m - 1]} ${p.y}`;
      ul.append(h);
    }
    const wd = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
    const past = dayKey(t.ende ?? t.start) < today;
    const names = schoolNames(t);

    const li = document.createElement('li');
    const art = ARTS.includes(t.art) ? t.art : 'info';
    const quelle = safeUrl(t.quelle);
    li.className = `ev art-${art}${past ? ' past' : ''}${dayKey(t.start) === today ? ' today' : ''}`;
    li.innerHTML = `
      <div class="ev-date">
        <span class="wd">${wd}</span><span class="dm">${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}.</span>
        ${past ? '<span class="past-tag">vorbei</span>' : ''}
      </div>
      <div class="ev-body">
        <div class="ev-school"></div>
        <div class="ev-title"><span class="art">${ART_LABEL[art]}</span> <span class="tt"></span></div>
        <div class="ev-meta">${timeText(t)}</div>
        ${t.hinweis ? '<div class="ev-note"></div>' : ''}
      </div>
      <div class="ev-actions">
        <button type="button" class="ics btn">Kalender</button>
        ${quelle ? '<a class="src" target="_blank" rel="noopener">Quelle<span class="sr-only"> (neuer Tab)</span> ↗</a>' : ''}
      </div>`;

    const schoolEl = li.querySelector('.ev-school');
    names.forEach((n, i) => {
      if (i) schoolEl.append(' · ');
      if (ctx.hasSchool(n)) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: n, title: 'Auf der Karte zeigen' });
        b.onclick = () => ctx.focusSchool(n);
        schoolEl.append(b);
      } else {
        schoolEl.append(n);
      }
    });
    li.dataset.schools = JSON.stringify(names);
    li.onmouseenter = () => names.forEach((n) => ctx.highlight(n, true));
    li.onmouseleave = () => names.forEach((n) => ctx.highlight(n, false));
    li.querySelector('.tt').textContent = t.titel;
    if (t.hinweis) li.querySelector('.ev-note').textContent = t.hinweis;
    if (quelle) li.querySelector('.src').href = quelle;
    li.querySelector('.ics').setAttribute('aria-label', `${names.join(', ')}: ${t.titel} am ${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}. in den Kalender übernehmen (.ics)`);
    li.querySelector('.ics').onclick = () => downloadIcs([t], `${t.start.slice(0, 10)}_${slug(names.join('_'))}.ics`);
    ul.append(li);
  }

  if (!list.length) {
    const li = Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Keine Termine für diese Auswahl. Filter oben anpassen.' });
    ul.append(li);
  }
  $('termCount').textContent = list.length;
  $('termAll').disabled = list.length === 0;
  $('termAll').onclick = () => downloadIcs(list, `schultermine_${today}.ics`);
  $('termOnlyHits').disabled = !ctx.hitNames;
}

export function initTermine(context) {
  ctx = { ...ctx, ...context };
  document.querySelectorAll('#termFilters input[data-art]').forEach((el) => {
    el.checked = prefs.arts[el.dataset.art] !== false;
    el.addEventListener('change', () => { prefs.arts[el.dataset.art] = el.checked; savePrefs(); render(); });
  });
  for (const [id, key] of [['termOnlyHits', 'onlyHits'], ['termPast', 'past']]) {
    $(id).checked = prefs[key];
    $(id).addEventListener('change', (e) => { prefs[key] = e.target.checked; savePrefs(); render(); });
  }
  render();
}

// Nächster anstehender Termin je Schule – einmal beim Laden indiziert.
const nextByName = new Map();
{
  const today = todayKey();
  for (const t of [...termine].sort((a, b) => a.start.localeCompare(b.start))) {
    if (dayKey(t.ende ?? t.start) < today) continue;
    for (const n of schoolNames(t)) if (!nextByName.has(n)) nextByName.set(n, t);
  }
}
export const nextEventFor = (name) => nextByName.get(name) ?? null;

// Wird von main.js aufgerufen, wenn sich die Treffer ändern (null = keine Bereiche gesetzt).
let lastSig;
export function setHits(hitNames) {
  const sig = hitNames ? [...hitNames].sort().join('|') : '∅';
  if (sig === lastSig) return;
  lastSig = sig;
  ctx.hitNames = hitNames;
  render();
}

function loadPrefs() {
  const base = { arts: {}, onlyHits: true, past: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return base;
  }
}
function savePrefs() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* egal */ }
}
