import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';

// Datum der letzten Änderung einer Datendatei (letzter Git-Commit, sonst Dateidatum).
function lastChanged(file) {
  try {
    const d = execSync(`git log -1 --format=%cs -- ${file}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (d) return d;
  } catch {}
  try { return statSync(file).mtime.toISOString().slice(0, 10); } catch { return ''; }
}

// base './': läuft auch unter einem Unterpfad (GitHub Pages).
// __BUILD_ID__: Versionsstempel, damit Datendateien nach einem Update nicht aus dem Browser-Cache kommen.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __STAND__: JSON.stringify({ termine: lastChanged('data/termine.json'), schulen: lastChanged('data/schulen.csv') }),
  },
});
