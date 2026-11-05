const $ = (id) => document.getElementById(id);
const eur = (n, d = 2) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(n ?? 0);
const pct = (n) => `${n >= 0 ? '+' : ''}${(n ?? 0).toFixed(2).replace('.', ',')} %`;
const qty = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: n < 1 ? 6 : 4 }).format(n ?? 0);
const when = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const tone = (n) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : 'flat');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTION_FR = { BUY: 'Achat', SELL: 'Vente', HOLD: 'Conserver' };

let chart = null, timer = null, nextRun = null, running = false;

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { const e = new Error(r.statusText); e.status = r.status; throw e; }
  return r.json();
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}

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
  nextRun = s.next_run ? new Date(s.next_run) : null;
  $('run-btn').disabled = running;
  $('run-btn').textContent = running ? 'Analyse en cours…' : 'Lancer l’analyse';
  setStatus(running ? 'busy' : 'live');
}

function renderHoldings(rows) {
  const tb = $('holdings');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5" class="!text-center text-slate-500 py-10">Aucun actif pour l’instant. Lancez une analyse pour que l’IA investisse les premiers 50 €.</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((h) => `
    <tr>
      <td><div class="flex items-center gap-3"><div class="avatar">${esc(h.symbol.slice(0, 3))}</div>
        <div><div class="font-medium text-white">${esc(h.name)}</div><div class="text-xs text-slate-500">${esc(h.symbol)}, ${h.type}</div></div></div></td>
      <td class="num">${qty(h.quantity)}</td>
      <td class="num">${eur(h.price, h.price < 1 ? 4 : 2)}</td>
      <td class="num font-medium text-white">${eur(h.value)}</td>
      <td class="num font-medium ${tone(h.pnl_pct)}">${pct(h.pnl_pct)}</td>
    </tr>`).join('');
}

function renderDecisions(items) {
  const el = $('decisions');
  if (!items.length) { el.innerHTML = `<p class="text-sm text-slate-500">Aucune décision pour l’instant. La première analyse démarre à l’heure prévue, ou avec le bouton en haut.</p>`; return; }
  el.innerHTML = items.map((d) => `
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
    </article>`).join('');
}

const glow = {
  id: 'glow',
  beforeDatasetDraw(c, a) { if (a.index === 0) { c.ctx.save(); c.ctx.shadowColor = 'rgba(139,92,246,.85)'; c.ctx.shadowBlur = 16; } },
  afterDatasetDraw(c, a) { if (a.index === 0) c.ctx.restore(); },
};

function renderChart(rows) {
  const labels = rows.map((r) => when(r.ts));
  const total = rows.map((r) => r.total), dep = rows.map((r) => r.deposited);
  if (chart) { chart.data.labels = labels; chart.data.datasets[0].data = total; chart.data.datasets[1].data = dep; chart.update('none'); return; }
  const ctx = $('chart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, 'rgba(139,92,246,.5)'); grad.addColorStop(1, 'rgba(99,102,241,0)');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Valeur', data: total, borderColor: '#a78bfa', backgroundColor: grad, fill: true, tension: .4, borderWidth: 2.5, pointRadius: rows.length < 3 ? 4 : 0, pointHoverRadius: 5, pointBackgroundColor: '#fff' },
      { label: 'Capital déposé', data: dep, borderColor: 'rgba(148,163,184,.55)', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, stepped: true, fill: false },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: 'rgba(15,15,28,.95)', borderColor: 'rgba(139,92,246,.4)', borderWidth: 1, padding: 12, titleColor: '#94a3b8', bodyColor: '#fff',
        callbacks: { label: (i) => ` ${i.dataset.label} : ${eur(i.parsed.y)}` } } },
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

async function refresh() {
  try {
    const [s, h, hist, dec] = await Promise.all([api('/api/summary'), api('/api/holdings'), api('/api/history'), api('/api/decisions')]);
    renderSummary(s); renderHoldings(h); renderChart(hist); renderDecisions(dec); tickCountdown();
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
    else toast('Impossible de lancer l’analyse. Vérifiez les logs du serveur.');
  }
}

$('run-btn').addEventListener('click', runNow);
setInterval(tickCountdown, 30000);
refresh();
