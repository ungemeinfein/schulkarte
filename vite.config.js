import { defineConfig } from 'vite';

// base './': läuft auch unter einem Unterpfad (GitHub Pages).
// __BUILD_ID__: Versionsstempel, damit Datendateien nach einem Update nicht aus dem Browser-Cache kommen.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
});
