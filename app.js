'use strict';
/* 家族カレンダー（PWA）
 * - 予定は Google Apps Script 経由で Google カレンダーと同期
 * - 予定・天気・設定はこの端末に保存し、オフラインでも表示
 * - オフライン中の追加・変更・削除は「未送信」として保存し、オンラインに戻ったら送信
 */

/* ================= 定数 ================= */

const COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000'
};
const COLOR_NAMES = {
  1: 'ラベンダー', 2: 'セージ', 3: 'ブドウ', 4: 'フラミンゴ', 5: 'バナナ', 6: 'ミカン',
  7: 'ピーコック', 8: 'グラファイト', 9: 'ブルーベリー', 10: 'バジル', 11: 'トマト'
};

// 接続前（デモ表示）の仮ルール。接続後はサーバー（Apps Script）の設定に置き換わります。
const DEFAULT_SETTINGS = {
  husbandEmail: '',
  defaultCategory: 'private',
  categories: [
    { id: 'soccer', name: '⚽ サッカー', colorId: '9', invite: true, keywords: ['サッカー'] },
    { id: 'family', name: '👨‍👩‍👧‍👦 家族', colorId: '11', invite: true, keywords: ['#家族', '#ファミリー', '【家族】', 'キャンプ', '旅行', '帰省'] },
    { id: 'pta', name: '🌷 父母の会', colorId: '3', invite: false, keywords: ['父母の会', '幹事会', '役員会'] },
    { id: 'child1', name: '長男', colorId: '7', invite: false, keywords: ['長男'] },
    { id: 'child2', name: '長女', colorId: '4', invite: false, keywords: ['長女'] },
    { id: 'child3', name: '次女', colorId: '5', invite: false, keywords: ['次女'] },
    { id: 'music', name: '🎵 音楽の仕事', colorId: '6', invite: false, keywords: ['リハ', '本番', '演奏'] },
    { id: 'work', name: '💼 夫の会社の仕事', colorId: '8', invite: false, keywords: ['#会社', '会社'] },
    { id: 'yoga', name: '🧘 ヨガ', colorId: '10', invite: false, keywords: ['ヨガ'] },
    { id: 'school', name: '🏫 学校・園', colorId: '2', invite: false, keywords: ['小学校', '幼稚園'] },
    { id: 'private', name: '🌸 プライベート', colorId: '1', invite: false, keywords: ['#プライベート'] }
  ]
};

const WEATHER_LOC = { name: '練馬区', lat: 35.7356, lon: 139.6517 };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const LS = {
  cfg: 'fc.cfg', settings: 'fc.settings', events: 'fc.events', queue: 'fc.queue',
  weather: 'fc.weather', view: 'fc.view', synced: 'fc.synced', hidden: 'fc.hidden'
};

/* ================= 保存 ================= */

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('保存できませんでした', e); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
};
const clone = o => JSON.parse(JSON.stringify(o));

const state = {
  cfg: store.get(LS.cfg, { url: '', token: '' }),
  settings: store.get(LS.settings, null) || clone(DEFAULT_SETTINGS),
  events: {},
  queue: store.get(LS.queue, []),
  weather: store.get(LS.weather, null),
  view: store.get(LS.view, 'month'),
  hidden: new Set(store.get(LS.hidden, [])),
  lastSynced: store.get(LS.synced, null),
  cursor: null,
  selected: null,
  online: navigator.onLine,
  syncing: false,
  demo: false,
  listDays: 60
};
state.demo = !state.cfg.url;

/* ================= 日付 ================= */

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${d.getHours()}:${pad(d.getMinutes())}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
function parseDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  return new Date(s);
}
const dayLabel = d => `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;

state.cursor = startOfMonth(new Date());
state.selected = startOfDay(new Date());

/* ================= 予定データ ================= */

const keyOf = e => `${e.calId || 'primary'}|${e.id}`;

function normalize(e) {
  e.s = parseDate(e.start).getTime();
  e.e = parseDate(e.end).getTime();
  return e;
}

function loadEvents() {
  const saved = state.demo ? null : store.get(LS.events, null);
  state.events = {};
  if (state.demo) demoEvents().forEach(e => { state.events[keyOf(e)] = normalize(e); });
  else if (saved) Object.values(saved).forEach(e => { state.events[keyOf(e)] = normalize(e); });
}

function saveEvents() {
  if (state.demo) return;
  // 1年以上前の予定は端末から消して容量を節約
  const limit = addMonths(new Date(), -12).getTime();
  for (const k in state.events) if (state.events[k].e < limit) delete state.events[k];
  store.set(LS.events, state.events);
}

function catById(id) { return state.settings.categories.find(c => c.id === id) || null; }

function classifyText(text) {
  const t = String(text || '').toLowerCase();
  for (const c of state.settings.categories) {
    for (const k of c.keywords || []) if (k && t.includes(String(k).toLowerCase())) return c.id;
  }
  return state.settings.defaultCategory;
}

function catOf(e) {
  if (e.holiday) return null;
  if (e.catManual && catById(e.cat)) return e.cat;
  return classifyText([e.title, e.description, e.location].join('\n'));
}

function colorOf(e) {
  if (e.holiday) return '#d0434c';
  if (e.calId && e.calId !== 'primary') return e.calColor || '#9e9e9e';
  if (e.colorManual && e.colorId) return COLORS[e.colorId];
  const c = catById(catOf(e));
  return c ? COLORS[c.colorId] : '#9e9e9e';
}

function isVisible(e) {
  if (e.holiday) return true;
  const c = catOf(e);
  return !(c && state.hidden.has(c));
}

function eventsForDay(day) {
  const ds = startOfDay(day).getTime();
  const de = addDays(day, 1).getTime();
  return Object.values(state.events)
    .filter(e => e.s < de && (e.e > ds || (e.e === e.s && e.s >= ds)) && isVisible(e))
    .sort((a, b) => (b.holiday - a.holiday) || (b.allDay - a.allDay) || (a.s - b.s) || a.title.localeCompare(b.title));
}

/* ================= 天気（Open-Meteo） ================= */

function wxIcon(code) {
  if (code == null) return '';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}
function wxLabel(code) {
  if (code === 0) return '快晴';
  if (code <= 2) return '晴れ';
  if (code === 3) return 'くもり';
  if (code === 45 || code === 48) return '霧';
  if (code >= 51 && code <= 57) return '霧雨';
  if (code >= 61 && code <= 67) return '雨';
  if (code >= 71 && code <= 77) return '雪';
  if (code >= 80 && code <= 82) return 'にわか雨';
  if (code === 85 || code === 86) return 'にわか雪';
  if (code >= 95) return '雷雨';
  return '';
}

async function fetchWeather(force) {
  if (!force && state.weather && Date.now() - state.weather.fetchedAt < 60 * 60 * 1000) return;
  const q = new URLSearchParams({
    latitude: WEATHER_LOC.lat, longitude: WEATHER_LOC.lon, timezone: 'Asia/Tokyo', forecast_days: 16,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    hourly: 'weather_code,precipitation_probability,temperature_2m'
  });
  try {
    const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${q}`, {}, 15000);
    if (!res.ok) return;
    const j = await res.json();
    const daily = {};
    j.daily.time.forEach((t, i) => {
      daily[t] = { code: j.daily.weather_code[i], max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i], pop: j.daily.precipitation_probability_max[i] };
    });
    const hourly = {};
    j.hourly.time.forEach((t, i) => {
      hourly[t] = { code: j.hourly.weather_code[i], pop: j.hourly.precipitation_probability[i], temp: j.hourly.temperature_2m[i] };
    });
    state.weather = { fetchedAt: Date.now(), daily, hourly };
    store.set(LS.weather, state.weather);
    render();
  } catch (e) { /* オフライン時は保存済みの天気を使う */ }
}

function wxAt(e) {
  if (!state.weather || e.allDay) return null;
  const d = new Date(e.s);
  return state.weather.hourly[`${ymd(d)}T${pad(d.getHours())}:00`] || null;
}

/* ================= 通信 ================= */

class ApiError extends Error {}
class NetError extends Error {}

function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(t));
}

async function api(action, payload, cfg) {
  cfg = cfg || state.cfg;
  let res;
  try {
    res = await fetchWithTimeout(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: cfg.token, action }, payload || {}))
    }, 60000);
  } catch (e) {
    throw new NetError('通信できませんでした');
  }
  let j;
  try { j = await res.json(); } catch (e) {
    throw new ApiError('サーバーの応答を読めませんでした（URLとデプロイ設定を確認してください）');
  }
  if (!j.ok) throw new ApiError(j.error || 'エラーが発生しました');
  return j.data;
}

function setOnline(v) {
  if (state.online === v) return;
  state.online = v;
  render();
}

function applySettings(s) {
  if (!s || !Array.isArray(s.categories)) return;
  state.settings = s;
  store.set(LS.settings, s);
}

/** 予定を読み込み（指定期間を丸ごと入れ替え） */
async function refresh(opts) {
  opts = opts || {};
  if (state.demo || state.syncing) return;
  const min = opts.min || addMonths(state.cursor, -1);
  const max = opts.max || addMonths(state.cursor, opts.months || 7);
  state.syncing = true;
  renderStatus();
  try {
    await flushQueue();
    const data = await api('list', { timeMin: min.toISOString(), timeMax: max.toISOString() });
    setOnline(true);
    applySettings(data.settings);
    const lo = min.getTime(), hi = max.getTime();
    const pendingIds = new Set(state.queue.map(q => `primary|${q.id}`));
    for (const k in state.events) {
      const e = state.events[k];
      if (!pendingIds.has(k) && e.s < hi && e.e > lo) delete state.events[k];
    }
    data.events.forEach(e => {
      const k = keyOf(e);
      if (!pendingIds.has(k)) state.events[k] = normalize(e);
    });
    saveEvents();
    state.lastSynced = Date.now();
    store.set(LS.synced, state.lastSynced);
  } catch (e) {
    if (e instanceof NetError) setOnline(false);
    else toast(e.message);
  } finally {
    state.syncing = false;
    render();
  }
}

/* ================= 未送信キュー（オフライン対応） ================= */

let flushing = false;

function enqueue(op) {
  const q = state.queue;
  const i = q.findIndex(x => x.id === op.id);
  if (i >= 0) {
    const prev = q[i];
    if (op.op === 'update') {
      prev.data = op.data; // 作成待ち/更新待ちに上書き
    } else if (op.op === 'delete') {
      if (prev.op === 'create') q.splice(i, 1); // まだ送っていない予定は消すだけ
      else q[i] = op;
    }
  } else {
    q.push(op);
  }
  store.set(LS.queue, q);
}

async function flushQueue() {
  if (state.demo) { state.queue = []; store.set(LS.queue, []); return; }
  if (flushing || !state.queue.length) return;
  flushing = true;
  renderStatus();
  try {
    while (state.queue.length) {
      const op = state.queue[0];
      try {
        let data;
        if (op.op === 'create') data = await api('create', { event: Object.assign({}, op.data, { id: op.id }) });
        else if (op.op === 'update') data = await api('update', { id: op.id, event: op.data });
        else data = await api('delete', { id: op.id });
        state.queue.shift();
        store.set(LS.queue, state.queue);
        const k = `primary|${op.id}`;
        if (data && data.event) state.events[keyOf(data.event)] = normalize(data.event);
        else if (op.op === 'delete') delete state.events[k];
        saveEvents();
        setOnline(true);
      } catch (err) {
        if (err instanceof NetError) { setOnline(false); break; }
        state.queue.shift();
        store.set(LS.queue, state.queue);
        toast(`「${(op.data && op.data.title) || '予定'}」を保存できませんでした：${err.message}`);
      }
    }
  } finally {
    flushing = false;
    render();
  }
}

function newId() {
  const chars = '0123456789abcdefghijklmnopqrstuv';
  let s = 'fc';
  const r = crypto.getRandomValues(new Uint8Array(24));
  r.forEach(b => { s += chars[b % 32]; });
  return s;
}

/** 追加・変更・削除：まず画面と端末に反映し、そのあと送信 */
function submitOp(op) {
  const k = `primary|${op.id}`;
  if (op.op === 'delete') {
    delete state.events[k];
  } else {
    const prev = state.events[k] || {};
    const e = Object.assign({}, prev, {
      id: op.id, calId: 'primary', title: op.data.title, start: op.data.start, end: op.data.end,
      allDay: op.data.allDay, location: op.data.location, description: op.data.description,
      cat: op.data.cat || null, catManual: !!op.data.cat, editable: true, pending: true,
      attendees: prev.attendees || []
    });
    state.events[k] = normalize(e);
  }
  if (state.demo) {
    if (state.events[k]) state.events[k].pending = false;
    render();
    return;
  }
  enqueue(op);
  saveEvents();
  render();
  flushQueue();
}

/* ================= 描画 ================= */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  renderHeader();
  renderStatus();
  renderBanner();
  renderLegend();
  if (state.view === 'month') {
    $('#calendarPane').hidden = false;
    $('#listPane').hidden = true;
    renderGrid();
  } else {
    $('#calendarPane').hidden = true;
    $('#listPane').hidden = false;
    renderList();
  }
  renderDay();
}

function renderHeader() {
  const c = state.cursor;
  $('#monthTitle').textContent = `${c.getFullYear()}年${c.getMonth() + 1}月`;
  $('#viewBtn').textContent = state.view === 'month' ? 'リスト' : '月';
}

function renderStatus() {
  const el = $('#status');
  let t = '', warn = false;
  if (state.demo) t = 'デモ表示';
  else if (!state.online) { t = 'オフライン'; warn = true; }
  else if (state.syncing || flushing) t = '同期中…';
  else if (state.lastSynced) t = `${hm(new Date(state.lastSynced))} 更新`;
  if (state.queue.length) { t += `・未送信${state.queue.length}件`; warn = true; }
  el.textContent = t;
  el.classList.toggle('warn', warn);
  $('#refreshBtn').style.opacity = state.syncing ? .4 : 1;
}

function renderBanner() {
  const b = $('#banner');
  if (state.demo) {
    b.innerHTML = 'デモ表示中です（サンプルの予定）。<button type="button" data-open-settings>設定</button>からGoogleカレンダーと接続してください。';
    b.hidden = false;
  } else if (!state.online) {
    const n = state.queue.length;
    b.innerHTML = `オフラインです。この端末に保存した予定を表示しています。${n ? `未送信の変更が${n}件あります。` : ''}追加・変更はネットにつながったときに自動で送信します。`;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

function renderLegend() {
  $('#legend').innerHTML = state.settings.categories.map(c =>
    `<button type="button" data-cat="${esc(c.id)}" class="${state.hidden.has(c.id) ? 'off' : ''}" style="--c:${COLORS[c.colorId]}" title="タップで表示/非表示">
      <span class="dot"></span>${esc(c.name)}${c.invite ? ' 💌' : ''}</button>`).join('');
}

function chipHtml(e, showTime) {
  const t = !e.allDay && showTime ? `<span class="t">${hm(new Date(e.s))}</span>` : '';
  return `<div class="chip ${e.allDay ? 'allday' : ''} ${e.pending ? 'pending' : ''}" style="--c:${colorOf(e)}">${t}${esc(e.title)}</div>`;
}

function renderGrid() {
  const first = state.cursor;
  const start = addDays(first, -first.getDay());
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  const today = ymd(new Date());
  const sel = ymd(state.selected);
  const maxChips = window.innerWidth < 700 ? 3 : 4;
  let html = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const key = ymd(d);
    const evs = eventsForDay(d);
    const hol = evs.find(e => e.holiday);
    const list = evs.filter(e => !e.holiday);
    const w = state.weather && state.weather.daily[key];
    const cls = ['cell'];
    if (d.getMonth() !== first.getMonth()) cls.push('other');
    if (key === today) cls.push('today');
    if (key === sel) cls.push('selected');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    if (hol) cls.push('hol');
    const wx = w ? `<span class="wx" title="${wxLabel(w.code)}">${wxIcon(w.code)}<small><b>${Math.round(w.max)}</b>/<i>${Math.round(w.min)}</i></small></span>` : '';
    const shown = list.slice(0, list.length > maxChips ? maxChips - 1 : maxChips);
    const more = list.length - shown.length;
    html += `<button type="button" class="${cls.join(' ')}" data-date="${key}" aria-label="${dayLabel(d)} 予定${list.length}件">
      <div class="cell-head"><span class="num">${d.getDate()}</span>${wx}</div>
      ${hol ? `<div class="holname">${esc(hol.title)}</div>` : ''}
      <div class="chips">${shown.map(e => chipHtml(e, true)).join('')}${more > 0 ? `<div class="more">他${more}件</div>` : ''}</div>
    </button>`;
  }
  $('#grid').innerHTML = html;
}

function evHtml(e) {
  const s = new Date(e.s), en = new Date(e.e);
  let time;
  if (e.allDay) time = '終日';
  else time = `${hm(s)}<br>${ymd(s) === ymd(en) ? hm(en) : `〜${en.getMonth() + 1}/${en.getDate()}`}`;
  const cat = catById(catOf(e));
  const meta = [];
  if (e.calName) meta.push(`<span class="tag">📅 ${esc(e.calName)}</span>`);
  else if (cat) meta.push(`<span class="tag"><span class="dot" style="--c:${COLORS[cat.colorId]}"></span>${esc(cat.name)}</span>`);
  if (e.location) meta.push(`<span class="tag">📍${esc(e.location.split(/[、,\n]/)[0].slice(0, 30))}</span>`);
  if (e.husbandInvited) meta.push('<span class="tag invited">💌 夫を招待済み</span>');
  const w = wxAt(e);
  if (w && w.pop >= 40) meta.push(`<span class="tag rain">☔ ${w.pop}%</span>`);
  else if (w) meta.push(`<span class="tag">${wxIcon(w.code)} ${Math.round(w.temp)}°</span>`);
  if (e.pending) meta.push('<span class="tag">⏳ 未送信</span>');
  return `<button type="button" class="ev ${e.pending ? 'pending' : ''}" data-key="${esc(keyOf(e))}" style="--c:${colorOf(e)}">
    <span class="bar"></span><span class="ev-time">${time}</span>
    <span><div class="ev-title">${esc(e.title)}</div><div class="ev-meta">${meta.join('')}</div></span>
  </button>`;
}

function weatherBlock(d) {
  const key = ymd(d);
  const w = state.weather && state.weather.daily[key];
  if (!w) {
    if (d < startOfDay(new Date())) return '';
    return `<div class="wx-line">🌤️ ${WEATHER_LOC.name}の天気予報は16日先まで表示されます</div>`;
  }
  const hours = [];
  for (let h = 6; h <= 21; h += 3) {
    const x = state.weather.hourly[`${key}T${pad(h)}:00`];
    if (x) hours.push(`<div>${h}時<span>${wxIcon(x.code)}</span>${Math.round(x.temp)}° ${x.pop}%</div>`);
  }
  return `<div class="wx-line"><span class="big">${wxIcon(w.code)}</span>
    <span><strong>${WEATHER_LOC.name} ${wxLabel(w.code)}</strong><br>最高 ${Math.round(w.max)}° / 最低 ${Math.round(w.min)}° ・ 降水 ${w.pop ?? '-'}%</span>
    ${hours.length ? `<div class="wx-hours">${hours.join('')}</div>` : ''}</div>`;
}

function renderDay() {
  const d = state.selected;
  const evs = eventsForDay(d);
  const hol = evs.find(e => e.holiday);
  const list = evs.filter(e => !e.holiday);
  $('#dayPane').innerHTML = `
    <div class="day-head"><h2>${dayLabel(d)}${hol ? `<span class="hol">${esc(hol.title)}</span>` : ''}</h2>
      <button type="button" class="pill" data-add="${ymd(d)}">＋ 追加</button></div>
    ${weatherBlock(d)}
    ${list.length ? `<div class="ev-list">${list.map(evHtml).join('')}</div>` : '<p class="empty">予定はありません</p>'}`;
  $('#dayPane').hidden = state.view === 'list' && window.innerWidth < 960;
}

function renderList() {
  const start = startOfDay(new Date());
  const today = ymd(start);
  let html = '';
  for (let i = 0; i < state.listDays; i++) {
    const d = addDays(start, i);
    const list = eventsForDay(d).filter(e => !e.holiday);
    if (!list.length) continue;
    const hol = eventsForDay(d).find(e => e.holiday);
    const w = state.weather && state.weather.daily[ymd(d)];
    html += `<div class="list-day"><h3 class="${ymd(d) === today ? 'today' : ''}">${dayLabel(d)}
      ${hol ? `<span class="hol" style="color:var(--sun);font-size:12px">${esc(hol.title)}</span>` : ''}
      ${w ? `<span class="wxs">${wxIcon(w.code)} ${Math.round(w.max)}°/${Math.round(w.min)}° 降水${w.pop ?? '-'}%</span>` : ''}</h3>
      <div class="ev-list">${list.map(evHtml).join('')}</div></div>`;
  }
  $('#listPane').innerHTML = (html || '<p class="empty">これからの予定はありません</p>') +
    `<button type="button" class="secondary list-more" data-more>さらに先を表示</button>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ================= 予定の編集画面 ================= */

const editor = $('#editor');
const form = $('#editorForm');
let editing = null;   // 編集中の予定（新規は null）
let chosenCat = '';   // '' = 自動判定

function openEditor(e, dateKey) {
  form.reset();
  editing = e || null;
  const f = form.elements;
  const readonly = !!e && !e.editable;
  if (e) {
    const s = new Date(e.s), en = new Date(e.e);
    f.title.value = e.title;
    f.allDay.checked = e.allDay;
    f.startDate.value = ymd(s);
    f.endDate.value = e.allDay ? ymd(addDays(en, -1)) : ymd(en);
    f.startTime.value = e.allDay ? '10:00' : `${pad(s.getHours())}:${pad(s.getMinutes())}`;
    f.endTime.value = e.allDay ? '11:00' : `${pad(en.getHours())}:${pad(en.getMinutes())}`;
    f.location.value = e.location || '';
    f.description.value = e.description || '';
    chosenCat = e.catManual ? e.cat : '';
  } else {
    const now = new Date();
    const h = Math.min(Math.max(now.getHours() + 1, 9), 22);
    f.startDate.value = f.endDate.value = dateKey || ymd(state.selected);
    f.startTime.value = `${pad(h)}:00`;
    f.endTime.value = `${pad(Math.min(h + 1, 23))}:00`;
    chosenCat = '';
  }
  $('#editorTitle').textContent = readonly ? '予定の詳細' : (e ? '予定を編集' : '予定を追加');
  $('#saveBtn').hidden = readonly;
  $('#deleteBtn').hidden = !e || readonly;
  [...form.querySelectorAll('input, textarea')].forEach(el => { el.disabled = readonly; });
  const info = [];
  if (readonly) info.push(e.calName ? `「${e.calName}」カレンダーの予定のため、このアプリでは変更できません。` : '他の人が作成した予定のため変更できません。');
  if (e && e.recurring && !readonly) info.push('🔁 繰り返し予定です。ここでの変更はこの日の分だけに反映されます。');
  if (e && e.attendees && e.attendees.length) info.push(`👥 参加者：${e.attendees.map(esc).join('、')}`);
  $('#editorInfo').innerHTML = info.join('<br>');
  toggleTimed();
  renderCatChips(readonly);
  updateCatHint();
  editor.showModal();
  if (!e) setTimeout(() => f.title.focus(), 50);
}

function toggleTimed() {
  const allDay = form.elements.allDay.checked;
  form.querySelectorAll('.timed').forEach(el => { el.style.display = allDay ? 'none' : ''; });
}

function renderCatChips(readonly) {
  const chips = [`<button type="button" data-pick="" class="${chosenCat ? '' : 'active'}">✨ 自動</button>`]
    .concat(state.settings.categories.map(c =>
      `<button type="button" data-pick="${esc(c.id)}" class="${chosenCat === c.id ? 'active' : ''}" style="--c:${COLORS[c.colorId]}"><span class="dot"></span>${esc(c.name)}</button>`));
  $('#catChips').innerHTML = chips.join('');
  $('#catChips').querySelectorAll('button').forEach(b => { b.disabled = !!readonly; });
}

function resolvedCat() {
  if (chosenCat) return chosenCat;
  const f = form.elements;
  return classifyText([f.title.value, f.description.value, f.location.value].join('\n'));
}

function updateCatHint() {
  const c = catById(resolvedCat());
  const hint = $('#catHint');
  if (!c) { hint.textContent = ''; return; }
  let html = chosenCat ? '' : `自動判定：<span class="dot" style="display:inline-block;--c:${COLORS[c.colorId]}"></span> ${esc(c.name)}`;
  hint.className = 'hint';
  if (c.invite && !(editing && editing.calId && editing.calId !== 'primary')) {
    if (editing && editing.husbandInvited) {
      html += `${html ? '<br>' : ''}💌 夫を招待済みです`;
      hint.className = 'hint invite';
    } else if (state.settings.husbandEmail) {
      html += `${html ? '<br>' : ''}💌 保存すると夫（${esc(state.settings.husbandEmail)}）に招待が届きます`;
      hint.className = 'hint invite';
    } else {
      html += `${html ? '<br>' : ''}⚠️ 夫のメールアドレスが未登録のため、招待は送られません（⚙︎設定から登録）`;
      hint.className = 'hint warn';
    }
  }
  hint.innerHTML = html;
}

function saveEditor() {
  const f = form.elements;
  const title = f.title.value.trim();
  if (!title) { toast('タイトルを入力してください'); f.title.focus(); return; }
  if (!f.startDate.value || !f.endDate.value) { toast('日付を入力してください'); return; }
  const allDay = f.allDay.checked;
  const data = {
    title, allDay,
    location: f.location.value.trim(),
    description: f.description.value,
    cat: chosenCat || null
  };
  if (allDay) {
    if (f.endDate.value < f.startDate.value) { toast('終了日が開始日より前になっています'); return; }
    data.start = f.startDate.value;
    data.end = ymd(addDays(parseDate(f.endDate.value), 1));
  } else {
    if (!f.startTime.value || !f.endTime.value) { toast('時刻を入力してください'); return; }
    data.start = `${f.startDate.value}T${f.startTime.value}:00`;
    data.end = `${f.endDate.value}T${f.endTime.value}:00`;
    if (data.end < data.start) { toast('終了が開始より前になっています'); return; }
  }
  submitOp({ op: editing ? 'update' : 'create', id: editing ? editing.id : newId(), data });
  editor.close();
  state.selected = startOfDay(parseDate(data.start.slice(0, 10)));
  render();
  if (!state.demo) toast(state.online ? '保存しました' : 'オフラインのため端末に保存しました。ネットにつながったら送信します');
}

form.addEventListener('submit', ev => { ev.preventDefault(); saveEditor(); });
form.elements.allDay.addEventListener('change', toggleTimed);
['title', 'description', 'location'].forEach(n => form.elements[n].addEventListener('input', updateCatHint));
form.elements.startDate.addEventListener('change', () => {
  const f = form.elements;
  if (!f.endDate.value || f.endDate.value < f.startDate.value) f.endDate.value = f.startDate.value;
});
form.elements.startTime.addEventListener('change', () => {
  const f = form.elements;
  if (f.startDate.value === f.endDate.value && f.endTime.value <= f.startTime.value) {
    const [h, m] = f.startTime.value.split(':').map(Number);
    f.endTime.value = `${pad(Math.min(h + 1, 23))}:${pad(m)}`;
  }
});
$('#catChips').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-pick]');
  if (!b) return;
  chosenCat = b.dataset.pick;
  renderCatChips(false);
  updateCatHint();
});
$('#deleteBtn').addEventListener('click', () => {
  if (!editing) return;
  const extra = editing.husbandInvited ? '\n（夫にも取り消しの通知が届きます）' : '';
  if (!confirm(`「${editing.title}」を削除しますか？${extra}`)) return;
  submitOp({ op: 'delete', id: editing.id });
  editor.close();
  toast('削除しました');
});

/* ================= 設定画面 ================= */

const settingsDlg = $('#settings');
const sForm = $('#settingsForm');
let draftCats = [];

function openSettings() {
  const f = sForm.elements;
  f.url.value = state.cfg.url || '';
  f.token.value = state.cfg.token || '';
  f.husbandEmail.value = state.settings.husbandEmail || '';
  draftCats = clone(state.settings.categories);
  renderCatEditor();
  $('#testResult').textContent = '';
  settingsDlg.showModal();
}

function renderCatEditor() {
  const colorOpts = id => Object.keys(COLORS).map(k => `<option value="${k}" ${String(id) === k ? 'selected' : ''}>● ${COLOR_NAMES[k]}</option>`).join('');
  $('#catEditor').innerHTML = draftCats.map((c, i) => `
    <div class="cat-row" data-i="${i}" style="--c:${COLORS[c.colorId]}">
      <select data-f="colorId" aria-label="色" style="color:${COLORS[c.colorId]}">${colorOpts(c.colorId)}</select>
      <input data-f="name" value="${esc(c.name)}" aria-label="カテゴリ名">
      <div class="row-tools">
        <button type="button" data-act="up" aria-label="上へ">↑</button>
        <button type="button" data-act="down" aria-label="下へ">↓</button>
        <button type="button" data-act="del" aria-label="削除">✕</button>
      </div>
      <textarea data-f="keywords" rows="2" aria-label="キーワード" placeholder="キーワード（、区切り）">${esc((c.keywords || []).join('、'))}</textarea>
      <label class="inv"><input type="checkbox" data-f="invite" ${c.invite ? 'checked' : ''}> 💌 このカテゴリの予定は夫を招待する</label>
    </div>`).join('');
  const sel = sForm.elements.defaultCategory;
  const cur = sel.value || state.settings.defaultCategory;
  sel.innerHTML = draftCats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = draftCats.some(c => c.id === cur) ? cur : (draftCats[draftCats.length - 1] || {}).id;
}

function readCatEditor() {
  document.querySelectorAll('#catEditor .cat-row').forEach(row => {
    const c = draftCats[Number(row.dataset.i)];
    c.colorId = row.querySelector('[data-f=colorId]').value;
    c.name = row.querySelector('[data-f=name]').value.trim() || '名前なし';
    c.keywords = row.querySelector('[data-f=keywords]').value.split(/[、,，\n]/).map(s => s.trim()).filter(Boolean);
    c.invite = row.querySelector('[data-f=invite]').checked;
  });
}

$('#catEditor').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  readCatEditor();
  const i = Number(b.closest('.cat-row').dataset.i);
  if (b.dataset.act === 'up' && i > 0) [draftCats[i - 1], draftCats[i]] = [draftCats[i], draftCats[i - 1]];
  if (b.dataset.act === 'down' && i < draftCats.length - 1) [draftCats[i + 1], draftCats[i]] = [draftCats[i], draftCats[i + 1]];
  if (b.dataset.act === 'del') {
    if (draftCats.length <= 1) return;
    if (!confirm(`「${draftCats[i].name}」を削除しますか？`)) return;
    draftCats.splice(i, 1);
  }
  renderCatEditor();
});
$('#catEditor').addEventListener('change', ev => {
  if (ev.target.dataset.f === 'colorId') { readCatEditor(); renderCatEditor(); }
});
$('#addCatBtn').addEventListener('click', () => {
  readCatEditor();
  draftCats.splice(Math.max(draftCats.length - 1, 0), 0, { id: 'c' + Date.now().toString(36), name: '新しいカテゴリ', colorId: '7', invite: false, keywords: [] });
  renderCatEditor();
});

$('#testBtn').addEventListener('click', async () => {
  const f = sForm.elements;
  const r = $('#testResult');
  if (!f.url.value.trim()) { r.className = 'hint ng'; r.textContent = 'URLを入力してください'; return; }
  r.className = 'hint'; r.textContent = '確認中…';
  try {
    await api('ping', {}, { url: f.url.value.trim(), token: f.token.value.trim() });
    r.className = 'hint ok'; r.textContent = '✅ つながりました！ 「保存」を押してください';
  } catch (e) {
    r.className = 'hint ng'; r.textContent = '❌ ' + e.message;
  }
});

sForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  readCatEditor();
  const f = sForm.elements;
  const newCfg = { url: f.url.value.trim(), token: f.token.value.trim() };
  const newSettings = {
    husbandEmail: f.husbandEmail.value.trim(),
    defaultCategory: f.defaultCategory.value,
    categories: draftCats
  };
  if (newSettings.husbandEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newSettings.husbandEmail)) {
    toast('夫のメールアドレスの形式を確認してください'); return;
  }
  const cfgChanged = newCfg.url !== state.cfg.url || newCfg.token !== state.cfg.token;
  try {
    if (newCfg.url && cfgChanged) {
      // 初めて接続するとき（または接続先を変えたとき）は、サーバーに保存されているルールを使う。
      // この端末のルール（デモ用の仮ルールなど）でサーバーを上書きしない。
      const server = (await api('ping', {}, newCfg)).settings;
      if (newSettings.husbandEmail && newSettings.husbandEmail !== server.husbandEmail) {
        server.husbandEmail = newSettings.husbandEmail;
        applySettings((await api('saveSettings', { settings: server }, newCfg)).settings);
      } else {
        applySettings(server);
      }
    } else if (newCfg.url) {
      const data = await api('saveSettings', { settings: newSettings }, newCfg);
      applySettings(data.settings);
    } else {
      applySettings(newSettings);
    }
  } catch (e) {
    toast(e instanceof NetError ? 'オフラインのため設定を保存できません' : e.message);
    return;
  }
  state.cfg = newCfg;
  store.set(LS.cfg, newCfg);
  settingsDlg.close();
  if (cfgChanged) {
    state.demo = !newCfg.url;
    if (state.demo) store.del(LS.events);
    loadEvents();
    render();
    refresh();
  } else {
    render();
  }
  toast(newCfg.url ? '保存しました。10分以内にGoogleカレンダーにも反映されます' : '保存しました（デモ表示）');
});

$('#syncNowBtn').addEventListener('click', async () => {
  if (state.demo) { toast('Googleカレンダーと接続してから使えます'); return; }
  toast('反映しています…（少し時間がかかります）');
  try {
    const r = await api('syncNow');
    toast(r.busy ? '別の処理中です。少し待ってからもう一度押してください' : `${r.checked}件をチェックし、${r.changed}件の色分け・招待を更新しました`);
    refresh();
  } catch (e) { toast(e.message); }
});

$('#clearCacheBtn').addEventListener('click', () => {
  if (state.queue.length && !confirm(`未送信の変更が${state.queue.length}件あります。消してもよいですか？`)) return;
  store.del(LS.events); store.del(LS.queue); store.del(LS.weather);
  state.queue = []; state.weather = null;
  loadEvents();
  settingsDlg.close();
  render();
  refresh();
  fetchWeather(true);
});

/* ================= 操作 ================= */

document.addEventListener('click', ev => {
  const t = ev.target;
  if (t.closest('[data-close]')) { t.closest('dialog').close(); return; }
  if (t.closest('[data-open-settings]')) { openSettings(); return; }
  const cell = t.closest('.cell');
  if (cell) {
    const d = parseDate(cell.dataset.date);
    const sameMonth = d.getMonth() === state.cursor.getMonth();
    state.selected = d;
    if (!sameMonth) state.cursor = startOfMonth(d);
    render();
    if (window.innerWidth < 960) $('#dayPane').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const evBtn = t.closest('.ev');
  if (evBtn) { const e = state.events[evBtn.dataset.key]; if (e) openEditor(e); return; }
  const add = t.closest('[data-add]');
  if (add) { openEditor(null, add.dataset.add); return; }
  const lg = t.closest('#legend button[data-cat]');
  if (lg) {
    const id = lg.dataset.cat;
    if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
    store.set(LS.hidden, [...state.hidden]);
    render();
    return;
  }
  if (t.closest('[data-more]')) { state.listDays += 60; refresh({ min: startOfDay(new Date()), max: addDays(new Date(), state.listDays + 1) }); render(); }
});

// ダイアログの外側タップで閉じる
[editor, settingsDlg].forEach(dlg => dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); }));

const fetchedAt = {};
function goMonth(n) {
  state.cursor = addMonths(state.cursor, n);
  const sameMonthSel = state.selected.getMonth() === state.cursor.getMonth() && state.selected.getFullYear() === state.cursor.getFullYear();
  if (!sameMonthSel) {
    const now = new Date();
    state.selected = (now.getMonth() === state.cursor.getMonth() && now.getFullYear() === state.cursor.getFullYear()) ? startOfDay(now) : state.cursor;
  }
  render();
  const k = ymd(state.cursor);
  if (!fetchedAt[k] || Date.now() - fetchedAt[k] > 5 * 60 * 1000) {
    fetchedAt[k] = Date.now();
    refresh({ min: addMonths(state.cursor, -1), max: addMonths(state.cursor, 2) });
  }
}

$('#prevBtn').addEventListener('click', () => goMonth(-1));
$('#nextBtn').addEventListener('click', () => goMonth(1));
$('#todayBtn').addEventListener('click', () => {
  state.cursor = startOfMonth(new Date());
  state.selected = startOfDay(new Date());
  render();
});
$('#viewBtn').addEventListener('click', () => {
  state.view = state.view === 'month' ? 'list' : 'month';
  store.set(LS.view, state.view);
  render();
});
$('#refreshBtn').addEventListener('click', () => { refresh(); fetchWeather(true); });
$('#settingsBtn').addEventListener('click', openSettings);
$('#fab').addEventListener('click', () => openEditor(null, ymd(state.selected)));

// スワイプで月移動（スマホ）
let touchX = null, touchY = null;
$('#grid').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
$('#grid').addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) goMonth(dx < 0 ? 1 : -1);
  touchX = null;
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
window.addEventListener('online', () => { setOnline(true); flushQueue().then(() => refresh()); fetchWeather(); });
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.lastSynced || Date.now() - state.lastSynced > 3 * 60 * 1000) refresh();
  fetchWeather();
});

/* ================= デモ用のサンプル予定 ================= */

function demoEvents() {
  const out = [];
  const base = addMonths(startOfMonth(new Date()), -1);
  const add = (d, title, sh, sm, eh, em, extra) => {
    const date = ymd(d);
    const e = { id: 'demo' + out.length, calId: 'primary', title, editable: true, location: '', description: '', attendees: [] };
    if (sh == null) { e.allDay = true; e.start = date; e.end = ymd(addDays(d, 1)); }
    else { e.allDay = false; e.start = `${date}T${pad(sh)}:${pad(sm)}:00`; e.end = `${date}T${pad(eh)}:${pad(em)}:00`; }
    out.push(Object.assign(e, extra || {}));
  };
  for (let i = 0; i < 92; i++) {
    const d = addDays(base, i), w = d.getDay(), dd = d.getDate();
    if (w === 0) add(d, '長男・サッカー練習', 8, 30, 10, 30, { husbandInvited: true, location: '区立グラウンド' });
    if (w === 1) add(d, '長女 ピアノ', 17, 0, 17, 45);
    if (w === 2) add(d, '長男と次女 プール', 16, 30, 17, 30);
    if (w === 3) { add(d, '長男 ピアノ', 16, 10, 16, 50); add(d, '長女・新体操', 16, 20, 17, 30); }
    if (w === 4 && dd % 2) add(d, 'ヨガ', 9, 50, 11, 0);
    if (w === 5) { add(d, '長男サッカー', 17, 30, 18, 30, { husbandInvited: true }); add(d, '長女・フラダンス', 17, 45, 18, 45); }
    if (dd === 8) add(d, '音楽教室 リハ', 10, 0, 12, 0, { location: '区民ホール音楽室' });
    if (dd === 12) add(d, '次女・幼稚園 個人面談', 14, 40, 15, 0);
    if (dd === 15) add(d, '父母の会 幹事会', 10, 0, 11, 30);
    if (dd === 18) add(d, '会社 請求書まとめ', 13, 0, 15, 0);
    if (dd === 20) add(d, '友だちとランチ', 12, 0, 14, 0);
    if (dd === 23) add(d, '家族でキャンプ', null, 0, 0, 0, { husbandInvited: true });
    if (dd === 26) add(d, '演奏会 本番', 14, 0, 17, 0);
  }
  out.push({ id: 'demoh1', calId: 'holiday', title: '祝日（サンプル）', allDay: true, holiday: true,
    start: ymd(addDays(startOfMonth(new Date()), 2)), end: ymd(addDays(startOfMonth(new Date()), 3)) });
  return out;
}

/* ================= 起動 ================= */

loadEvents();
render();
fetchWeather();
if (!state.demo) refresh();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW登録失敗', err));
}
