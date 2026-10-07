export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Nur https-Links aus den Daten zulassen (kein javascript: o. ä.).
export function safeUrl(u) {
  try {
    return new URL(u).protocol === 'https:' ? u : '';
  } catch {
    return '';
  }
}
