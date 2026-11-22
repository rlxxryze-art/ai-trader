let observerChart = null;

function formatEurObs(val) {
  const num = Number(val ?? 0);
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function formatDateObs(raw) {
  if (!raw) return "--";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderObserverChart(labels, values) {
  const canvas = document.getElementById("observerChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (observerChart) {
    observerChart.data.labels = labels;
    observerChart.data.datasets[0].data = values;
    observerChart.update();
    return;
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, "rgba(16, 185, 129, 0.3)");
  gradient.addColorStop(1, "rgba(16, 185, 129, 0.0)");

  observerChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Portefeuille (€)",
          data: values,
          borderColor: "#10b981",
          backgroundColor: gradient,
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 2.5,
          pointBackgroundColor: "#10b981",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          grid: { color: "rgba(39, 39, 48, 0.4)" },
          ticks: { color: "#a1a1aa", maxTicksLimit: 8 },
        },
        y: {
          grid: { color: "rgba(39, 39, 48, 0.4)" },
          ticks: {
            color: "#a1a1aa",
            callback: (v) => v + " €",
          },
        },
      },
    },
  });
}

async function syncObserver() {
  try {
    const [summaryRes, holdingsRes, historyRes, decisionsRes] = await Promise.allSettled([
      fetch("/api/summary"),
      fetch("/api/holdings"),
      fetch("/api/history"),
      fetch("/api/decisions?limit=25"),
    ]);

    if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
      const s = await summaryRes.value.json();
      const totalVal = Number(s.total ?? 0);
      const cashVal = Number(s.cash ?? 0);
      const deposited = Number(s.deposited ?? 0);
      const pnl = Number(s.pnl_eur ?? totalVal - deposited);
      const pnlPct = Number(s.pnl_pct ?? (deposited > 0 ? (pnl / deposited) * 100 : 0));

      document.getElementById("obs-total-value").textContent = formatEurObs(totalVal);
      document.getElementById("obs-cash-balance").textContent = formatEurObs(cashVal);
      document.getElementById("obs-total-deposited").textContent = `Capital déposé : ${formatEurObs(deposited)}`;
      document.getElementById("obs-daily-budget").textContent = `Budget cycle : ${formatEurObs(s.daily_budget ?? 50)}`;

      const pnlEl = document.getElementById("obs-total-pnl");
      const pnlPctEl = document.getElementById("obs-total-pnl-pct");
      pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatEurObs(pnl)}`;
      pnlEl.className = `kpi-value ${pnl >= 0 ? "text-green" : "text-red"}`;
      pnlPctEl.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)} %`;
      pnlPctEl.className = `kpi-sub ${pnlPct >= 0 ? "text-green" : "text-red"}`;
    }

    if (holdingsRes.status === "fulfilled" && holdingsRes.value.ok) {
      const hRaw = await holdingsRes.value.json();
      const holdings = Array.isArray(hRaw)
        ? hRaw
        : Object.entries(hRaw || {}).map(([sym, data]) => ({ symbol: sym, ...data }));

      document.getElementById("obs-positions-count").textContent = holdings.length;
      const tbody = document.getElementById("obs-holdings-body");

      if (holdings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucune position ouverte</td></tr>`;
      } else {
        tbody.innerHTML = holdings
          .map((item) => {
            const qty = Number(item.qty ?? item.quantity ?? item.shares ?? 0);
            const avg = Number(item.avg_price ?? item.buy_price ?? item.entry_price ?? 0);
            const cur = Number(item.price ?? item.current_price ?? avg);
            const val = Number(item.value ?? item.market_value ?? qty * cur);
            const posPnl = Number(item.pnl_eur ?? item.pnl ?? val - qty * avg);
            const pnlClass = posPnl >= 0 ? "text-green" : "text-red";

            return `
              <tr>
                <td><strong>${item.symbol}</strong></td>
                <td>${qty.toFixed(4)}</td>
                <td>${formatEurObs(avg)}</td>
                <td>${formatEurObs(cur)}</td>
                <td>${formatEurObs(val)}</td>
                <td class="${pnlClass}">${posPnl >= 0 ? "+" : ""}${formatEurObs(posPnl)}</td>
              </tr>
            `;
          })
          .join("");
      }
    }

    if (historyRes.status === "fulfilled" && historyRes.value.ok) {
      const histRaw = await historyRes.value.json();
      const points = Array.isArray(histRaw) ? histRaw : histRaw.history ?? [];
      if (points.length > 0) {
        const ordered = [...points].sort(
          (a, b) => new Date(a.ts || a.timestamp || a.date || 0) - new Date(b.ts || b.timestamp || b.date || 0)
        );
        renderObserverChart(
          ordered.map((p) => formatDateObs(p.ts || p.timestamp || p.date)),
          ordered.map((p) => Number(p.total ?? p.value ?? p.portfolio_value ?? 0))
        );
      }
    }

    if (decisionsRes.status === "fulfilled" && decisionsRes.value.ok) {
      const decRaw = await decisionsRes.value.json();
      const rows = Array.isArray(decRaw) ? decRaw : decRaw.decisions ?? [];
      const tbody = document.getElementById("obs-history-body");

      if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucune décision enregistrée</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .map((t) => {
            const action = String(t.action || t.side || t.decision || "HOLD").toUpperCase();
            const isBuy = action.includes("BUY") || action.includes("ACHAT");
            const isSell = action.includes("SELL") || action.includes("VENTE");
            const pillClass = isBuy ? "pill-buy" : isSell ? "pill-sell" : "";

            let amountLabel = "--";
            if (t.amount_eur != null) amountLabel = formatEurObs(t.amount_eur);
            else if (t.sell_pct != null) amountLabel = `${t.sell_pct} %`;
            else if (t.qty != null) amountLabel = Number(t.qty).toFixed(4);

            return `
              <tr>
                <td>${formatDateObs(t.ts || t.timestamp || t.created_at || t.date)}</td>
                <td><span class="pill ${pillClass}">${action}</span></td>
                <td><strong>${t.symbol || "--"}</strong></td>
                <td>${amountLabel}</td>
                <td>${t.price ? formatEurObs(t.price) : "--"}</td>
                <td style="color: var(--text-secondary);">${t.reason || t.rationale || "Alpha IA"}</td>
              </tr>
            `;
          })
          .join("");
      }
    }

    const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    document.getElementById("observer-sync").textContent = `Live • ${now}`;
  } catch (err) {
    console.error("Erreur sync observer:", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  syncObserver();
  setInterval(syncObserver, 30000);
});
