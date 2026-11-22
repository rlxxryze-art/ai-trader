let portfolioChart = null;

function formatEur(val) {
  const num = Number(val ?? 0);
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "#ef4444" : "#8b5cf6";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

function updateChart(labels, values) {
  const ctx = document.getElementById("portfolioChart").getContext("2d");

  if (portfolioChart) {
    portfolioChart.data.labels = labels;
    portfolioChart.data.datasets[0].data = values;
    portfolioChart.update();
    return;
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, "rgba(139, 92, 246, 0.35)");
  gradient.addColorStop(1, "rgba(139, 92, 246, 0.0)");

  portfolioChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Valeur (€)",
          data: values,
          borderColor: "#8b5cf6",
          backgroundColor: gradient,
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: "#8b5cf6",
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

async function fetchDashboardData() {
  try {
    const [summaryRes, holdingsRes, historyRes] = await Promise.allSettled([
      fetch("/api/summary"),
      fetch("/api/holdings"),
      fetch("/api/history"),
    ]);

    // 1. Summary
    if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
      const s = await summaryRes.value.json();
      const totalVal = s.total_value ?? s.portfolio_value ?? 0;
      const cashVal = s.cash ?? s.cash_balance ?? 0;
      const invested = s.total_invested ?? s.invested ?? 0;
      const pnl = s.pnl ?? s.total_pnl ?? (invested > 0 ? totalVal - invested : 0);
      const pnlPct = s.pnl_pct ?? (invested > 0 ? (pnl / invested) * 100 : 0);

      document.getElementById("total-value").textContent = formatEur(totalVal);
      document.getElementById("cash-balance").textContent = formatEur(cashVal);
      document.getElementById("total-invested").textContent = `Capital engagé : ${formatEur(invested)}`;

      const pnlEl = document.getElementById("total-pnl");
      const pnlPctEl = document.getElementById("total-pnl-pct");
      pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatEur(pnl)}`;
      pnlEl.className = `kpi-value ${pnl >= 0 ? "text-green" : "text-red"}`;
      pnlPctEl.textContent = `${pnlPct >= 0 ? "+" : ""}${Number(pnlPct).toFixed(2)} %`;
      pnlPctEl.className = `kpi-sub ${pnlPct >= 0 ? "text-green" : "text-red"}`;

      if (s.status) {
        document.getElementById("ai-status").textContent = s.status;
      }

      if (Array.isArray(s.equity_curve) && s.equity_curve.length > 0) {
        updateChart(
          s.equity_curve.map((p) => p.date || p.timestamp),
          s.equity_curve.map((p) => p.value ?? p.total_value)
        );
      }
    }

    // 2. Holdings
    if (holdingsRes.status === "fulfilled" && holdingsRes.value.ok) {
      const hData = await holdingsRes.value.json();
      const holdings = Array.isArray(hData) ? hData : hData.holdings ?? [];
      const tbody = document.getElementById("holdings-body");
      document.getElementById("positions-count").textContent = `${holdings.length} position(s) ouverte(s)`;

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
                <td>${formatEur(avg)}</td>
                <td>${formatEur(cur)}</td>
                <td>${formatEur(val)}</td>
                <td class="${pnlClass}">${posPnl >= 0 ? "+" : ""}${formatEur(posPnl)}</td>
              </tr>
            `;
          })
          .join("");
      }
    }

    // 3. History
    if (historyRes.status === "fulfilled" && historyRes.value.ok) {
      const histData = await historyRes.value.json();
      const rows = Array.isArray(histData) ? histData : histData.history ?? histData.trades ?? [];
      const tbody = document.getElementById("history-body");

      if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucun historique enregistré</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .slice(0, 25)
          .map((t) => {
            const side = (t.side || t.action || t.type || "BUY").toUpperCase();
            const isBuy = side.includes("BUY") || side.includes("ACHAT");
            const dateStr = t.timestamp || t.created_at || t.date || "--";
            const amountInfo = t.amount_eur
              ? formatEur(t.amount_eur)
              : `${Number(t.quantity ?? t.amount ?? 0).toFixed(4)}`;

            return `
              <tr>
                <td>${dateStr}</td>
                <td><span class="pill ${isBuy ? "pill-buy" : "pill-sell"}">${side}</span></td>
                <td><strong>${t.symbol || "--"}</strong></td>
                <td>${amountInfo}</td>
                <td>${t.price ? formatEur(t.price) : "--"}</td>
                <td style="color: var(--text-secondary);">${t.reason || t.source || "Alpha IA"}</td>
              </tr>
            `;
          })
          .join("");

        // Fallback chart from history if summary had no equity_curve
        if (!portfolioChart && rows.some((r) => r.portfolio_value || r.total_value)) {
          const ordered = [...rows].reverse();
          updateChart(
            ordered.map((r) => r.timestamp || r.date || ""),
            ordered.map((r) => r.portfolio_value ?? r.total_value)
          );
        }
      }
    }

    const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    document.getElementById("last-sync").textContent = `MAJ ${now}`;
  } catch (err) {
    console.error("Erreur sync dashboard:", err);
  }
}

async function executeGodModeTrade(action) {
  const tokenInput = document.getElementById("admin-token");
  const symbolInput = document.getElementById("trade-symbol");
  const amountInput = document.getElementById("trade-amount");

  const token = tokenInput.value.trim();
  const symbol = symbolInput.value.trim().toUpperCase();
  const amount = parseFloat(amountInput.value);

  if (!token || !symbol || isNaN(amount) || amount <= 0) {
    showToast("Remplis le token, le symbole et un montant valide.", true);
    return;
  }

  localStorage.setItem("alpha_ia_admin_token", token);

  const buyBtn = document.getElementById("btn-buy");
  const sellBtn = document.getElementById("btn-sell");
  buyBtn.disabled = true;
  sellBtn.disabled = true;

  try {
    const endpoint = action === "buy" ? "/api/buy" : "/api/sell";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": token,
      },
      body: JSON.stringify({
        symbol,
        amount_eur: amount,
        amount,
        quantity: amount,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || data.message || `Erreur HTTP ${response.status}`);
    }

    showToast(data.message || `Ordre ${action.toUpperCase()} sur ${symbol} exécuté.`);
    amountInput.value = "";
    await fetchDashboardData();
  } catch (err) {
    showToast(`Échec : ${err.message}`, true);
  } finally {
    buyBtn.disabled = false;
    sellBtn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const savedToken = localStorage.getItem("alpha_ia_admin_token");
  if (savedToken) {
    document.getElementById("admin-token").value = savedToken;
  }

  document.getElementById("btn-buy").addEventListener("click", () => executeGodModeTrade("buy"));
  document.getElementById("btn-sell").addEventListener("click", () => executeGodModeTrade("sell"));
  document.getElementById("refresh-btn").addEventListener("click", fetchDashboardData);

  fetchDashboardData();
  setInterval(fetchDashboardData, 30000);
});
