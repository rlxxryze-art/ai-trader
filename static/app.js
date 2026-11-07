const $ = (id) => document.getElementById(id);
const eur = (n, d = 2) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(n ?? 0);
const pct = (n) => `${n >= 0 ? '+' : ''}${(n ?? 0).toFixed(2).replace('.', ',')} %`;
const qty = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: n < 1 ? 6 : 4 }).format(n ?? 0);
const when = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const tone = (n) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : 'flat');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTION_FR = { BUY: 'Achat', SELL: 'Vente', HOLD: 'Conserver' };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let chart = null, timer = null, nextRun = null, running = false, wasRunning = false, tags = {}, seen = null;
const cache = {};
const setHTML = (el, key, html) => { if (cache[key] !== html) { cache[key] = html; el.innerHTML = html; } };

/* ---------- Micro-sons FX : colle tes URLs audio ici ---------- */
const SFX = { hover: '', click: '', toggle: '', success: '' };
const sfx = (k) => { if (!SFX[k]) return; const a = new Audio(SFX[k]); a.volume = .25; a.play().catch(() => {}); };
document.addEventListener('pointerover', (e) => { const t = e.target.closest('[data-sfx]'); if (t && !t.contains(e.relatedTarget)) sfx('hover'); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-sfx]')) sfx('click'); });

/* ---------- Bordure néon qui suit la souris ---------- */
document.addEventListener('pointermove', (e) => {
  const g = e.target.closest('.glass'); if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty('--mx', `${e.clientX - r.left}px`); g.style.setProperty('--my', `${e.clientY - r.top}px`);
});

/* ---------- API (inchangé) ---------- */
async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { const e = new Error(r.statusText); e.status = r.status; throw e; }
  return r.json();
}

/* ---------- Toasts ---------- */
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg;
  $('toasts').appendChild(t); requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 4200);
}

/* ---------- Terminal IA (machine à écrire) ---------- */
const term = $('term'), queue = []; let typing = false;
function log(msg, cls = '') { queue.push([msg, cls]); if (!typing) typeNext(); }
function typeNext() {
  const it = queue.shift(); if (!it) { typing = false; return; }
  typing = true;
  const l = document.createElement('div'); l.className = `ln ${it[1]}`; term.appendChild(l);
  const text = `> ${it[0]}`; let i = 0;
  (function step() {
    l.textContent = text.slice(0, ++i); term.scrollTop = term.scrollHeight;
    if (reduced) i = text.length;
    if (i < text.length) setTimeout(step, queue.length > 5 ? 3 : 16);
    else { while (term.children.length > 60) term.firstChild.remove(); typeNext(); }
  })();
}

function logDecisions(items) {
  const ts = (d) => new Date(d.ts).getTime();
  const fresh = (seen === null ? items.slice(0, 1) : items.filter((d) => ts(d) > seen)).sort((a, b) => ts(a) - ts(b));
  if (items.length) seen = Math.max(seen ?? 0, ...items.map(ts));
  fresh.forEach((d) => {
    log(`Scan du marché… (${when(d.ts)})`, 'dim');
    if (d.market_view) log(d.market_view.slice(0, 160));
    if (d.error) log(`Erreur : ${d.error}`, 'err');
    d.orders.forEach((o) => {
      if (o.status === 'executed') {
        log(`${ACTION_FR[o.action] || o.action} validé : ${o.name} ${eur(o.amount_eur)}`, 'ok');
        if (seen !== null && fresh.length && wasLoaded) { toast(`⚡ Action exécutée par l’IA : ${ACTION_FR[o.action] || o.action} ${o.name}`, 'ok'); sfx('success'); }
      } else if (o.status === 'rejected') log(`Ordre refusé : ${o.name}${o.note ? ' – ' + o.note : ''}`, 'warn');
    });
  });
}

/* ---------- Jauge Fear & Greed ---------- */
async function gauge() {
  let v = NaN;
  try { v = +(await api('https://api.alternative.me/fng/?limit=1')).data[0].value; } catch (e) {}
  const est = isNaN(v); if (est) v = 50;
  const lbl = v < 25 ? 'Peur extrême' : v < 45 ? 'Peur' : v < 56 ? 'Neutre' : v < 75 ? 'Avidité' : 'Avidité extrême';
  $('fg-lbl').textContent = est ? 'Indice indisponible' : lbl;
  requestAnimationFrame(() => { $('needle').style.transform = `rotate(${v * 1.8 - 90}deg)`; });
  const t0 = performance.now();
  (function count(t) { const k = Math.min(1, (t - t0) / 1600); $('fg-val').textContent = Math.round(v * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(count); })(t0);
  log(`Sentiment du marché : ${est ? 'indisponible' : `${v}/100 (${lbl})`}`, 'dim');
}

/* ---------- Rangs ---------- */
const RANKS = [[-Infinity, 'Recrue', '#94a3b8'], [0, 'Bronze', '#d97706'], [1, 'Argent', '#cbd5e1'], [3, 'Or', '#fbbf24'], [6, 'Platine', '#2dd4bf'], [10, 'Diamant', '#38bdf8'], [20, 'Champion', '#a78bfa'], [35, 'Supersonic Legend', '#f472b6'], [60, 'Unreal', '#f43f5e']];
function renderRank(s) {
  const p = s.deposited ? s.pnl_pct : -1;
  let i = 0; RANKS.forEach((r, k) => { if (p >= r[0]) i = k; });
  const cur = RANKS[i], nxt = RANKS[i + 1], el = $('rank');
  el.style.setProperty('--rk', cur[2]); el.style.setProperty('--lv', i);
  $('rank-n').textContent = i + 1; $('rank-name').textContent = cur[1];
  const prog = nxt ? (i === 0 ? 0 : (p - cur[0]) / (nxt[0] - cur[0])) : 1;
  $('rank-bar').style.width = `${Math.max(0, Math.min(1, prog)) * 100}%`;
  $('rank-next').textContent = nxt ? `Prochain rang : ${nxt[1]} à ${nxt[0]} %` : 'Rang maximum atteint';
}

/* ---------- Rendus ---------- */
function setStatus(kind) {
  const map = { live: ['IA active', ''], busy: ['Analyse en cours…', 'busy'], error: ['Serveur injoignable', 'error'] };
  $('status-text').textContent = map[kind][0];
  $('dot').className = `dot ${map[kind][1]}`;
}

function renderSummary(s) {
  running = s.running;
  $('kpi-total').textContent = eur(s.total);
  $('kpi-cash').textContent = eur(s.cash);
  $('kpi-invested').textContent = eur(s.holdings_value);
  $('kpi-deposited').textContent = eur(s.deposited);
  const p = $('kpi-pnl');
  p.textContent = s.deposited ? `${pct(s.pnl_pct)} (${s.pnl_eur >= 0 ? '+' : ''}${eur(s.pnl_eur)})` : 'Aucun dépôt pour l’instant';
  p.className = `pill num ${s.deposited ? (tone(s.pnl_eur) === 'up' ? 'pill-up' : tone(s.pnl_eur) === 'down' ? 'pill-down' : '') : ''}`;
  document.body.dataset.mood = s.deposited ? tone(s.pnl_eur) : 'flat';
  nextRun = s.next_run ? new Date(s.next_run) : null;
  $('run-btn').disabled = running;
  $('run-btn').textContent = running ? 'Analyse en cours…' : 'Lancer l’analyse';
  setStatus(running ? 'busy' : 'live');
  if (running && !wasRunning) log('Analyse en cours… Gemini scanne le marché', 'dim');
  wasRunning = running;
}

function renderHoldings(rows) {
  setHTML($('holdings'), 'h', !rows.length
    ? `<p class="text-sm text-slate-500 col-span-full text-center py-10">Aucun actif pour l’instant. Lancez une analyse pour que l’IA investisse les premiers 50 €.</p>`
    : rows.map((h) => `
    <article class="glass hcard tilt">
      <div class="flex items-center gap-3"><div class="avatar">${esc(h.symbol.slice(0, 3))}</div>
        <div class="min-w-0"><div class="font-medium text-white truncate">${esc(h.name)}</div><div class="text-xs text-slate-500">${esc(h.symbol)}, ${esc(h.type)}</div></div>
        <span class="ml-auto num font-medium ${tone(h.pnl_pct)}">${pct(h.pnl_pct)}</span></div>
      <div class="mt-5 flex items-end justify-between gap-3">
        <div><div class="text-xs text-slate-500">Valeur</div><div class="display text-xl text-white num">${eur(h.value)}</div></div>
        <div class="text-right text-xs text-slate-400 num">${qty(h.quantity)} × ${eur(h.price, h.price < 1 ? 4 : 2)}</div></div>
    </article>`).join(''));
}

function renderTicker(rows) {
  const items = rows.length ? rows.map((h) => `<span class="tk"><b>${esc(h.symbol)}</b><span class="num">${eur(h.price, h.price < 1 ? 4 : 2)}</span><span class="num ${tone(h.pnl_pct)}">${pct(h.pnl_pct)}</span></span>`).join('') : `<span class="tk">En attente des premiers actifs du portefeuille…</span>`;
  const half = items.repeat(Math.max(2, Math.ceil(8 / Math.max(rows.length, 1))));
  setHTML($('ticker'), 't', half + half);
}

function renderDecisions(items) {
  const el = $('decisions');
  if (!items.length) { setHTML(el, 'd', `<p class="text-sm text-slate-500">Aucune décision pour l’instant. La première analyse démarre à l’heure prévue, ou avec le bouton en haut.</p>`); return; }
  setHTML(el, 'd', items.map((d) => `
    <article class="decision">
      <div class="flex items-center justify-between mb-1.5">
        <time class="text-xs text-slate-500">${when(d.ts)}</time>
        <span class="pill ${d.status === 'ok' ? '' : 'pill-down'}" style="padding:.1rem .5rem;font-size:.72rem">${d.status === 'ok' ? 'Analyse terminée' : 'Erreur'}</span>
      </div>
      ${d.market_view ? `<p class="text-sm text-slate-300 mb-2">${esc(d.market_view)}</p>` : ''}
      ${d.error ? `<p class="text-sm down mb-2">${esc(d.error)}</p>` : ''}
      <ul class="space-y-2">${d.orders.map((o) => `
        <li class="order ${o.status === 'rejected' ? 'rejected' : ''}">
          <div class="flex items-center gap-2">
            <span class="chip chip-${esc(o.action)}">${ACTION_FR[o.action] || esc(o.action)}</span>
            <span class="sym text-sm font-medium text-white">${esc(o.name)}</span>
            ${o.status === 'executed' ? `<span class="ml-auto text-sm num text-slate-300">${eur(o.amount_eur)}</span>` : ''}
          </div>
          ${o.reason ? `<p class="text-xs text-slate-400 mt-1">${esc(o.reason)}</p>` : ''}
          ${o.note ? `<p class="text-xs text-amber-300/80 mt-0.5">${esc(o.note)}</p>` : ''}
        </li>`).join('')}</ul>
    </article>`).join(''));
}

/* ---------- Graphique + marqueurs d'actions ---------- */
const glow = {
  id: 'glow',
  beforeDatasetDraw(c, a) { if (a.index !== 1) { c.ctx.save(); c.ctx.shadowColor = 'rgba(139,92,246,.85)'; c.ctx.shadowBlur = 16; } },
  afterDatasetDraw(c, a) { if (a.index !== 1) c.ctx.restore(); },
};

function renderChart(rows, decs) {
  const labels = rows.map((r) => when(r.ts));
  const total = rows.map((r) => r.total), dep = rows.map((r) => r.deposited);
  const ts = rows.map((r) => new Date(r.ts).getTime()), mk = rows.map(() => null), col = []; tags = {};
  if (rows.length) decs.forEach((d) => d.orders.forEach((o) => {
    if (o.status !== 'executed' || o.action === 'HOLD') return;
    const t = new Date(d.ts).getTime(); let b = 0;
    ts.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(ts[b] - t)) b = i; });
    mk[b] = total[b]; col[b] = o.action === 'SELL' ? '#fb7185' : '#34d399'; tags[b] = `${ACTION_FR[o.action]} ${o.name} ${eur(o.amount_eur)}`;
  }));
  if (chart) {
    chart.data.labels = labels; const [a, b, m] = chart.data.datasets;
    a.data = total; b.data = dep; m.data = mk; m.pointBackgroundColor = col; m.pointBorderColor = col; chart.update('none'); return;
  }
  const ctx = $('chart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, 'rgba(139,92,246,.5)'); grad.addColorStop(1, 'rgba(99,102,241,0)');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Valeur', data: total, borderColor: '#a78bfa', backgroundColor: grad, fill: true, tension: .4, borderWidth: 2.5, pointRadius: rows.length < 3 ? 4 : 0, pointHoverRadius: 5, pointBackgroundColor: '#fff' },
      { label: 'Capital déposé', data: dep, borderColor: 'rgba(148,163,184,.55)', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, stepped: true, fill: false },
      { label: 'Actions', data: mk, showLine: false, pointRadius: 6, pointHoverRadius: 9, pointBorderWidth: 2, pointBackgroundColor: col, pointBorderColor: col },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: 'rgba(15,15,28,.95)', borderColor: 'rgba(139,92,246,.4)', borderWidth: 1, padding: 12, titleColor: '#94a3b8', bodyColor: '#fff',
        filter: (i) => i.datasetIndex !== 2 || i.parsed.y != null,
        callbacks: { label: (i) => i.datasetIndex === 2 ? ` ⚡ ${tags[i.dataIndex] || 'Action'}` : ` ${i.dataset.label} : ${eur(i.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 6, maxRotation: 0 }, border: { display: false } },
        y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#64748b', callback: (v) => eur(v, 0) }, border: { display: false } },
      },
    },
    plugins: [glow],
  });
}

function tickCountdown() {
  if (!nextRun) { $('next-run').textContent = '–'; return; }
  const s = Math.max(0, Math.floor((nextRun - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  $('next-run').textContent = s ? `dans ${h ? h + ' h ' : ''}${m} min` : 'maintenant';
}

/* ---------- Boucle de rafraîchissement (mêmes endpoints) ---------- */
let wasLoaded = false;
async function refresh() {
  try {
    const [s, h, hist, dec] = await Promise.all([api('/api/summary'), api('/api/holdings'), api('/api/history'), api('/api/decisions')]);
    renderSummary(s); renderRank(s); renderHoldings(h); renderTicker(h); renderChart(hist, dec); renderDecisions(dec); logDecisions(dec); tickCountdown();
    wasLoaded = true;
  } catch (e) { setStatus('error'); }
  finally { clearTimeout(timer); timer = setTimeout(refresh, running ? 3000 : 30000); }
}

async function runNow() {
  const token = localStorage.getItem('admin_token') || '';
  try {
    await api('/api/run', { method: 'POST', headers: token ? { 'X-Admin-Token': token } : {} });
    toast('Analyse lancée. Gemini étudie le marché…');
    running = true; refresh();
  } catch (e) {
    if (e.status === 401) {
      const t = prompt('Token admin requis pour lancer une analyse :');
      if (t) { localStorage.setItem('admin_token', t); return runNow(); }
    } else if (e.status === 409) toast('Une analyse est déjà en cours.');
    else toast('Impossible de lancer l’analyse. Vérifiez les logs du serveur.', 'err');
  }
}

/* ---------- Tilt 3D des cartes ---------- */
const hold = $('holdings');
if (!reduced) {
  hold.addEventListener('pointermove', (e) => {
    const c = e.target.closest('.tilt'); if (!c) return;
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    c.style.transform = `perspective(700px) rotateX(${(-y * 12).toFixed(2)}deg) rotateY(${(x * 12).toFixed(2)}deg) scale(1.03)`;
  });
  hold.addEventListener('pointerout', (e) => { const c = e.target.closest('.tilt'); if (c && !c.contains(e.relatedTarget)) c.style.transform = ''; });
}

/* ---------- God Mode (visuel : n'appelle aucune API) ---------- */
$('god').addEventListener('click', () => {
  const manual = $('god').getAttribute('aria-checked') !== 'true';
  $('god').setAttribute('aria-checked', manual); document.body.classList.toggle('manual', manual);
  $('god-label').textContent = manual ? 'Contrôle manuel' : 'Pilote auto (IA)';
  log(manual ? 'God Mode : contrôle manuel activé' : 'God Mode : pilote automatique réactivé', manual ? 'warn' : 'ok');
  toast(manual ? '🎛️ Contrôle manuel activé' : '🤖 Pilote auto (IA) réactivé');
  sfx('toggle');
});

$('run-btn').addEventListener('click', runNow);
setInterval(tickCountdown, 30000);
log('Alpha IA initialisé. Connexion au serveur…', 'dim');
gauge();
refresh();
