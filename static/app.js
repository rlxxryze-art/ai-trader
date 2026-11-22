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

function formatDate(raw) {
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

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "#ef4444" : "#8b5cf6";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

function updateChart(labels, values) {
  const canvas = document.getElementById("portfolioChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

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
          pointRadius: 2.5,
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
    const [summaryRes, holdingsRes, historyRes, decisionsRes] = await Promise.allSettled([
      fetch("/api/summary"),
      fetch("/api/holdings"),
      fetch("/api/history"),
      fetch("/api/decisions?limit=25"),
    ]);

    // 1. Résumé (/api/summary)
    if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
      const s = await summaryRes.value.json();
      const totalVal = Number(s.total ?? 0);
      const cashVal = Number(s.cash ?? 0);
      const deposited = Number(s.deposited ?? 0);
      const pnl = Number(s.pnl_eur ?? totalVal - deposited);
      const pnlPct = Number(s.pnl_pct ?? (deposited > 0 ? (pnl / deposited) * 100 : 0));

      document.getElementById("total-value").textContent = formatEur(totalVal);
      document.getElementById("cash-balance").textContent = formatEur(cashVal);
      document.getElementById("total-deposited").textContent = `Capital déposé : ${formatEur(deposited)}`;
      document.getElementById("daily-budget").textContent = `Budget cycle : ${formatEur(s.daily_budget ?? 50)}`;

      const pnlEl = document.getElementById("total-pnl");
      const pnlPctEl = document.getElementById("total-pnl-pct");
      pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatEur(pnl)}`;
      pnlEl.className = `kpi-value ${pnl >= 0 ? "text-green" : "text-red"}`;
      pnlPctEl.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)} %`;
      pnlPctEl.className = `kpi-sub ${pnlPct >= 0 ? "text-green" : "text-red"}`;

      document.getElementById("ai-status").textContent = s.running ? "Analyse en cours..." : "En veille (Actif)";
      document.getElementById("next-run").textContent = s.next_run
        ? `Prochain cycle : ${formatDate(s.next_run)}`
        : "Planificateur actif";
    }

    // 2. Positions (/api/holdings)
    if (holdingsRes.status === "fulfilled" && holdingsRes.value.ok) {
      const hRaw = await holdingsRes.value.json();
      const holdings = Array.isArray(hRaw)
        ? hRaw
        : Object.entries(hRaw || {}).map(([sym, data]) => ({ symbol: sym, ...data }));

      const tbody = document.getElementById("holdings-body");
      document.getElementById("positions-count").textContent = `${holdings.length} position(s)`;

      if (holdings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Aucune position ouverte (100 % cash)</td></tr>`;
      } else {
        tbody.innerHTML = holdings
          .map((item) => {
            const qty = Number(item.qty ?? item.quantity ?? item.shares ?? 0);
            const avg = Number(item.avg_cost ?? item.avg_price ?? item.buy_price ?? item.entry_price ?? 0);
            const cur = Number(item.price ?? item.current_price ?? avg);
            const val = Number(item.value ?? item.market_value ?? qty * cur);
            const posPnl = Number(item.pnl_eur ?? item.pnl ?? (avg > 0 ? val - qty * avg : 0));
            const posPnlPct = Number(item.pnl_pct ?? (avg > 0 ? ((cur / avg) - 1) * 100 : 0));
            const pnlClass = posPnl >= 0 ? "text-green" : "text-red";
            const sign = posPnl >= 0 ? "+" : "";

            return `
              <tr>
                <td><strong>${item.symbol}</strong></td>
                <td>${qty.toFixed(4)}</td>
                <td>${formatEur(avg)}</td>
                <td>${formatEur(cur)}</td>
                <td>${formatEur(val)}</td>
                <td class="${pnlClass}">
                  <strong>${sign}${formatEur(posPnl)}</strong>
                  <span style="font-size: 0.82rem; opacity: 0.9;">(${sign}${posPnlPct.toFixed(2)} %)</span>
                </td>
              </tr>
            `;
          })
          .join("");
      }
    }

    // 3. Courbe du graphique (/api/history)
    if (historyRes.status === "fulfilled" && historyRes.value.ok) {
      const histRaw = await historyRes.value.json();
      const points = Array.isArray(histRaw) ? histRaw : histRaw.history ?? [];
      if (points.length > 0) {
        const ordered = [...points].sort(
          (a, b) => new Date(a.ts || a.timestamp || a.date || 0) - new Date(b.ts || b.timestamp || b.date || 0)
        );
        updateChart(
          ordered.map((p) => formatDate(p.ts || p.timestamp || p.date)),
          ordered.map((p) => Number(p.total ?? p.value ?? p.portfolio_value ?? 0))
        );
      }
    }

    // 4. Décisions & Ordres (/api/decisions)
    if (decisionsRes.status === "fulfilled" && decisionsRes.value.ok) {
      const decRaw = await decisionsRes.value.json();
      const rows = Array.isArray(decRaw) ? decRaw : decRaw.decisions ?? [];
      const tbody = document.getElementById("history-body");

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
            if (t.amount_eur != null) amountLabel = formatEur(t.amount_eur);
            else if (t.sell_pct != null) amountLabel = `${t.sell_pct} %`;
            else if (t.qty != null) amountLabel = Number(t.qty).toFixed(4);

            return `
              <tr>
                <td>${formatDate(t.ts || t.timestamp || t.created_at || t.date)}</td>
                <td><span class="pill ${pillClass}">${action}</span></td>
                <td><strong>${t.symbol || "--"}</strong></td>
                <td>${amountLabel}</td>
                <td>${t.price ? formatEur(t.price) : "--"}</td>
                <td style="color: var(--text-secondary);">${t.reason || t.rationale || "Alpha IA"}</td>
              </tr>
            `;
          })
          .join("");
      }
    }

    const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    document.getElementById("last-sync").textContent = `MAJ ${now}`;
  } catch (err) {
    console.error("Erreur sync dashboard:", err);
  }
}

async function executeGodModeTrade(action) {
  const token = document.getElementById("admin-token").value.trim();
  const symbol = document.getElementById("trade-symbol").value.trim().toUpperCase();
  const val = parseFloat(document.getElementById("trade-value").value);

  if (!token || !symbol || isNaN(val) || val <= 0) {
    showToast("Remplis le token, l'actif et une valeur valide.", true);
    return;
  }

  localStorage.setItem("alpha_ia_admin_token", token);

  const buyBtn = document.getElementById("btn-buy");
  const sellBtn = document.getElementById("btn-sell");
  buyBtn.disabled = true;
  sellBtn.disabled = true;

  try {
    const endpoint = action === "buy" ? "/api/buy" : "/api/sell";
    const payload =
      action === "buy"
        ? { symbol, amount_eur: val }
        : { symbol, sell_pct: Math.min(val, 100) };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": token,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || data.error || `Erreur HTTP ${response.status}`);
    }

    showToast(
      action === "buy"
        ? `Achat de ${formatEur(val)} sur ${symbol} validé !`
        : `Vente de ${Math.min(val, 100)}% de ${symbol} validée !`
    );
    document.getElementById("trade-value").value = "";
    await fetchDashboardData();
  } catch (err) {
    showToast(`Échec : ${err.message}`, true);
  } finally {
    buyBtn.disabled = false;
    sellBtn.disabled = false;
  }
}

async function triggerRunNow() {
  const token = document.getElementById("admin-token").value.trim();
  if (!token) {
    showToast("Entre ton X-Admin-Token d'abord.", true);
    return;
  }
  localStorage.setItem("alpha_ia_admin_token", token);

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "X-Admin-Token": token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
    showToast("Analyse IA lancée en arrière-plan !");
    setTimeout(fetchDashboardData, 3000);
  } catch (err) {
    showToast(`Erreur : ${err.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const savedToken = localStorage.getItem("alpha_ia_admin_token");
  if (savedToken) {
    document.getElementById("admin-token").value = savedToken;
  }

  document.getElementById("btn-buy").addEventListener("click", () => executeGodModeTrade("buy"));
  document.getElementById("btn-sell").addEventListener("click", () => executeGodModeTrade("sell"));
  document.getElementById("btn-run-now").addEventListener("click", triggerRunNow);
  document.getElementById("refresh-btn").addEventListener("click", fetchDashboardData);

  fetchDashboardData();
  setInterval(fetchDashboardData, 30000);
});
