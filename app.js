/**
 * Fishing Forecast PWA
 * Hybrid solunar-weather bite prediction model
 * Data: Open-Meteo API (free, no key required)
 */

// ==================== STATE ====================
let currentLat = 55.7558, currentLon = 37.6173;
let currentCity = 'Москва';
let weatherData = null;
let selectedDay = 0;
let debounceTimer = null;

const $ = id => document.getElementById(id);

// ==================== ASTRONOMY ====================
function toJulian(date) { return date.getTime() / 86400000 - 0.5 + 2440587.5; }

function sunPosition(jd) {
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2*g)) * Math.PI / 180;
  const epsilon = (23.439 - 0.0000004 * n) * Math.PI / 180;
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  return { ra, dec };
}

function moonPosition(jd) {
  const T = (jd - 2451545.0) / 36525;
  const Lp = (218.316 + 481267.881 * T) % 360;
  const M = ((134.963 + 477198.867 * T) % 360) * Math.PI / 180;
  const D = ((297.850 + 445267.112 * T) % 360) * Math.PI / 180;
  const F = ((93.272 + 483202.018 * T) % 360) * Math.PI / 180;
  const lon = (Lp + 6.289 * Math.sin(M) + 1.274 * Math.sin(2*D - M) + 0.658 * Math.sin(2*D) + 0.214 * Math.sin(2*M) - 0.186 * Math.sin(D) - 0.114 * Math.sin(2*F)) * Math.PI / 180;
  const lat = (5.128 * Math.sin(F) + 0.281 * Math.sin(M + F) + 0.278 * Math.sin(M - F) + 0.173 * Math.sin(2*D - F)) * Math.PI / 180;
  const parallax = 0.9508 + 0.0518 * Math.cos(M) + 0.0095 * Math.cos(2*D - M) + 0.0078 * Math.cos(2*D) + 0.0028 * Math.cos(2*M);
  const dist = 1 / Math.sin(parallax * Math.PI / 180 / 3600);
  const ra = Math.atan2(Math.sin(lon) * Math.cos(23.4397*Math.PI/180) - Math.tan(lat) * Math.sin(23.4397*Math.PI/180), Math.cos(lon));
  const dec = Math.asin(Math.sin(lat) * Math.cos(23.4397*Math.PI/180) + Math.cos(lat) * Math.sin(23.4397*Math.PI/180) * Math.sin(lon));
  return { ra, dec, dist, lon: lon * 180 / Math.PI };
}

function hourAngle(jd, lon, ra) {
  const gmst = (18.697374558 + 24.06570982441908 * (jd - 2451545.0)) % 24;
  const lst = gmst + lon / 15;
  return ((lst * 15 * Math.PI / 180 - ra) + Math.PI) % (2*Math.PI) - Math.PI;
}

function riseSetTransit(jd, lat, lon, dec, ra, h0) {
  const H0 = Math.acos(Math.max(-1, Math.min(1, (Math.sin(h0) - Math.sin(lat)*Math.sin(dec)) / (Math.cos(lat)*Math.cos(dec)))));
  const transit = (ra - hourAngle(jd, lon, 0) + lon) / (2*Math.PI) * 24;
  const rise = transit - H0 / (2*Math.PI) * 24;
  const set = transit + H0 / (2*Math.PI) * 24;
  return { rise, transit, set };
}

function getMoonTimes(date, lat, lon) {
  const jd0 = Math.floor(toJulian(date)) - 0.5;
  const times = [];
  for (let d = -1; d <= 1; d++) {
    const jd = jd0 + d;
    const mp = moonPosition(jd);
    const h0 = -0.00989;
    const r = riseSetTransit(jd, lat*Math.PI/180, lon*Math.PI/180, mp.dec, mp.ra, h0);
    ['rise','transit','set'].forEach(k => {
      const t = r[k] + d * 24;
      if (t >= 0 && t <= 24) times.push({ type: k === 'transit' ? 'upper' : k, time: t, jd: jd + t/24 });
    });
  }
  times.sort((a,b) => a.time - b.time);
  const result = { rise: null, set: null, upper: null, lower: null };
  for (const t of times) {
    if (t.type === 'rise' && !result.rise) result.rise = t;
    if (t.type === 'set' && !result.set) result.set = t;
    if (t.type === 'upper' && !result.upper) result.upper = t;
    if (t.type === 'upper' && result.upper && !result.lower) {
      result.lower = { time: t.time + 12.42, jd: t.jd + 12.42/24 };
    }
  }
  if (result.upper && !result.lower) {
    result.lower = { time: result.upper.time + 12.42, jd: result.upper.jd + 12.42/24 };
  }
  return result;
}

function getSunTimes(date, lat, lon) {
  const jd = toJulian(date);
  const sp = sunPosition(jd);
  const h0 = -0.01454;
  const r = riseSetTransit(jd, lat*Math.PI/180, lon*Math.PI/180, sp.dec, sp.ra, h0);
  const jd0 = Math.floor(jd) - 0.5;
  return {
    rise: { time: r.rise, jd: jd0 + r.rise/24 },
    set: { time: r.set, jd: jd0 + r.set/24 }
  };
}

function getMoonPhase(jd) {
  const T = (jd - 2451545.0) / 36525;
  const D = ((297.850 + 445267.112 * T) % 360) * Math.PI / 180;
  const M = ((134.963 + 477198.867 * T) % 360) * Math.PI / 180;
  const Mp = ((218.316 + 481267.881 * T) % 360) * Math.PI / 180;
  const elong = 180 - D * 180/Math.PI - 6.289 * Math.sin(Mp) + 2.100 * Math.sin(M) + 1.274 * Math.sin(2*D - Mp) + 0.658 * Math.sin(2*D);
  const illum = (1 - Math.cos(elong * Math.PI / 180)) / 2;
  return illum;
}

// ==================== SOLUNAR MODEL ====================
function computeSolunar(date, lat, lon) {
  const moon = getMoonTimes(date, lat, lon);
  const sun = getSunTimes(date, lat, lon);
  const jd = toJulian(date);
  const phase = getMoonPhase(jd);
  const kPhase = 0.8 + 0.4 * Math.abs(Math.sin(phase * Math.PI));

  const periods = [];
  if (moon.upper) periods.push({ start: moon.upper.time - 1, end: moon.upper.time + 1, amp: 40, type: 'big' });
  if (moon.lower) periods.push({ start: moon.lower.time - 1, end: moon.lower.time + 1, amp: 40, type: 'big' });
  if (moon.rise) periods.push({ start: moon.rise.time - 0.5, end: moon.rise.time + 0.5, amp: 25, type: 'small' });
  if (moon.set) periods.push({ start: moon.set.time - 0.5, end: moon.set.time + 0.5, amp: 25, type: 'small' });

  const overlapWindow = 1.0;
  for (const p of periods) {
    const nearSunrise = Math.abs(p.start + (p.end-p.start)/2 - sun.rise.time) <= overlapWindow;
    const nearSunset = Math.abs(p.start + (p.end-p.start)/2 - sun.set.time) <= overlapWindow;
    p.super = nearSunrise || nearSunset ? 1.3 : 1.0;
  }

  const hourly = [];
  for (let h = 0; h < 24; h++) {
    let score = 15;
    for (const p of periods) {
      if (h >= p.start && h <= p.end) {
        const center = (p.start + p.end) / 2;
        const dist = Math.abs(h + 0.5 - center);
        const peak = p.amp * Math.max(0, 1 - dist / ((p.end - p.start) / 2));
        score += peak * kPhase * p.super;
      }
    }
    hourly.push(Math.min(100, Math.max(0, score)));
  }

  return { hourly, moon, sun, phase, kPhase, periods };
}

// ==================== WEATHER ====================
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,pressure_msl,cloud_cover,precipitation,weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=auto&forecast_days=5`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Weather API error');
  return r.json();
}

function getWeatherMod(hourIdx, data, dayOffset, solunar) {
  const p = data.hourly.pressure_msl;
  const w = data.hourly.wind_speed_10m;
  const c = data.hourly.cloud_cover;
  const pr = data.hourly.precipitation;
  const wc = data.hourly.weather_code;

  const base = dayOffset * 24;
  const i = Math.min(base + hourIdx, p.length - 1);
  const i3 = Math.max(0, i - 3);

  let mod = 1.0;

  const dp = p[i] - p[i3];
  if (dp >= -1 && dp <= 1) mod *= 1.05;
  else if (dp >= -3 && dp < -1) mod *= 1.10;
  else if (dp < -3) mod *= 1.18;
  else if (dp > 1 && dp <= 3) mod *= 0.95;
  else if (dp > 3) mod *= 0.80;

  if (w[i] >= 10) mod *= 0.80;
  else if (w[i] <= 5) mod *= 1.05;

  const code = wc[i];
  if (code >= 95) mod *= 0.65;
  else if (pr[i] > 0 && pr[i] < 2.5) mod *= 1.08;
  else if (pr[i] >= 2.5) mod *= 0.90;

  const h = hourIdx;
  const sr = solunar.sun.rise.time;
  const ss = solunar.sun.set.time;
  const isDay = h >= sr && h <= ss;
  if (isDay) {
    if (c[i] > 80) mod *= 1.10;
    else if (c[i] > 30) mod *= 1.05;
  }

  const month = new Date().getMonth();
  let kSeason = 1.0;
  if (month >= 2 && month <= 4) kSeason = 1.15;
  else if (month >= 5 && month <= 7) kSeason = 0.85;
  else if (month >= 8 && month <= 9) kSeason = 1.15;
  else kSeason = 0.70;

  return Math.max(0.5, Math.min(1.3, mod)) * kSeason;
}

function computeForecast(date, lat, lon, wdata) {
  const sol = computeSolunar(date, lat, lon);
  const dayOffset = Math.floor((date - new Date(wdata.hourly.time[0])) / 86400000);
  const hourly = sol.hourly.map((s, h) => {
    const mod = getWeatherMod(h, wdata, dayOffset, sol);
    return Math.min(100, s * mod);
  });

  const now = new Date();
  const currentHour = now.getHours();
  const currentScore = hourly[currentHour] || hourly[0];

  const slots = [];
  for (let h = 0; h < 24; h++) slots.push({ hour: h, score: hourly[h] });
  slots.sort((a,b) => b.score - a.score);

  const topSlots = slots.slice(0, 3).map((s, i) => {
    const end = (s.hour + 3) % 24;
    return { rank: i + 1, start: s.hour, end, score: Math.round(s.score), peakHour: s.hour };
  });

  return { solunar: sol, hourly, currentScore, topSlots, date };
}

// ==================== UI HELPERS ====================
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function setLoading(text, active) {
  $('loadingText').textContent = text;
  if (active) $('loading').classList.add('active');
  else $('loading').classList.remove('active');
}

function category(score) {
  if (score >= 75) return { label: 'Отличный', cls: 'cat-excellent' };
  if (score >= 50) return { label: 'Хороший', cls: 'cat-good' };
  if (score >= 25) return { label: 'Средний', cls: 'cat-average' };
  return { label: 'Слабый', cls: 'cat-poor' };
}

function formatTime(h) { return String(h).padStart(2,'0') + ':00'; }
function formatRange(s, e) { return formatTime(s) + ' – ' + formatTime(e); }

// ==================== RENDER ====================
function renderMain(forecast) {
  const score = Math.round(forecast.currentScore);
  const cat = category(score);

  $('bitePercent').textContent = score + '%';
  $('biteCategory').textContent = cat.label;
  $('biteCategory').className = 'bite-category ' + cat.cls;

  const circumference = 2 * Math.PI * 90;
  const offset = circumference - (score / 100) * circumference;
  setTimeout(() => { $('biteRingFill').style.strokeDashoffset = offset; }, 100);

  const w = weatherData;
  const base = selectedDay * 24;
  const wi = base + new Date().getHours();
  $('weatherStrip').innerHTML = `
    <div class="weather-item"><div class="label">Давление</div><div class="value">${Math.round(w.hourly.pressure_msl[wi])} гПа</div></div>
    <div class="weather-item"><div class="label">Температура</div><div class="value">${Math.round(w.hourly.temperature_2m[wi])}°C</div></div>
    <div class="weather-item"><div class="label">Ветер</div><div class="value">${Math.round(w.hourly.wind_speed_10m[wi])} м/с</div></div>
    <div class="weather-item"><div class="label">Облачность</div><div class="value">${w.hourly.cloud_cover[wi]}%</div></div>
  `;

  $('slots').innerHTML = forecast.topSlots.map(s => {
    const c = category(s.score);
    return `
      <div class="slot-card">
        <div class="slot-rank rank-${s.rank}">${s.rank}</div>
        <div class="slot-info">
          <div class="slot-time">${formatRange(s.start, s.end)}</div>
          <div class="slot-detail">Пик в ${formatTime(s.peakHour)}</div>
        </div>
        <div class="slot-score">
          <div class="slot-score-val" style="color:${s.score>=75?'var(--accent)':s.score>=50?'var(--info)':s.score>=25?'var(--warning)':'var(--danger)'}">${s.score}%</div>
          <div class="slot-score-label">${c.label}</div>
        </div>
      </div>
    `;
  }).join('');

  drawChart(forecast.hourly);
  renderDayPicker();
  renderHourlyList(forecast.hourly);
  $('content').style.display = 'block';
}

function drawChart(hourly) {
  const canvas = $('hourChart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width, h = rect.height;
  const pad = { top: 20, right: 10, bottom: 30, left: 10 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  grad.addColorStop(0, 'rgba(0,212,170,0.25)');
  grad.addColorStop(1, 'rgba(0,212,170,0.0)');

  ctx.beginPath();
  ctx.moveTo(pad.left, h - pad.bottom);
  for (let i = 0; i < 24; i++) {
    const x = pad.left + (i / 23) * cw;
    const y = pad.top + (1 - hourly[i] / 100) * ch;
    if (i === 0) ctx.lineTo(x, y);
    else {
      const prevX = pad.left + ((i-1) / 23) * cw;
      const prevY = pad.top + (1 - hourly[i-1] / 100) * ch;
      const cpX = (prevX + x) / 2;
      ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
    }
  }
  ctx.lineTo(pad.left + cw, h - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const x = pad.left + (i / 23) * cw;
    const y = pad.top + (1 - hourly[i] / 100) * ch;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prevX = pad.left + ((i-1) / 23) * cw;
      const prevY = pad.top + (1 - hourly[i-1] / 100) * ch;
      const cpX = (prevX + x) / 2;
      ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
    }
  }
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  for (let i = 0; i < 24; i += 4) {
    const x = pad.left + (i / 23) * cw;
    const y = pad.top + (1 - hourly[i] / 100) * ch;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#0a1929';
    ctx.fill();
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.fillStyle = '#8a9bb0';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < 24; i += 4) {
    const x = pad.left + (i / 23) * cw;
    ctx.fillText(formatTime(i), x, h - 8);
  }
}

function renderDayPicker() {
  const days = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const today = new Date();
  let html = '';
  for (let d = 0; d < 5; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const active = d === selectedDay ? 'active' : '';
    html += `<button class="day-btn ${active}" data-day="${d}">
      <div class="dow">${days[date.getDay()]}</div>
      <div class="dom">${date.getDate()}</div>
    </button>`;
  }
  $('dayPicker').innerHTML = html;
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => { selectedDay = parseInt(btn.dataset.day); updateForecast(); });
  });
}

function renderHourlyList(hourly) {
  const now = new Date().getHours();
  $('hourlyList').innerHTML = hourly.map((score, h) => {
    const isNow = h === now && selectedDay === 0;
    const color = score >= 75 ? 'var(--accent)' : score >= 50 ? 'var(--info)' : score >= 25 ? 'var(--warning)' : 'var(--danger)';
    return `
      <div class="hour-row">
        <div class="hour-time">${isNow ? '<b>Сейчас</b>' : formatTime(h)}</div>
        <div class="hour-bar-wrap"><div class="hour-bar" style="width:${score}%;background:${color}"></div></div>
        <div class="hour-score" style="color:${color}">${Math.round(score)}%</div>
      </div>
    `;
  }).join('');
}

// ==================== GEOCODING ====================
async function searchCities(query) {
  if (query.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=ru`;
  const r = await fetch(url);
  const data = await r.json();
  return data.results || [];
}

function showAutocomplete(results) {
  const el = $('autocomplete');
  if (!results.length) { el.classList.remove('open'); return; }
  el.innerHTML = results.map(r => {
    const region = [r.admin1, r.country].filter(Boolean).join(', ');
    return `<div class="autocomplete-item" data-lat="${r.latitude}" data-lon="${r.longitude}" data-name="${r.name}">
      <div class="name">${r.name}</div>
      <div class="meta">${region}</div>
    </div>`;
  }).join('');
  el.classList.add('open');
  el.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('click', () => {
      selectCity(item.dataset.name, parseFloat(item.dataset.lat), parseFloat(item.dataset.lon));
      el.classList.remove('open');
    });
  });
}

function selectCity(name, lat, lon) {
  currentCity = name;
  currentLat = lat;
  currentLon = lon;
  $('cityInput').value = name;
  $('locationChip').style.display = 'inline-flex';
  $('locationChip').textContent = name;
  updateForecast();
}

async function updateForecast() {
  setLoading('Расчёт прогноза...', true);
  try {
    if (!weatherData) weatherData = await fetchWeather(currentLat, currentLon);
    const date = new Date();
    date.setDate(date.getDate() + selectedDay);
    const forecast = computeForecast(date, currentLat, currentLon, weatherData);
    renderMain(forecast);
  } catch (e) {
    showToast('Ошибка загрузки: ' + e.message);
  } finally {
    setLoading('', false);
  }
}

// ==================== EVENTS ====================
$('cityInput').addEventListener('input', e => {
  clearTimeout(debounceTimer);
  const val = e.target.value.trim();
  if (!val) { $('autocomplete').classList.remove('open'); return; }
  debounceTimer = setTimeout(async () => {
    const results = await searchCities(val);
    showAutocomplete(results);
  }, 300);
});

$('cityInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    $('autocomplete').classList.remove('open');
    const val = e.target.value.trim();
    if (val) searchCities(val).then(r => { if (r[0]) selectCity(r[0].name, r[0].latitude, r[0].longitude); });
  }
});

$('searchBtn').addEventListener('click', () => {
  const val = $('cityInput').value.trim();
  if (val) searchCities(val).then(r => { if (r[0]) selectCity(r[0].name, r[0].latitude, r[0].longitude); });
});

$('geoBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { showToast('Геолокация не поддерживается'); return; }
  setLoading('Определение местоположения...', true);
  navigator.geolocation.getCurrentPosition(async pos => {
    currentLat = pos.coords.latitude;
    currentLon = pos.coords.longitude;
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${currentLat},${currentLon}&count=1`);
      const d = await r.json();
      currentCity = (d.results && d.results[0]) ? d.results[0].name : 'Моё местоположение';
    } catch { currentCity = 'Моё местоположение'; }
    $('cityInput').value = currentCity;
    weatherData = null;
    await updateForecast();
  }, err => {
    setLoading('', false);
    showToast('Не удалось получить геолокацию');
  });
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-box')) $('autocomplete').classList.remove('open');
});

window.addEventListener('resize', () => {
  if (weatherData) {
    const date = new Date(); date.setDate(date.getDate() + selectedDay);
    const f = computeForecast(date, currentLat, currentLon, weatherData);
    drawChart(f.hourly);
  }
});

// ==================== INIT ====================
$('cityInput').value = currentCity;
selectCity(currentCity, currentLat, currentLon);
