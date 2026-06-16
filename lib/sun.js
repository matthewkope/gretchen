import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sunrise/sunset for the inbox header. The location is set once with
// /location <city> (geocoded via Open-Meteo, no API key) and stored in
// ~/.gretchen/location.json; the times themselves are computed locally,
// so no network is needed after setup.
const LOC_FILE = path.join(os.homedir(), '.gretchen', 'location.json');

let locCache; // undefined = not read yet, null = no location set
export function loadLocation() {
  if (locCache === undefined) {
    try {
      locCache = JSON.parse(fs.readFileSync(LOC_FILE, 'utf8'));
    } catch {
      locCache = null;
    }
  }
  return locCache;
}

export function saveLocation(loc) {
  fs.mkdirSync(path.dirname(LOC_FILE), { recursive: true });
  fs.writeFileSync(LOC_FILE, `${JSON.stringify(loc, null, 2)}\n`);
  locCache = loc;
}

export function clearLocation() {
  try {
    fs.unlinkSync(LOC_FILE);
  } catch {}
  locCache = null;
}

// city name → { name, lat, lon, tz } via the free Open-Meteo geocoder
export async function geocode(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoder returned ${res.status}`);
  const data = await res.json();
  const r = data.results?.[0];
  if (!r) return null;
  const name = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
  return { name, lat: r.latitude, lon: r.longitude, tz: r.timezone };
}

// NOAA sunrise equation (the classic Almanac for Computers algorithm).
// Returns { sunrise, sunset } as Dates, or null in polar day/night.
export function sunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const dayMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const N = Math.floor((dayMs - Date.UTC(date.getFullYear(), 0, 0)) / 86400000);
  const lngHour = lon / 15;

  const calc = (rising) => {
    const t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289; // sun's mean anomaly
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360; // true longitude
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = ((RA % 360) + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; // same quadrant as L
    RA /= 15; // right ascension, in hours
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    // zenith 90°50' — official sunrise/sunset
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null; // sun never rises/sets today
    const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    const T = H + RA - 0.06571 * t - 6.622;
    const UT = (((T - lngHour) % 24) + 24) % 24;
    return new Date(dayMs + UT * 3600000);
  };

  const sunrise = calc(true);
  const sunset = calc(false);
  return sunrise && sunset ? { sunrise, sunset } : null;
}

// "6:42 AM" in the location's own timezone (falls back to the machine's)
export function fmtSunTime(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
