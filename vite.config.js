import { defineConfig } from 'vite';

// base './': läuft auch unter einem Unterpfad (GitHub Pages).
export default defineConfig({ base: './', build: { target: 'es2022' } });
