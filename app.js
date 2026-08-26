const $ = (id) => document.getElementById(id);

const state = {
  place: null,
  forecast: null,
  days: [],
  selectedDay: 0,
  debounce: null,
  lastQuery: "",
  cacheKey: "klev:last-state"
};

const API = {
  geocode: "https://geocoding-api.open-meteo.com/v1/search",
  weather: "https://api.open-meteo.com/v1/forecast"
};

const ruDays = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
const ruMonths = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function rad(x) { return x * Math.PI / 180; }
function deg(x) { return x * 180 / Math.PI; }
function norm360(x) { x %= 360; return x < 0 ? x + 360 : x; }
function pad(n) { return String(n).padStart(2, "0"); }
function fmtHour(h) { return `${pad(h)}:00`; }
function localDateISO(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(date).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateAddISO(iso, delta) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0,10);
}
function fmtTemp(v) { return `${Math.round(v)}°`; }
function fmtPressure(v) { return `${Math.round(v)} hPa`; }
function windMS(vKmh) { return vKmh / 3.6; }
function scoreCategory(v) {
  if (v < 25) return ["Слабый клёв", "слабый"];
  if (v < 50) return ["Средний клёв", "средний"];
  if (v < 75) return ["Хороший клёв", "хороший"];
  return ["Отличный клёв", "отличный"];
}
function weatherCodeText(code) {
  if ([95,96,99].includes(code)) return "гроза";
  if ([51,53,55,61,63,65,66,67,80,81,82].includes(code)) return "осадки";
  if ([1,2].includes(code)) return "переменная облачность";
  if (code === 3) return "пасмурно";
  if (code === 0) return "ясно";
  return "спокойная погода";
}
function weatherCodeIsStorm(code) { return [95,96,99].includes(code); }
function isLightRain(record) { return record.precip > 0 && record.precip <= 2 && !weatherCodeIsStorm(record.code); }

function setLoading(v) {
  $("loadingCard").classList.toggle("hidden", !v);
  if (v) {
    $("errorCard").classList.add("hidden");
    $("forecastView").classList.add("hidden");
  }
}
function setError(message) {
  $("loadingCard").classList.add("hidden");
  $("forecastView").classList.add("hidden");
  $("errorCard").classList.remove("hidden");
  $("errorText").textContent = message;
}

function updateNetwork() {
  const online = navigator.onLine;
  $("networkStatus").textContent = online ? "онлайн" : "офлайн";
  $("networkStatus").classList.toggle("offline", !online);
}
window.addEventListener("online", updateNetwork);
window.addEventListener("offline", updateNetwork);

async function geocode(name) {
  const key = `klev-geocode:${name.trim().toLowerCase()}`;
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const url = new URL(API.geocode);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "6");
  url.searchParams.set("language", "ru");
  url.searchParams.set("format", "json");
  const response = await fetch(url);
  if (!response.ok) throw new Error("Не удалось выполнить поиск населённого пункта.");
  const data = await response.json();
  const results = (data.results || []).map(x => ({
    id: x.id,
    name: x.name,
    country: x.country || "",
    admin1: x.admin1 || "",
    latitude: x.latitude,
    longitude: x.longitude,
    timezone: x.timezone
  }));
  sessionStorage.setItem(key, JSON.stringify(results));
  return results;
}

function suggestionLabel(x) {
  const right = [x.admin1, x.country].filter(Boolean).join(", ");
  return {name: x.name, meta: right || x.timezone || `${x.latitude.toFixed(2)}, ${x.longitude.toFixed(2)}`};
}
function renderSuggestions(results) {
  const box = $("suggestions");
  box.innerHTML = "";
  if (!results.length) { box.classList.remove("open"); return; }
  results.forEach((x, i) => {
    const b = document.createElement("button");
    b.className = "suggestion";
    b.type = "button";
    b.setAttribute("role", "option");
    const l = suggestionLabel(x);
    b.innerHTML = `<div class="suggestion-name">${escapeHtml(l.name)}</div><div class="suggestion-meta">${escapeHtml(l.meta)}</div>`;
    b.addEventListener("click", () => selectPlace(x));
    box.appendChild(b);
  });
  box.classList.add("open");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function handleSearchInput() {
  const q = $("placeInput").value.trim();
  $("suggestions").classList.remove("open");
  clearTimeout(state.debounce);
  if (q.length < 2 || q === state.lastQuery) return;
  state.lastQuery = q;
  state.debounce = setTimeout(async () => {
    try {
      const results = await geocode(q);
      renderSuggestions(results);
    } catch (e) {
      console.warn(e);
    }
  }, 450);
}

async function selectPlace(place) {
  $("suggestions").classList.remove("open");
  $("placeInput").value = place.name;
  state.place = place;
  state.selectedDay = 0;
  $("locationMeta").textContent = [place.admin1, place.country].filter(Boolean).join(", ") || `координаты ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`;
  await loadForecast(place.latitude, place.longitude, place);
}

async function useGeolocation() {
  if (!navigator.geolocation) {
    setError("Браузер не поддерживает геолокацию.");
    return;
  }
  setLoading(true);
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const place = {
        id: "gps",
        name: "Моё местоположение",
        country: "",
        admin1: "",
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        timezone: "auto"
      };
      $("placeInput").value = "Моё местоположение";
      $("locationMeta").textContent = `координаты ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`;
      state.place = place;
      try {
        await loadForecast(place.latitude, place.longitude, place);
      } catch (e) {}
    },
    err => {
      setError(err.code === 1 ? "Доступ к геолокации запрещён. Разрешите его в настройках браузера." : "Не удалось определить координаты.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
  );
}

async function fetchWeather(lat, lon) {
  const url = new URL(API.weather);
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("past_days", "1");
  url.searchParams.set("forecast_days", "4");
  url.searchParams.set("hourly", [
    "temperature_2m",
    "surface_pressure",
    "wind_speed_10m",
    "precipitation",
    "cloud_cover",
    "weather_code"
  ].join(","));
  url.searchParams.set("current", [
    "temperature_2m",
    "surface_pressure",
    "wind_speed_10m",
    "cloud_cover",
    "weather_code"
  ].join(","));
  const response = await fetch(url);
  if (!response.ok) throw new Error("Погодный сервис временно недоступен.");
  return response.json();
}

/* ---------- Астрономический слой ----------
   Небольшая детерминированная лунно-солнечная аппроксимация для PWA.
   Она достаточна для построения окон активности и не использует ML.
*/

function julianDay(date) { return date.getTime() / 86400000 + 2440587.5; }

function sunPosition(date, lat, lon) {
  const jd = julianDay(date), d = jd - 2451543.5;
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.0470 + 0.9856002585 * d);
  const E = M + deg(e) * Math.sin(rad(M)) * (1 + e * Math.cos(rad(M)));
  const xv = Math.cos(rad(E)) - e;
  const yv = Math.sqrt(1 - e*e) * Math.sin(rad(E));
  const v = deg(Math.atan2(yv, xv));
  const lonSun = norm360(v + w);
  return celestialToAltAz(date, lon, lat, lonSun, 0);
}

function moonEcliptic(date) {
  const jd = julianDay(date), d = jd - 2451543.5;
  const N = 125.1228 - 0.0529538083 * d;
  const i = 5.1454;
  const w = 318.0634 + 0.1643573223 * d;
  const a = 60.2666;
  const e = 0.0549;
  const M = norm360(115.3654 + 13.0649929509 * d);

  const E = M + deg(e) * Math.sin(rad(M)) * (1 + e * Math.cos(rad(M)));
  const xv = a * (Math.cos(rad(E)) - e);
  const yv = a * Math.sqrt(1 - e*e) * Math.sin(rad(E));
  const v = deg(Math.atan2(yv, xv));
  const r = Math.sqrt(xv*xv + yv*yv);
  const xh = r * (Math.cos(rad(N)) * Math.cos(rad(v+w)) - Math.sin(rad(N)) * Math.sin(rad(v+w)) * Math.cos(rad(i)));
  const yh = r * (Math.sin(rad(N)) * Math.cos(rad(v+w)) + Math.cos(rad(N)) * Math.sin(rad(v+w)) * Math.cos(rad(i)));
  const zh = r * Math.sin(rad(v+w)) * Math.sin(rad(i));
  const lon = norm360(deg(Math.atan2(yh, xh)));
  const lat = deg(Math.atan2(zh, Math.sqrt(xh*xh + yh*yh)));
  return { lon, lat, r };
}

function sunEclipticLongitude(date) {
  const jd = julianDay(date), d = jd - 2451543.5;
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.0470 + 0.9856002585 * d);
  const E = M + deg(e) * Math.sin(rad(M)) * (1 + e * Math.cos(rad(M)));
  const xv = Math.cos(rad(E)) - e;
  const yv = Math.sqrt(1-e*e) * Math.sin(rad(E));
  const v = deg(Math.atan2(yv,xv));
  return norm360(v+w);
}

function celestialToAltAz(date, lon, lat, eclLon, eclLat) {
  const eps = 23.4393 - 3.563e-7 * (julianDay(date)-2451543.5);
  const x = Math.cos(rad(eclLon)) * Math.cos(rad(eclLat));
  const y = Math.sin(rad(eclLon)) * Math.cos(rad(eclLat));
  const z = Math.sin(rad(eclLat));
  const xe = x;
  const ye = y * Math.cos(rad(eps)) - z * Math.sin(rad(eps));
  const ze = y * Math.sin(rad(eps)) + z * Math.cos(rad(eps));
  const ra = deg(Math.atan2(ye, xe));
  const dec = deg(Math.atan2(ze, Math.sqrt(xe*xe + ye*ye)));

  const jd = julianDay(date);
  const T = (jd - 2451545.0) / 36525;
  let gmst = 280.46061837 + 360.98564736629*(jd - 2451545) + 0.000387933*T*T - T*T*T/38710000;
  gmst = norm360(gmst);
  const ha = norm360(gmst + lon - ra);
  const xAlt = Math.cos(rad(ha))*Math.cos(rad(dec));
  const yAlt = Math.sin(rad(ha))*Math.cos(rad(dec));
  const zAlt = Math.sin(rad(dec));
  const xhor = xAlt*Math.cos(rad(90-lat)) - zAlt*Math.sin(rad(90-lat));
  const yhor = yAlt;
  const zhor = xAlt*Math.sin(rad(90-lat)) + zAlt*Math.cos(rad(90-lat));
  const alt = deg(Math.asin(zhor));
  const az = norm360(deg(Math.atan2(yhor, xhor)) + 180);
  return { alt, az, ra, dec };
}

function moonPosition(date, lat, lon) {
  const m = moonEcliptic(date);
  return celestialToAltAz(date, lon, lat, m.lon, m.lat);
}

function phaseInfo(date) {
  const lm = moonEcliptic(date).lon;
  const ls = sunEclipticLongitude(date);
  const phase = norm360(lm - ls);
  const illumination = (1 - Math.cos(rad(phase))) / 2;
  const k = 0.8 + 0.4 * Math.abs(Math.cos(rad(phase)));
  let name = "растущая";
  if (phase < 15 || phase > 345) name = "новолуние";
  else if (phase < 90) name = "растущий серп";
  else if (phase < 105) name = "первая четверть";
  else if (phase < 165) name = "растущая Луна";
  else if (phase < 195) name = "полнолуние";
  else if (phase < 255) name = "убывающая";
  else if (phase < 285) name = "последняя четверть";
  else name = "убывающий серп";
  return { phase, illumination, k, name };
}

function findCrossings(samples, threshold) {
  const hits = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i-1], b = samples[i];
    if ((a.value < threshold && b.value >= threshold) || (a.value >= threshold && b.value < threshold)) {
      const frac = (threshold - a.value) / (b.value - a.value || 1);
      hits.push(a.minutes + frac*(b.minutes-a.minutes));
    }
  }
  return hits;
}

function findExtrema(samples, pickMax) {
  const vals = [];
  for (let i=1;i<samples.length-1;i++) {
    const before=samples[i-1].value, cur=samples[i].value, after=samples[i+1].value;
    if ((pickMax && cur>=before && cur>=after) || (!pickMax && cur<=before && cur<=after)) vals.push(samples[i].minutes);
  }
  vals.sort((a,b)=>a-b);
  // keep extrema with 6h+ separation
  const out=[];
  for (const m of vals) {
    if (!out.length || m-out[out.length-1] >= 360) out.push(m);
  }
  return out;
}

function minuteDate(localDate, minute, utcOffsetSeconds) {
  return new Date(Date.UTC(
    +localDate.slice(0,4), +localDate.slice(5,7)-1, +localDate.slice(8,10),
    0, minute
  ) - utcOffsetSeconds*1000);
}

function buildSolunar(localDate, lat, lon, utcOffsetSeconds) {
  const samplesSun = [];
  const samplesMoon = [];
  for (let m=0; m<=1440; m+=10) {
    const dt = minuteDate(localDate,m,utcOffsetSeconds);
    samplesSun.push({minutes:m,value:sunPosition(dt,lat,lon,0,0).alt});
    samplesMoon.push({minutes:m,value:moonPosition(dt,lat,lon).alt});
  }
  const sunRiseSet = findCrossings(samplesSun, -0.833);
  const moonRiseSet = findCrossings(samplesMoon, -0.3);
  const moonMax = findExtrema(samplesMoon,true);
  const moonMin = findExtrema(samplesMoon,false);
  const pInfo = phaseInfo(minuteDate(localDate, 720, utcOffsetSeconds));

  const sunEvents = sunRiseSet.slice(0,2);
  const periods = [];
  for (const m of moonMax.slice(0,2)) periods.push({type:"big", center:m});
  for (const m of moonMin.slice(0,2)) periods.push({type:"big", center:m});
  for (const m of moonRiseSet.slice(0,2)) periods.push({type:"small", center:m});

  // In normal latitudes this gives 2 major + up to 2 minor events.
  periods.sort((a,b)=>a.center-b.center);
  const unique=[];
  for (const p of periods) {
    if (!unique.some(x=>Math.abs(x.center-p.center)<45)) unique.push(p);
  }

  return {
    sunrise: sunRiseSet.filter((_,i)=>i%2===0)[0] ?? null,
    sunset: sunRiseSet.filter((_,i)=>i%2===1)[0] ?? null,
    sunEvents,
    phase: pInfo,
    periods: unique.slice(0,4)
  };
}

function periodScore(solunar, minute) {
  let raw = 20;
  for (const p of solunar.periods) {
    const width = p.type==="big" ? 60 : 30;
    const dist = Math.abs(minute - p.center);
    const wrap = Math.min(dist, 1440-dist);
    if (wrap <= width) {
      const taper = 1 - wrap/(width+1);
      const amplitude = p.type==="big" ? 34 : 20;
      const overlap = solunar.sunEvents.some(s => Math.abs(s - p.center) <= 45) ? 1 : 0;
      raw += amplitude * taper * solunar.phase.k * (1 + overlap);
    }
  }
  return raw;
}

function seasonK(month) {
  if ([2,3,4].includes(month)) return 1.15;
  if ([5,6,7].includes(month)) return 0.85;
  if ([8,9].includes(month)) return 1.15;
  return 0.70;
}

function weatherMods(record, allRecords, idx, sunUp) {
  const pNow = record.pressure;
  const pPrev = allRecords[Math.max(0, idx-3)]?.pressure ?? pNow;
  const dPmmHg = (pNow-pPrev) / 1.33322;
  let mp = 1.05;
  if (dPmmHg <= -3) mp = 1.18;
  else if (dPmmHg < -1) mp = 1.10;
  else if (dPmmHg > 3) mp = 0.80;
  else if (dPmmHg > 1) mp = 0.95;

  const w = windMS(record.wind);
  const mw = w >= 10 ? 0.80 : w <= 5 ? 1.05 : 1.00;

  const day = allRecords.slice(Math.max(0, idx-12), Math.min(allRecords.length, idx+12));
  const temps = day.map(r=>r.temp).filter(Number.isFinite);
  const range = temps.length ? Math.max(...temps)-Math.min(...temps) : 0;
  const mt = range > 5 ? 0.85 : 1.00;

  let mr = 1.00;
  if (weatherCodeIsStorm(record.code)) mr = 0.65;
  else if (isLightRain(record)) mr = 1.08;

  let mc = 1.00;
  if (sunUp) {
    if (record.cloud <= 20) mc = 1.00;
    else if (record.cloud <= 70) mc = 1.05;
    else mc = 1.10;
  }

  const total = clamp(mp*mw*mt*mr*mc, 0.5, 1.3);
  return {mp,mw,mt,mr,mc,total,dPmmHg,tempRange:range};
}

function makeHourlyRecords(weather, localDate) {
  const h = weather.hourly;
  const recs = [];
  for (let i=0;i<h.time.length;i++) {
    const date = h.time[i].slice(0,10);
    recs.push({
      time: h.time[i],
      date,
      hour: +(h.time[i].slice(11,13)),
      temp: h.temperature_2m[i],
      pressure: h.surface_pressure[i],
      wind: h.wind_speed_10m[i],
      precip: h.precipitation[i],
      cloud: h.cloud_cover[i],
      code: h.weather_code[i],
      index: i
    });
  }
  return recs;
}

function computeDay(records, localDate, lat, lon, offset) {
  const solunar = buildSolunar(localDate, lat, lon, offset);
  const dayRecords = records.filter(r=>r.date===localDate);
  const raw = dayRecords.map(r=>periodScore(solunar, r.hour*60+30));
  const maxRaw = Math.max(...raw, 1);
  const scores = dayRecords.map((r,i)=>{
    const sol = clamp(raw[i]/maxRaw*100, 0, 100);
    const sunUp = solunar.sunrise != null && solunar.sunset != null && r.hour*60+30 >= solunar.sunrise && r.hour*60+30 <= solunar.sunset;
    const mods = weatherMods(r, records, r.index, sunUp);
    const idx = clamp(sol * mods.total * seasonK(+localDate.slice(5,7)-1), 0, 100);
    return {...r, solunar:sol, mods, score:idx, sunUp};
  });
  return {date:localDate, scores, solunar};
}

function dayRange(weather, timeZone) {
  const today = localDateISO(new Date(), timeZone);
  return [today, dateAddISO(today,1), dateAddISO(today,2)];
}

function pickSlots(day) {
  const a = day.scores;
  const candidates = [];
  for (let i=0;i<a.length-1;i++) {
    const s=(a[i].score+a[i+1].score)/2;
    candidates.push({start:i,end:i+1,score:s});
  }
  candidates.sort((x,y)=>y.score-x.score);
  const chosen=[];
  for (const c of candidates) {
    if (chosen.every(x=>Math.abs(c.start-x.start)>=2)) chosen.push(c);
    if (chosen.length===3) break;
  }
  return chosen.map((x,i)=>({
    rank:i+1,
    time:`${pad(a[x.start].hour)}:00–${pad((a[x.end].hour+1)%24)}:00`,
    score:Math.round(x.score),
    start:a[x.start].hour
  }));
}

function findPeak(day) {
  return day.scores.reduce((best,r)=>r.score>best.score?r:best, day.scores[0]);
}

function renderDayTabs(days) {
  $("dayTabs").innerHTML = "";
  days.forEach((d,i)=>{
    const tab=document.createElement("button");
    tab.className=`day-tab ${i===state.selectedDay?"active":""}`;
    const dt=new Date(`${d.date}T12:00:00Z`);
    tab.innerHTML=`<strong>${i===0?"Сегодня":ruDays[(dt.getUTCDay())]}</strong><span>${dt.getUTCDate()} ${ruMonths[dt.getUTCMonth()]}</span>`;
    tab.addEventListener("click",()=>{state.selectedDay=i; renderAll();});
    $("dayTabs").appendChild(tab);
  });
}

function renderScore(days) {
  const day=days[state.selectedDay];
  const now = new Date();
  const targetDate = state.selectedDay===0 ? day.date : day.date;
  let rec=day.scores[Math.min(day.scores.length-1, Math.max(0, Math.round(new Date().getHours())))];
  if (state.selectedDay !== 0) rec=day.scores[10] || day.scores[0];
  const [labelKey, labelShort] = scoreCategory(rec.score);
  const percent = Math.round(rec.score);
  const degAngle = percent*3.6;
  $("scoreRing").style.background = `conic-gradient(var(--accent) 0deg, var(--accent) ${degAngle}deg, rgba(129,162,188,.12) ${degAngle}deg 360deg)`;
  $("scoreValue").textContent = `${percent}%`;
  $("scoreLabel").textContent = labelKey;
  $("scoreLabel").style.color = percent>=75 ? "var(--accent)" : percent>=50 ? "var(--good)" : percent>=25 ? "var(--warn)" : "var(--bad)";
  $("scoreTime").textContent = `${fmtHour(rec.hour)} · ${day.date}`;
  $("weatherBadge").textContent = weatherCodeText(rec.code);
  $("scoreHeadline").textContent = percent>=75 ? "Есть смысл выходить" : percent>=50 ? "Окно рабочее" : percent>=25 ? "Можно пробовать" : "День сложный";
  const dp = rec.mods.dPmmHg;
  const trend = dp <= -1 ? "падает" : dp >= 1 ? "растёт" : "стабильно";
  $("scoreExplanation").textContent = `Солунарная база ${Math.round(rec.solunar)} · погодный множитель ×${rec.mods.total.toFixed(2)} · давление ${trend}.`;
  $("mPressure").textContent = fmtPressure(rec.pressure);
  $("mWind").textContent = `${windMS(rec.wind).toFixed(1)} м/с`;
  $("mTemp").textContent = fmtTemp(rec.temp);
  $("mCloud").textContent = `${Math.round(rec.cloud)}%`;
  $("mMoon").textContent = `${Math.round(day.solunar.phase.illumination*100)}% · ${day.solunar.phase.name}`;
  $("mPressureTrend").textContent = `${dp>=0?"+":""}${dp.toFixed(1)} мм`;
  $("slotHint").textContent = day.date;
}

function renderSlots(day) {
  $("slots").innerHTML="";
  const slots=pickSlots(day);
  slots.forEach(s=>{
    const card=document.createElement("div");
    card.className="slot";
    const [cat] = scoreCategory(s.score);
    card.innerHTML=`
      <div class="slot-rank">#${s.rank}</div>
      <div>
        <div class="slot-time">${s.time}</div>
        <div class="slot-label">${cat}</div>
      </div>
      <div>
        <div class="slot-score">${s.score}%</div>
        <div class="slot-label">индекс</div>
      </div>`;
    $("slots").appendChild(card);
  });
}

function renderChart(day) {
  const scores=day.scores;
  const w=900,h=300,padX=25,padTop=24,padBottom=38;
  const plotW=w-padX*2, plotH=h-padTop-padBottom;
  const pts=scores.map((r,i)=>{
    const x=padX+i/(scores.length-1)*plotW;
    const y=padTop+(100-r.score)/100*plotH;
    return [x,y,r];
  });
  const line=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  const area=line+` L ${padX+plotW} ${padTop+plotH} L ${padX} ${padTop+plotH} Z`;
  let grid="";
  for (const v of [0,25,50,75,100]) {
    const y=padTop+(100-v)/100*plotH;
    grid+=`<line x1="${padX}" y1="${y}" x2="${padX+plotW}" y2="${y}" stroke="rgba(143,165,187,.10)" stroke-width="1"/>`;
    grid+=`<text x="3" y="${y+4}" fill="#7891a8" font-size="11">${v}</text>`;
  }
  const dots=pts.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="4.8" fill="${p[2].score>=75?"#48e2a2":p[2].score>=50?"#a5e34b":"#ffca61"}" stroke="#10243a" stroke-width="2"/>`).join("");
  $("chart").innerHTML=`
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Активность по часам">
      <defs>
        <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#48e2a2" stop-opacity=".24"/>
          <stop offset=".78" stop-color="#20b9dc" stop-opacity=".02"/>
          <stop offset="1" stop-color="#20b9dc" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#areaGrad)"/>
      <path d="${line}" fill="none" stroke="#bfe8db" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      ${pts.filter((_,i)=>i%3===0).map(p=>`<text x="${p[0]}" y="${h-10}" fill="#7891a8" font-size="11" text-anchor="middle">${pad(p[2].hour)}:00</text>`).join("")}
    </svg>`;
  const peak=findPeak(day);
  $("chartPeak").textContent=`пик ${fmtHour(peak.hour)} · ${Math.round(peak.score)}%`;
  $("chartTitle").textContent=`${day.date} · активность по часам`;
}

function renderFactors(day) {
  const rec = day.scores[state.selectedDay===0 ? Math.min(new Date().getHours(),23) : 12] || day.scores[0];
  const m=rec.mods;
  const factors=[
    ["◌","Давление",`${m.mp.toFixed(2)}×`,`${m.dPmmHg>=0?"+":""}${m.dPmmHg.toFixed(1)} мм рт. ст. / 3ч`],
    ["≈","Ветер",`${m.mw.toFixed(2)}×`,`${windMS(rec.wind).toFixed(1)} м/с`],
    ["°","Температура",`${m.mt.toFixed(2)}×`,`${m.tempRange.toFixed(1)}° суточный диапазон`],
    ["☂","Осадки",`${m.mr.toFixed(2)}×`,weatherCodeText(rec.code)],
    ["☁","Облачность",`${m.mc.toFixed(2)}×`,`${Math.round(rec.cloud)}% · ${rec.sunUp?"день":"ночь"}`]
  ];
  $("factorGrid").innerHTML=factors.map(f=>`
    <div class="factor">
      <div class="factor-icon">${f[0]}</div>
      <div class="factor-title">${f[1]}</div>
      <div class="factor-value">${f[2]}</div>
      <div class="factor-note">${f[3]}</div>
    </div>`).join("");
}

function renderAll() {
  if (!state.days.length) return;
  renderDayTabs(state.days);
  const day=state.days[state.selectedDay];
  renderScore(state.days);
  renderSlots(day);
  renderChart(day);
  renderFactors(day);
  $("forecastView").classList.remove("hidden");
  $("loadingCard").classList.add("hidden");
  $("errorCard").classList.add("hidden");
  localStorage.setItem(state.cacheKey, JSON.stringify({
    place: state.place,
    forecast: state.forecast,
    days: state.days,
    selectedDay: state.selectedDay,
    savedAt: Date.now()
  }));
}

async function loadForecast(lat, lon, place) {
  setLoading(true);
  try {
    const weather = await fetchWeather(lat,lon);
    const records = makeHourlyRecords(weather);
    const dates = dayRange(weather, weather.timezone);
    const days = dates.map(d=>computeDay(records,d,lat,lon,weather.utc_offset_seconds));
    state.forecast=weather; state.days=days; state.selectedDay=0; state.place=place;
    const meta = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    $("locationMeta").textContent = place.id==="gps"
      ? `координаты ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${weather.timezone}`
      : `${meta} · ${weather.timezone}`;
    renderAll();
  } catch (e) {
    console.error(e);
    // Try cached state only when we actually have it.
    const cached=localStorage.getItem(state.cacheKey);
    if (cached) {
      try {
        const x=JSON.parse(cached);
        state.place=x.place; state.forecast=x.forecast; state.days=x.days; state.selectedDay=x.selectedDay||0;
        $("locationMeta").textContent += " · показан последний сохранённый расчёт";
        renderAll();
        return;
      } catch {}
    }
    setError(e.message || "Неизвестная ошибка.");
  }
}

function restoreLast() {
  const cached=localStorage.getItem(state.cacheKey);
  if (!cached) return;
  try {
    const x=JSON.parse(cached);
    if (!x.days?.length) return;
    const age=Date.now()-x.savedAt;
    if (age > 1000*60*60*12) return;
    state.place=x.place; state.forecast=x.forecast; state.days=x.days; state.selectedDay=0;
    $("placeInput").value=state.place?.name || "";
    $("locationMeta").textContent = state.place?.id==="gps"
      ? `координаты ${state.place.latitude.toFixed(4)}, ${state.place.longitude.toFixed(4)} · сохранённый расчёт`
      : `${[state.place?.name,state.place?.admin1,state.place?.country].filter(Boolean).join(", ")} · сохранённый расчёт`;
    renderAll();
  } catch {}
}

$("placeInput").addEventListener("input", handleSearchInput);
$("clearPlace").addEventListener("click", ()=>{
  $("placeInput").value="";
  $("suggestions").classList.remove("open");
  $("locationMeta").textContent="Выберите точку, чтобы построить прогноз";
  $("forecastView").classList.add("hidden");
});
$("geoBtn").addEventListener("click", useGeolocation);
$("retryBtn").addEventListener("click", ()=>{
  if (state.place) loadForecast(state.place.latitude,state.place.longitude,state.place);
});
document.addEventListener("click", e=>{
  if (!e.target.closest(".search-wrap")) $("suggestions").classList.remove("open");
});
updateNetwork();
restoreLast();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
}
