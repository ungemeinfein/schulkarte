// Erreichbarkeitsbereiche. "approx": Kreise (immer, ohne Netz). "real": Valhalla (Rad) bzw. BVG-Haltestellen (ÖPNV).
import { circle } from '@turf/turf';
import { BIKE_KMH, bikeIsochrone, transitIsochrone } from './routing.js';

export const SPEED_KMH = { bike: BIKE_KMH, transit: 12 };

export function approxArea([lon, lat], mode, minutes) {
  const km = (SPEED_KMH[mode] * minutes) / 60;
  return circle([lon, lat], km, { steps: 96, units: 'kilometers' });
}

// Liefert { feature, source }; fällt bei Fehlern auf den Kreis zurück.
export async function reachArea(point, mode, minutes, source) {
  if (source !== 'real') return { feature: approxArea(point, mode, minutes), source: 'approx' };
  try {
    const feature = mode === 'bike' ? await bikeIsochrone(point, minutes) : await transitIsochrone(point, minutes);
    if (!feature) throw new Error('leere Isochrone');
    return { feature, source: mode === 'bike' ? 'valhalla' : 'bvg' };
  } catch (err) {
    console.warn('Isochrone fehlgeschlagen, nutze Näherung:', err);
    return { feature: approxArea(point, mode, minutes), source: 'approx-fallback' };
  }
}
