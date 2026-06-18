import { loadLocation } from './sun.js';

// Today's hourly UV index for the saved location, from the free Open-Meteo
// forecast API (no API key). The location is the one set with /location and
// stored in ~/.gretchen/location.json; if none is set we report `located:false`
// and the home card shows a "set location" prompt.

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// WHO UV exposure categories — drive the colour + advice on the card
export function uvCategory(uv) {
  if (uv == null) return null;
  if (uv < 3) return 'low';
  if (uv < 6) return 'moderate';
  if (uv < 8) return 'high';
  if (uv < 11) return 'very high';
  return 'extreme';
}

// the current hour (0–23) in a given IANA timezone, falling back to local
function hourInTz(tz) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date());
    return Number(s) % 24;
  } catch {
    return new Date().getHours();
  }
}

// Fetch today's hourly UV. Returns a plain object ready for the client:
//   { located, place, date, nowHour, hours:[{hour, uv}], now, peak, peakHour }
// or { located:false } when no location is set. Throws on network errors so
// the caller can cache an { error } sentinel, mirroring the Oura flow.
export async function fetchUv() {
  const loc = loadLocation();
  if (!loc) return { located: false };
  const tz = loc.tz || 'auto';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=uv_index&timezone=${encodeURIComponent(tz)}&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UV API returned ${res.status}`);
  const data = await res.json();
  const times = data.hourly?.time || [];
  const vals = data.hourly?.uv_index || [];
  const hours = times.map((t, i) => ({ hour: Number(t.slice(11, 13)), uv: round1(vals[i]) }));

  const nowHour = hourInTz(tz);
  let peak = null;
  for (const h of hours) if (h.uv != null && (!peak || h.uv > peak.uv)) peak = h;
  const nowEntry = hours.find((h) => h.hour === nowHour);

  return {
    located: true,
    place: loc.name ? loc.name.split(',')[0] : null,
    date: times[0] ? times[0].slice(0, 10) : null, // the forecast's local date
    nowHour,
    now: nowEntry ? nowEntry.uv : null,
    peak: peak ? peak.uv : null,
    peakHour: peak ? peak.hour : null,
    hours,
  };
}
