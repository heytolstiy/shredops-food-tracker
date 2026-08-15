/* ── Telegram Web App init ─────────────────────────────────────────────── */
// Optional-chain so the app degrades gracefully when the Telegram SDK
// CDN is unreachable (slow networks, browser testing without Telegram).
const tg = window.Telegram?.WebApp ?? {};
tg.ready?.();
tg.expand?.();

const userId =
  tg.initDataUnsafe?.user?.id ||
  parseInt(new URLSearchParams(window.location.search).get('uid'), 10) ||
  null;

const $ = id => document.getElementById(id);

/* ── XSS guard — escape all user-controlled strings before innerHTML ──── */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Authenticated fetch — attaches Telegram initData on every API call ─ */
function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(tg.initData ? { 'Authorization': `tma ${tg.initData}` } : {}),
    },
  });
}

/* ── Moscow "today" (UTC+3, no DST) — mirrors server-side todayMSK() ─── */
function mskToday() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ── State ─────────────────────────────────────────────────────────────── */
let currentLogs        = [];
let editingLogId       = null;
let currentWaterLogged = 0;
let currentWaterTarget = 2500;
let waterPending       = false;
let currentWeightKg    = null;
let weightPending      = false;
let currentSteps       = null;
let stepsPending       = false;
let currentUser        = null;
let currentWorkout     = null;
let workoutPending     = false;
let activeDate         = mskToday();
let viewingPast        = false;

/* ── Utilities ─────────────────────────────────────────────────────────── */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r     = n => Math.round(n);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fmtDate(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
}

const GOAL_MAP = { lose: 'Похудение', maintain: 'Поддержание', gain: 'Набор массы' };
const GOAL_CLS = { lose: 'lose',      maintain: 'maintain',    gain: 'gain'         };
const RU_DAYS  = ['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];

/* ── Tier system — 4 levels based on current streak ────────────────────── */
const TIERS = [
  { min: 14, n: 4, label: 'ЛЕГЕНДА',  icon: '🏆', color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  { min:  7, n: 3, label: 'МАСТЕР',   icon: '⚡', color: '#7c5cff', bg: 'rgba(124,92,255,0.12)' },
  { min:  3, n: 2, label: 'БОЕЦ',     icon: '💪', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  { min:  0, n: 1, label: 'НОВИЧОК',  icon: '🌱', color: '#16a34a', bg: 'rgba(22,163,74,0.10)'  },
];

function getTier(streak) {
  return TIERS.find(t => streak >= t.min) ?? TIERS[TIERS.length - 1];
}

function ruDays(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

/* ── Timeline: 90-day horizontal strip ────────────────────────────────── */
function buildTimeline() {
  const today = mskToday();
  const cards = [];

  for (let i = 89; i >= 0; i--) {
    // UTC arithmetic avoids local-timezone skew when generating dates
    const mskMs = Date.now() + 3 * 60 * 60 * 1000 - i * 86400000;
    const d     = new Date(mskMs);
    const ymd   = d.toISOString().slice(0, 10);
    const dow   = d.getUTCDay();   // 0 = Sunday
    const day   = d.getUTCDate();

    cards.push(
      `<div class="day-card${ymd === today ? ' active' : ''}" data-date="${ymd}">` +
        `<span class="day-dow">${RU_DAYS[dow]}</span>` +
        `<span class="day-num">${day}</span>` +
      `</div>`
    );
  }

  return cards.join('');
}

function initTimeline() {
  const tl = $('timeline');
  if (!tl) return;
  tl.innerHTML = buildTimeline();
  // Today is always the rightmost card — scroll all the way right
  tl.scrollLeft = tl.scrollWidth;
}

function setTimelineActive(date) {
  document.querySelectorAll('.day-card').forEach(card => {
    card.classList.toggle('active', card.dataset.date === date);
  });
  const activeCard = document.querySelector(`.day-card[data-date="${date}"]`);
  if (activeCard) {
    activeCard.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

/* ── Select a date from the timeline ──────────────────────────────────── */
async function selectDate(date) {
  if (date === activeDate) return;
  activeDate  = date;
  viewingPast = date < mskToday();
  setTimelineActive(date);
  await loadData();
}

/* ── Data loading ──────────────────────────────────────────────────────── */
async function loadData() {
  if (!userId) {
    showError('Нет ID пользователя.<br>Открой через кнопку в боте или добавь ?uid=ТВОЙ_ID в адрес для теста.');
    return;
  }
  try {
    const today = mskToday();
    const url   = activeDate === today
      ? `/api/today/${userId}`
      : `/api/logs/${userId}/${activeDate}`;
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    render(await res.json());
  } catch (err) {
    showError(err.message);
  }
}

/* ── Render: hero ──────────────────────────────────────────────────────── */
function heroHTML(user, totals, date) {
  const target  = user.daily_calories || 1;
  const pct     = clamp(r(totals.cal / target * 100), 0, 100);
  const over    = totals.cal > target;
  const diff    = Math.abs(target - totals.cal);
  const name    = tg.initDataUnsafe?.user?.first_name || user.first_name || '';
  const streak  = user.current_streak || 0;
  const maxStr  = user.max_streak     || 0;
  const tier    = getTier(streak);

  const remainHtml = over
    ? `<span class="surplus">+${diff} лишних</span>`
    : `<span class="remain">${diff} осталось</span>`;

  // Show personal record badge only when max beats current (historical context)
  const recordBadge = maxStr > streak
    ? `<span class="streak-max">рекорд&nbsp;${maxStr}</span>`
    : '';

  return `
    <div class="card hero">
      <div class="hero-top">
        <div class="hero-top-left">
          <div class="hero-avatar"
               style="--tier-color:${tier.color};--tier-bg:${tier.bg}">
            <span class="hero-avatar-icon">${tier.icon}</span>
            <span class="hero-avatar-tier">T${tier.n}&nbsp;${tier.label}</span>
          </div>
          <div>
            <p class="hero-date">${fmtDate(date)}</p>
            ${name ? `<p class="hero-name">${esc(name)}</p>` : ''}
          </div>
        </div>
        <span class="goal-badge ${GOAL_CLS[user.goal] || 'maintain'}">${esc(GOAL_MAP[user.goal] || user.goal)}</span>
      </div>

      <div class="hero-streak">
        <span class="streak-flame">🔥</span>
        <span class="streak-count">${streak}</span>
        <span class="streak-label">${ruDays(streak)} подряд</span>
        ${recordBadge}
      </div>

      <div class="hero-cal-row">
        <span class="hero-num">${totals.cal.toLocaleString('ru')}</span>
        <span class="hero-unit">ккал</span>
      </div>

      <p class="hero-caption">
        из <strong>${target.toLocaleString('ru')}</strong> ккал &nbsp;·&nbsp; ${remainHtml}
      </p>

      <div class="hero-bar-wrap">
        <div class="prog-track">
          <div class="prog-fill${over ? ' over' : ''}" style="width:${pct}%"></div>
        </div>
        <span class="prog-pct">${pct}%</span>
      </div>
    </div>`;
}

/* ── Render: macro card ────────────────────────────────────────────────── */
function macroCard(label, value, target, fillCls, cardCls) {
  const pct  = clamp(r(value / (target || 1) * 100), 0, 999);
  const barW = clamp(pct, 0, 100);
  const over = pct > 100;
  return `
    <div class="card macro-card ${cardCls}">
      <p class="mc-label">${label}</p>
      <div class="mc-val-row">
        <span class="mc-val">${r(value)}</span>
        <span class="mc-unit">г</span>
      </div>
      <div class="mc-track">
        <div class="mc-fill ${over ? 'over' : fillCls}" style="width:${barW}%"></div>
      </div>
      <p class="mc-meta">из ${target}г &nbsp;·&nbsp; ${pct}%</p>
    </div>`;
}

/* ── Render: water section ─────────────────────────────────────────────── */
function waterHTML(target, logged) {
  const CELL_ML     = 250;
  const totalCells  = clamp(Math.ceil(target / CELL_ML), 6, 10);
  const filledCells = Math.min(Math.floor(logged / CELL_ML), totalCells);
  const pct         = Math.min(r(logged / (target || 1) * 100), 100);

  const cells = Array.from({ length: totalCells }, (_, i) =>
    `<div class="water-cell${i < filledCells ? ' filled' : ''}">💧</div>`
  ).join('');

  const hint = viewingPast
    ? 'Просмотр прошлого дня — редактирование недоступно'
    : 'Нажми ячейку — +250 мл';

  return `
    <p class="section-label">Гидратация</p>
    <div class="card">
      <div class="water-header">
        <div class="water-num-row">
          <span class="water-num">${logged}</span>
          <span class="water-unit-lbl">мл</span>
        </div>
        <div class="water-meta">из ${target} мл &nbsp;·&nbsp; ${pct}%</div>
      </div>
      <div class="water-cells${viewingPast ? ' readonly' : ''}">${cells}</div>
      <p class="water-hint">${hint}</p>
    </div>`;
}

/* ── Render: weight section ────────────────────────────────────────────── */
function weightHTML(weightKg, isPast) {
  if (isPast) {
    return `
      <p class="section-label">Вес</p>
      <div class="card weight-card">
        ${weightKg != null
          ? `<div class="weight-display"><span class="weight-num">${weightKg}</span><span class="weight-unit">кг</span></div>`
          : `<p class="weight-hint">Вес в этот день не записан.</p>`}
      </div>`;
  }

  return `
    <p class="section-label">Вес</p>
    <div class="card weight-card">
      <div class="weight-row">
        <input class="weight-input" id="weight-input" type="number" inputmode="decimal"
               step="0.1" min="20" max="300"
               value="${weightKg != null ? weightKg : ''}" placeholder="—">
        <span class="weight-unit">кг</span>
        <button class="weight-save-btn" id="weight-save-btn" type="button" aria-label="Сохранить">✓</button>
      </div>
      <p class="weight-hint">Повторное сохранение за сегодня перезапишет значение.</p>
    </div>`;
}

/* ── Weight: save today's entry (upsert, overwrite-safe) ────────────────── */
async function saveWeight() {
  if (weightPending || viewingPast) return;

  const input = $('weight-input');
  const val   = parseFloat(input?.value);

  if (isNaN(val) || val < 20 || val > 300) {
    const msg = 'Введи вес числом от 20 до 300 кг.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
    return;
  }

  weightPending = true;
  const btn = $('weight-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const res = await apiFetch('/api/weight', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, weight_kg: val }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const { weightKg } = await res.json();
    currentWeightKg = weightKg;
    tg.HapticFeedback?.notificationOccurred?.('success');
    $('weight-section').innerHTML = weightHTML(weightKg, false);
    attachWeightHandlers();
  } catch (err) {
    console.error('[weight] POST error:', err);
    const msg = 'Не удалось сохранить вес. Попробуй ещё раз.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
  } finally {
    weightPending = false;
    const btnAgain = $('weight-save-btn');
    if (btnAgain) { btnAgain.disabled = false; btnAgain.textContent = '✓'; }
  }
}

// Re-bind after every innerHTML replace — the button element is recreated each render
function attachWeightHandlers() {
  $('weight-save-btn')?.addEventListener('click', saveWeight);
}

/* ── Render: steps section ─────────────────────────────────────────────── */
function stepsHTML(steps, isPast) {
  if (isPast) {
    return `
      <p class="section-label">Шаги</p>
      <div class="card steps-card">
        ${steps != null
          ? `<div class="steps-display"><span class="steps-num">${steps}</span></div>`
          : `<p class="steps-hint">Шаги в этот день не записаны.</p>`}
      </div>`;
  }

  return `
    <p class="section-label">Шаги</p>
    <div class="card steps-card">
      <div class="steps-row">
        <input class="steps-input" id="steps-input" type="number" inputmode="numeric"
               step="1" min="0" max="200000"
               value="${steps != null ? steps : ''}" placeholder="—">
        <button class="steps-save-btn" id="steps-save-btn" type="button" aria-label="Сохранить">✓</button>
      </div>
      <p class="steps-hint">Повторное сохранение за сегодня перезапишет значение.</p>
    </div>`;
}

/* ── Steps: save today's entry (upsert, overwrite-safe) ──────────────────── */
async function saveSteps() {
  if (stepsPending || viewingPast) return;

  const input = $('steps-input');
  const val   = Math.round(Number(input?.value));

  if (isNaN(val) || val < 0 || val > 200000) {
    const msg = 'Введи шаги числом от 0 до 200000.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
    return;
  }

  stepsPending = true;
  const btn = $('steps-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const res = await apiFetch('/api/steps', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, steps: val }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const { steps } = await res.json();
    currentSteps = steps;
    tg.HapticFeedback?.notificationOccurred?.('success');
    $('steps-section').innerHTML = stepsHTML(steps, false);
    attachStepsHandlers();
  } catch (err) {
    console.error('[steps] POST error:', err);
    const msg = 'Не удалось сохранить шаги. Попробуй ещё раз.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
  } finally {
    stepsPending = false;
    const btnAgain = $('steps-save-btn');
    if (btnAgain) { btnAgain.disabled = false; btnAgain.textContent = '✓'; }
  }
}

// Re-bind after every innerHTML replace — the button element is recreated each render
function attachStepsHandlers() {
  $('steps-save-btn')?.addEventListener('click', saveSteps);
}

/* ── Render: workout section ───────────────────────────────────────────── */
// Structured input (name + free-text detail) that assembles into the same
// plain-text `description` the backend has always stored — no schema/API
// change, just a friendlier way to build that string. The detail field is
// deliberately free text, not a fixed "sets × assumed reps" number: that
// assumption doesn't hold for cardio (minutes/speed/distance) or for
// strength sets with varying weight per set (pyramid: 40×10, 50×8, 60×6).
// Editing always starts from a blank form: past entries (however they were
// written — via this form or the bot's free-text /workout) are never parsed
// back into rows, they just get overwritten on save like weight/steps already do.
function workoutRowHTML(name = '', detail = '') {
  return `
    <div class="workout-row">
      <input class="workout-name-input" type="text" placeholder="Упражнение" value="${esc(name)}">
      <input class="workout-detail-input" type="text" placeholder="3×10, 40кг / 20 мин, 8 км/ч" value="${esc(detail)}">
      <button class="workout-remove-row" type="button" aria-label="Удалить">✕</button>
    </div>`;
}

function workoutHTML(description, isPast) {
  if (isPast) {
    return `
      <p class="section-label">Тренировка</p>
      <div class="card workout-card">
        ${description
          ? `<p class="workout-display">${esc(description)}</p>`
          : `<p class="workout-hint">Тренировка в этот день не записана.</p>`}
      </div>`;
  }

  return `
    <p class="section-label">Тренировка</p>
    <div class="card workout-card">
      <div class="workout-rows" id="workout-rows">${workoutRowHTML()}</div>
      <button class="workout-add-row" id="workout-add-row" type="button">+ Добавить упражнение</button>
      <button class="workout-save-btn" id="workout-save-btn" type="button">Сохранить</button>
      <p class="workout-hint">Пиши как удобно: подходы, вес, время, дистанция. Повторное сохранение за сегодня перезапишет запись.</p>
    </div>`;
}

/* ── Workout: collect filled rows → "Название — деталь" per line ─────────── */
function collectWorkoutRows() {
  return [...document.querySelectorAll('#workout-rows .workout-row')]
    .map(row => ({
      name:   row.querySelector('.workout-name-input')?.value.trim() || '',
      detail: row.querySelector('.workout-detail-input')?.value.trim() || '',
    }))
    .filter(r => r.name && r.detail);
}

/* ── Workout: save today's entry (upsert, overwrite-safe) ────────────────── */
async function saveWorkout() {
  if (workoutPending || viewingPast) return;

  const rows = collectWorkoutRows();
  if (!rows.length) {
    const msg = 'Добавь хотя бы одно упражнение с деталями (подходы, время и т.д.).';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
    return;
  }

  const description = rows.map(r => `${r.name} — ${r.detail}`).join('\n');
  if (description.length > 2000) {
    const msg = 'Слишком длинная запись (максимум 2000 символов).';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
    return;
  }

  workoutPending = true;
  const btn = $('workout-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const res = await apiFetch('/api/workout', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, description }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    await res.json();
    currentWorkout = description;
    tg.HapticFeedback?.notificationOccurred?.('success');
    if (btn) btn.textContent = 'Сохранено ✓';
    setTimeout(() => { if (btn && !workoutPending) btn.textContent = 'Сохранить'; }, 1200);
  } catch (err) {
    console.error('[workout] POST error:', err);
    if (btn) btn.textContent = 'Сохранить';
    const msg = 'Не удалось сохранить тренировку. Попробуй ещё раз.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
  } finally {
    workoutPending = false;
    if (btn) btn.disabled = false;
  }
}

// Re-bind after every innerHTML replace — elements are recreated each render
function attachWorkoutHandlers() {
  $('workout-save-btn')?.addEventListener('click', saveWorkout);
  $('workout-add-row')?.addEventListener('click', () => {
    $('workout-rows')?.insertAdjacentHTML('beforeend', workoutRowHTML());
  });
  $('workout-rows')?.addEventListener('click', e => {
    if (!e.target.closest('.workout-remove-row')) return;
    const rows = $('workout-rows');
    const row  = e.target.closest('.workout-row');
    row?.remove();
    // Never leave zero rows — always keep one ready to type into
    if (rows && !rows.querySelector('.workout-row')) {
      rows.insertAdjacentHTML('beforeend', workoutRowHTML());
    }
  });
}

/* ── Render: log card ──────────────────────────────────────────────────── */
function logCard(entry) {
  const name   = entry.raw_ai_response?.identified_food || entry.description;
  const weight = entry.raw_ai_response?.assumed_weight_g;
  const isText = !entry.photo_file_id;

  const actions = viewingPast ? '' : `
    <div class="lc-actions">
      <button class="lc-btn lc-btn-edit" aria-label="Редактировать">✏ EDIT</button>
      <button class="lc-btn lc-btn-del"  aria-label="Удалить">✕ DEL</button>
    </div>`;

  return `
    <div class="log-card" data-log-id="${entry.id}">
      <div class="log-card-inner">
        <div class="lc-top">
          <span class="lc-name">${esc(name)}</span>
          <span class="lc-time">${fmtTime(entry.logged_at)}</span>
        </div>
        <div class="lc-mid">
          <span class="lc-kcal">${entry.calories} ккал</span>
          ${weight ? `<span class="lc-weight">${esc(weight)}г</span>` : ''}
        </div>
        <div class="lc-pills">
          <span class="pill">Б <b>${r(entry.protein_g)}</b></span>
          <span class="pill">Ж <b>${r(entry.fat_g)}</b></span>
          <span class="pill">У <b>${r(entry.carbs_g)}</b></span>
          <span class="src-badge ${isText ? 'text' : 'photo'}">${isText ? 'текст' : 'фото'}</span>
        </div>
        ${actions}
      </div>
    </div>`;
}

/* ── Main render ───────────────────────────────────────────────────────── */
function render(data) {
  const { user, logs, date, waterLogged, weightKg, steps, workout } = data;
  currentLogs        = logs;
  currentWaterLogged = waterLogged || 0;
  currentWaterTarget = user.target_water_ml || 2500;
  currentWeightKg    = weightKg ?? null;
  currentSteps       = steps ?? null;
  currentUser        = user;
  currentWorkout     = workout ?? null;

  const totals = logs.reduce(
    (a, e) => ({
      cal: a.cal + (e.calories     || 0),
      pro: a.pro + parseFloat(e.protein_g || 0),
      fat: a.fat + parseFloat(e.fat_g     || 0),
      car: a.car + parseFloat(e.carbs_g   || 0),
    }),
    { cal: 0, pro: 0, fat: 0, car: 0 }
  );

  $('hero-section').innerHTML = heroHTML(user, totals, date);

  const targetsEditBtn = viewingPast
    ? ''
    : `<button class="section-edit-btn" id="targets-edit-btn" type="button">✏️ ЦЕЛИ</button>`;

  $('macro-section').innerHTML = `
    <div class="section-label-row">
      <p class="section-label">Макронутриенты</p>
      ${targetsEditBtn}
    </div>
    <div class="macro-grid">
      ${macroCard('Белки',    totals.pro, user.daily_protein_g, 'pro',  'mc-pro')}
      ${macroCard('Жиры',     totals.fat, user.daily_fat_g,     'fat',  'mc-fat')}
      ${macroCard('Углеводы', totals.car, user.daily_carbs_g,   'carb', 'mc-carb')}
    </div>`;

  $('water-section').innerHTML = waterHTML(currentWaterTarget, currentWaterLogged);

  $('weight-section').innerHTML = weightHTML(currentWeightKg, viewingPast);
  attachWeightHandlers();

  $('steps-section').innerHTML = stepsHTML(currentSteps, viewingPast);
  attachStepsHandlers();

  $('workout-section').innerHTML = workoutHTML(currentWorkout, viewingPast);
  attachWorkoutHandlers();

  const emptyMsg = viewingPast
    ? 'В этот день ничего не записано.'
    : 'Отправь фото или напиши название блюда прямо в бот.';

  if (!logs.length) {
    $('log-section').innerHTML = `
      <p class="section-label">Журнал</p>
      <div class="card">
        <div class="empty-state">
          <div class="empty-icon">🍽️</div>
          <p>Записей пока нет.<br>${emptyMsg}</p>
        </div>
      </div>`;
    return;
  }

  const n      = logs.length;
  const plural = n === 1 ? 'запись' : n < 5 ? 'записи' : 'записей';

  $('log-section').innerHTML = `
    <p class="section-label">Журнал — ${n} ${plural}</p>
    <div class="log-list">${logs.map(logCard).join('')}</div>
    <div class="log-total">
      <span class="log-total-label">Итого</span>
      <span class="log-total-val">
        ${totals.cal} ккал &nbsp;·&nbsp; Б${r(totals.pro)} Ж${r(totals.fat)} У${r(totals.car)}
      </span>
    </div>`;
}

/* ── Error state ───────────────────────────────────────────────────────── */
function showError(msg) {
  $('hero-section').innerHTML  = `
    <div class="card error-card">
      <div class="error-icon">⚠️</div>
      ${msg}
    </div>`;
  $('macro-section').innerHTML   = '';
  $('water-section').innerHTML   = '';
  $('weight-section').innerHTML  = '';
  $('steps-section').innerHTML   = '';
  $('workout-section').innerHTML = '';
  $('log-section').innerHTML     = '';
}

/* ── Water: counter-only DOM update (no full re-render) ─────────────────  */
function syncWaterDisplay(logged) {
  const numEl  = document.querySelector('.water-num');
  const metaEl = document.querySelector('.water-meta');
  if (!numEl || !metaEl) return;
  const pct = Math.min(r(logged / (currentWaterTarget || 1) * 100), 100);
  numEl.textContent  = logged;
  metaEl.textContent = `из ${currentWaterTarget} мл  ·  ${pct}%`;
}

/* ── Water: log one cell (250 ml) — race-condition-safe ─────────────────  */
async function logWater(cellEl) {
  if (waterPending || viewingPast) return;
  waterPending = true;

  tg.HapticFeedback?.impactOccurred?.('light');

  // Optimistic fill for animation feel
  cellEl.classList.add('filled');
  syncWaterDisplay(currentWaterLogged + 250);

  // Dim the whole cell row to block further taps during the request
  const cellsEl = document.querySelector('.water-cells');
  if (cellsEl) cellsEl.classList.add('pending');

  try {
    const res = await apiFetch('/api/water', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, amount: 250 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { waterLogged } = await res.json();
    // Server-confirmed total resolves any race from rapid taps
    currentWaterLogged = waterLogged;
    // Full re-render of water section from confirmed state
    $('water-section').innerHTML = waterHTML(currentWaterTarget, waterLogged);
  } catch (err) {
    // Rollback optimistic fill
    cellEl.classList.remove('filled');
    syncWaterDisplay(currentWaterLogged);
    console.error('[water] POST error:', err);
    // Remove pending from element that may not have been re-rendered
    document.querySelector('.water-cells')?.classList.remove('pending');
  } finally {
    waterPending = false;
  }
}

/* ── Modal ─────────────────────────────────────────────────────────────── */
function openModal(logId, entry) {
  editingLogId        = logId;
  $('edit-cal').value = entry.calories                           || 0;
  $('edit-pro').value = Math.round(parseFloat(entry.protein_g)) || 0;
  $('edit-fat').value = Math.round(parseFloat(entry.fat_g))     || 0;
  $('edit-car').value = Math.round(parseFloat(entry.carbs_g))   || 0;
  $('edit-wt').value  = entry.raw_ai_response?.assumed_weight_g || 0;
  $('edit-modal').classList.remove('hidden');
}

function closeModal() {
  editingLogId = null;
  $('edit-modal').classList.add('hidden');
}

$('modal-cancel').addEventListener('click', closeModal);

$('edit-modal').addEventListener('click', e => {
  if (e.target === $('edit-modal')) closeModal();
});

$('edit-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editingLogId) return;

  const body = {
    calories:  Number($('edit-cal').value),
    protein_g: Number($('edit-pro').value),
    fat_g:     Number($('edit-fat').value),
    carbs_g:   Number($('edit-car').value),
    weight_g:  Number($('edit-wt').value),
  };

  try {
    const res = await apiFetch(`/api/logs/${editingLogId}?userId=${userId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    closeModal();
    loadData();
  } catch (err) {
    console.error('[edit] PUT error:', err);
  }
});

/* ── Targets modal — manual daily calorie/macro correction ──────────────── */
function openTargetsModal() {
  if (!currentUser) return;
  $('targets-cal').value = currentUser.daily_calories  || 0;
  $('targets-pro').value = currentUser.daily_protein_g || 0;
  $('targets-fat').value = currentUser.daily_fat_g     || 0;
  $('targets-car').value = currentUser.daily_carbs_g   || 0;
  $('targets-modal').classList.remove('hidden');
}

function closeTargetsModal() {
  $('targets-modal').classList.add('hidden');
}

$('targets-modal-cancel').addEventListener('click', closeTargetsModal);

$('targets-modal').addEventListener('click', e => {
  if (e.target === $('targets-modal')) closeTargetsModal();
});

$('targets-form').addEventListener('submit', async e => {
  e.preventDefault();

  const body = {
    userId,
    calories:  Number($('targets-cal').value),
    protein_g: Number($('targets-pro').value),
    fat_g:     Number($('targets-fat').value),
    carbs_g:   Number($('targets-car').value),
  };

  try {
    const res = await apiFetch('/api/targets', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    closeTargetsModal();
    loadData();
  } catch (err) {
    console.error('[targets] PUT error:', err);
    const msg = 'Не удалось сохранить цели. Проверь значения и попробуй ещё раз.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
  }
});

/* ── Weekly export — always last 7 days from today, independent of the ──
   timeline's selected date, so no viewingPast gating here. ─────────────── */
function weekReportFilename() {
  const today = mskToday();
  const start = new Date(new Date(`${today}T00:00:00Z`).getTime() - 6 * 86400000).toISOString().slice(0, 10);
  return `report-${start}_${today}.md`;
}

async function downloadWeeklyReport() {
  const btn = $('export-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Формирую...'; }

  try {
    const res = await apiFetch(`/api/export/week/${userId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = weekReportFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[export] error:', err);
    const msg = 'Не удалось сформировать отчёт. Попробуй ещё раз.';
    tg.showAlert ? tg.showAlert(msg) : alert(msg);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Скачать отчёт за 7 дней'; }
  }
}

$('export-btn')?.addEventListener('click', downloadWeeklyReport);

/* ── Delete ────────────────────────────────────────────────────────────── */
async function deleteLog(logId) {
  try {
    const res = await apiFetch(`/api/logs/${logId}?userId=${userId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadData();
  } catch (err) {
    console.error('[delete] error:', err);
  }
}

/* ── Unified event delegation ──────────────────────────────────────────── */
document.addEventListener('click', e => {
  // Timeline day-card click
  const dayCard = e.target.closest('.day-card');
  if (dayCard) {
    selectDate(dayCard.dataset.date);
    return;
  }

  // All mutable actions are disabled when viewing a past day
  if (viewingPast) return;

  // Targets edit
  if (e.target.closest('#targets-edit-btn')) {
    openTargetsModal();
    return;
  }

  // Food log edit
  const editBtn = e.target.closest('.lc-btn-edit');
  if (editBtn) {
    const logId = Number(editBtn.closest('[data-log-id]').dataset.logId);
    const entry = currentLogs.find(l => l.id === logId);
    if (entry) openModal(logId, entry);
    return;
  }

  // Food log delete
  const delBtn = e.target.closest('.lc-btn-del');
  if (delBtn) {
    const logId = Number(delBtn.closest('[data-log-id]').dataset.logId);
    if (tg.showConfirm) {
      tg.showConfirm('Удалить эту запись?', ok => { if (ok) deleteLog(logId); });
    } else if (window.confirm('Удалить эту запись?')) {
      deleteLog(logId);
    }
    return;
  }

  // Water cell tap — only unfilled, only when no request is in-flight
  const waterCell = e.target.closest('.water-cell');
  if (waterCell && !waterCell.classList.contains('filled') && !waterPending) {
    logWater(waterCell);
  }
});

/* ── Tab bar — pure display toggle, no effect on data loading/rendering ── */
let activeTab = 'today';

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  $('tab-today').classList.toggle('tab-hidden', tab !== 'today');
  $('tab-activity').classList.toggle('tab-hidden', tab !== 'activity');
  $('tab-btn-today').classList.toggle('active', tab === 'today');
  $('tab-btn-activity').classList.toggle('active', tab === 'activity');
}

$('tab-btn-today').addEventListener('click', () => switchTab('today'));
$('tab-btn-activity').addEventListener('click', () => switchTab('activity'));

/* ── Boot ──────────────────────────────────────────────────────────────── */
initTimeline();
loadData();
