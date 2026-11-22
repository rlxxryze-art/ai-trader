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

function renderObserverChart(labels, values) {
  const ctx = document.getElementById("observerChart").getContext("2d");

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
          pointRadius: 3,
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
    const [summaryRes, holdingsRes, historyRes] = await Promise.allSettled([
      fetch("/api/summary"),
      fetch("/api/holdings"),
      fetch("/api/history"),
    ]);

    if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
      const s = await summaryRes.value.json();
      const totalVal = s.total_value ?? s.portfolio_value ?? 0;
      const cashVal = s.cash ?? s.cash_balance ?? 0;
      const invested = s.total_invested ?? s.invested ?? 0;
      const pnl = s.pnl ?? s.total_pnl ?? (invested > 0 ? totalVal - invested : 0);
      const pnlPct = s.pnl_pct ?? (invested > 0 ? (pnl / invested) * 100 : 0);

      document.getElementById("obs-total-value").textContent = formatEurObs(totalVal);
      document.getElementById("obs-cash-balance").textContent = formatEurObs(cashVal);
      document.getElementById("obs-total-invested").textContent = `Capital engagé : ${formatEurObs(invested)}`;

      const pnlEl = document.getElementById("obs-total-pnl");
      const pnlPctEl = document.getElementById("obs-total-pnl-pct");
      pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatEurObs(pnl)}`;
      pnlEl.className = `kpi-value ${pnl >= 0 ? "text-green" : "text-red"}`;
      pnlPctEl.textContent = `${pnlPct >= 0 ? "+" : ""}${Number(pnlPct).toFixed(2)} %`;
      pnlPctEl.className = `kpi-sub ${pnlPct >= 0 ? "text-green" : "text-red"}`;

      if (Array.isArray(s.equity_curve) && s.equity_curve.length > 0) {
        renderObserverChart(
          s.equity_curve.map((p) => p.date || p.timestamp),
          s.equity_curve.map((p) => p.value ?? p.total_value)
        );
      }
    }

    if (holdingsRes.status === "fulfilled" && holdingsRes.value.ok) {
      const hData = await holdingsRes.value.json();
      const holdings = Array.isArray(hData) ? hData : hData.holdings ?? [];
      document.getElementById("obs-positions-count").textContent = holdings.length;
      const tbody = document.getElementById("obs-holdings-body");

      if (holdings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucune position ouverte</td></tr>`;
      } else {
        tbody.innerHTML = holdings
          .map((item) => {
            const qty = Number(item.quantity ?? item.shares ?? 0);
            const avg = Number(item.avg_price ?? item.entry_price ?? 0);
            const cur = Number(item.current_price ?? item.price ?? avg);
            const val = Number(item.market_value ?? qty * cur);
            const posPnl = Number(item.pnl ?? val - qty * avg);
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
      const histData = await historyRes.value.json();
      const rows = Array.isArray(histData) ? histData : histData.history ?? histData.trades ?? [];
      const tbody = document.getElementById("obs-history-body");

      if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucun trade enregistré</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .slice(0, 25)
          .map((t) => {
            const side = (t.side || t.action || t.type || "BUY").toUpperCase();
            const isBuy = side.includes("BUY") || side.includes("ACHAT");
            const dateStr = t.timestamp || t.created_at || t.date || "--";
            const amountInfo = t.amount_eur
              ? formatEurObs(t.amount_eur)
              : `${Number(t.quantity ?? t.amount ?? 0).toFixed(4)}`;

            return `
              <tr>
                <td>${dateStr}</td>
                <td><span class="pill ${isBuy ? "pill-buy" : "pill-sell"}">${side}</span></td>
                <td><strong>${t.symbol || "--"}</strong></td>
                <td>${amountInfo}</td>
                <td>${t.price ? formatEurObs(t.price) : "--"}</td>
                <td style="color: var(--text-secondary);">${t.reason || t.source || "Alpha IA"}</td>
              </tr>
            `;
          })
          .join("");

        if (!observerChart && rows.some((r) => r.portfolio_value || r.total_value)) {
          const ordered = [...rows].reverse();
          renderObserverChart(
            ordered.map((r) => r.timestamp || r.date || ""),
            ordered.map((r) => r.portfolio_value ?? r.total_value)
          );
        }
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
