"""Cerveau du bot : données de marché, appel Gemini, validation et exécution des ordres (simulation)."""
import json
import logging
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import google.generativeai as genai
import requests
import yfinance as yf

import db

log = logging.getLogger("trade_bot")

TZ = ZoneInfo(os.getenv("TIMEZONE", "Europe/Paris"))
DAILY_BUDGET = float(os.getenv("DAILY_BUDGET_EUR", "50"))
MAX_POSITION_PCT = float(os.getenv("MAX_POSITION_PCT", "40"))
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
CACHE_TTL = 60

# Univers investissable : symbole -> (nom, devise de cotation)
STOCKS = {
    "AAPL": ("Apple", "USD"), "MSFT": ("Microsoft", "USD"), "NVDA": ("Nvidia", "USD"),
    "TSLA": ("Tesla", "USD"), "AMZN": ("Amazon", "USD"), "GOOGL": ("Alphabet", "USD"),
    "MC.PA": ("LVMH", "EUR"), "AIR.PA": ("Airbus", "EUR"), "TTE.PA": ("TotalEnergies", "EUR"),
    "OR.PA": ("L’Oréal", "EUR"), "ASML.AS": ("ASML", "EUR"), "SAP.DE": ("SAP", "EUR"),
}
# symbole -> (nom, id CoinGecko)
CRYPTOS = {
    "BTC": ("Bitcoin", "bitcoin"), "ETH": ("Ethereum", "ethereum"), "SOL": ("Solana", "solana"),
    "BNB": ("BNB", "binancecoin"), "XRP": ("XRP", "ripple"), "ADA": ("Cardano", "cardano"),
}

SYSTEM_PROMPT = """Tu es ALPHA, un gérant de portefeuille quantitatif, rigoureux et prudent.

CONTEXTE
- Tu gères un portefeuille VIRTUEL (simulation, aucun argent réel). Chaque jour, 50 € de cash frais sont ajoutés.
- Tu reçois un JSON contenant : ton cash, ton portefeuille actuel (quantités, prix de revient, PNL) et l'état du marché (prix en EUR, variations 1 jour et 7 jours) pour actions et cryptomonnaies.

MISSION
Décider, pour aujourd'hui, quoi acheter, vendre ou conserver afin de faire croître le capital à moyen terme tout en maîtrisant le risque.

RÈGLES STRICTES
1. N'utilise QUE les symboles présents dans "market". N'invente aucun symbole, prix, chiffre ou actualité : appuie-toi uniquement sur les données fournies.
2. La somme des montants BUY ne doit pas dépasser cash_eur + le produit estimé de tes SELL.
3. Aucun actif ne doit dépasser max_position_pct % de total_value_eur après tes achats.
4. Diversifie : évite de concentrer tout le budget du jour sur un seul actif ou une seule classe d'actifs.
5. Tu as le droit de ne rien acheter et de garder du cash si le marché est défavorable (forte baisse, volatilité excessive). Dans ce cas, explique-le.
6. Montant minimum par achat : 1 €. Pas de levier, pas de vente à découvert. Pour SELL, indique sell_pct (1 à 100) de la position détenue.
7. Évite le sur-trading : ne vends pas une position uniquement pour un mouvement de quelques pourcents sans raison solide.
8. Chaque décision doit avoir une raison courte (une phrase, en français) fondée sur les données.

FORMAT DE SORTIE
Réponds UNIQUEMENT avec un objet JSON valide, sans Markdown, sans texte autour, selon ce schéma exact :
{
  "market_view": "synthèse du marché en 1 à 2 phrases",
  "risk_level": "low" | "medium" | "high",
  "decisions": [
    {"action": "BUY",  "symbol": "BTC",  "amount_eur": 12.5, "confidence": 0.7, "reason": "..."},
    {"action": "SELL", "symbol": "TSLA", "sell_pct": 50,     "confidence": 0.6, "reason": "..."},
    {"action": "HOLD", "symbol": "ETH",  "confidence": 0.5,   "reason": "..."}
  ]
}
"decisions" peut être vide. "confidence" est un nombre entre 0 et 1."""

# ------------------------------------------------------------------ Données de marché
_cache = {"ts": 0.0, "data": {}}
_cache_lock = threading.Lock()


def _eurusd():
    try:
        h = yf.Ticker("EURUSD=X").history(period="5d")["Close"].dropna()
        return float(h.iloc[-1])
    except Exception as e:
        log.warning("EURUSD indisponible (%s), repli sur taux fixe", e)
        return float(os.getenv("FALLBACK_EURUSD", "1.08"))


def _fetch_stock(sym):
    try:
        h = yf.Ticker(sym).history(period="1mo", interval="1d")["Close"].dropna()
        if len(h) < 2:
            return sym, None
        last, prev = float(h.iloc[-1]), float(h.iloc[-2])
        wk = float(h.iloc[-6]) if len(h) >= 6 else float(h.iloc[0])
        return sym, (last, (last / prev - 1) * 100, (last / wk - 1) * 100)
    except Exception as e:
        log.warning("yfinance %s : %s", sym, e)
        return sym, None


def _fetch_stocks():
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(_fetch_stock, STOCKS))
    fx = _eurusd()
    out = {}
    for sym, r in results:
        if not r:
            continue
        name, cur = STOCKS[sym]
        rate = fx if cur == "USD" else 1.0
        out[sym] = {"name": name, "type": "action", "price": r[0] / rate,
                    "change_1d_pct": round(r[1], 2), "change_7d_pct": round(r[2], 2)}
    return out


def _fetch_cryptos():
    headers = {}
    if os.getenv("COINGECKO_API_KEY"):
        headers["x-cg-demo-api-key"] = os.environ["COINGECKO_API_KEY"]
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={"vs_currency": "eur", "ids": ",".join(v[1] for v in CRYPTOS.values()),
                    "price_change_percentage": "24h,7d"},
            headers=headers, timeout=15)
        r.raise_for_status()
        by_id = {x["id"]: x for x in r.json()}
    except Exception as e:
        log.warning("CoinGecko : %s", e)
        return {}
    out = {}
    for sym, (name, cid) in CRYPTOS.items():
        x = by_id.get(cid)
        if not x or not x.get("current_price"):
            continue
        out[sym] = {"name": name, "type": "crypto", "price": float(x["current_price"]),
                    "change_1d_pct": round(x.get("price_change_percentage_24h_in_currency") or 0, 2),
                    "change_7d_pct": round(x.get("price_change_percentage_7d_in_currency") or 0, 2)}
    return out


def get_market(force=False):
    with _cache_lock:
        if not force and _cache["data"] and time.time() - _cache["ts"] < CACHE_TTL:
            return _cache["data"]
        data = {**_fetch_stocks(), **_fetch_cryptos()}
        if data:
            _cache.update(ts=time.time(), data=data)
        return data or _cache["data"]


# ------------------------------------------------------------------ Portefeuille
def valuate(c, market):
    acc = db.get_account(c)
    rows, hv = [], 0.0
    for h in db.get_holdings(c):
        m = market.get(h["symbol"])
        price = m["price"] if m else h["avg_cost"]
        value = h["quantity"] * price
        rows.append({"symbol": h["symbol"], "name": h["name"], "type": h["asset_type"],
                     "quantity": h["quantity"], "avg_cost": h["avg_cost"], "price": price,
                     "value": value, "pnl_pct": (price / h["avg_cost"] - 1) * 100 if h["avg_cost"] else 0.0})
        hv += value
    return {"cash": acc["cash"], "holdings_value": hv, "total": acc["cash"] + hv,
            "deposited": acc["total_deposited"], "holdings": rows}


def take_snapshot():
    market = get_market()
    with db.conn() as c:
        v = valuate(c, market)
        if v["holdings"] and not market:
            return
        db.add_snapshot(c, v["cash"], v["holdings_value"], v["total"], v["deposited"])


# ------------------------------------------------------------------ Gemini
def _parse_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text)


def ask_gemini(payload):
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY manquante dans l’environnement")
    genai.configure(api_key=key)
    model = genai.GenerativeModel(
        MODEL_NAME, system_instruction=SYSTEM_PROMPT,
        generation_config=genai.GenerationConfig(temperature=0.4, response_mime_type="application/json"))
    last = None
    for attempt in range(3):
        try:
            resp = model.generate_content(json.dumps(payload, ensure_ascii=False))
            return _parse_json(resp.text)
        except Exception as e:
            last = e
            log.warning("Gemini tentative %d/3 : %s", attempt + 1, e)
            time.sleep(2 ** attempt * 2)
    raise RuntimeError(f"Gemini a échoué : {last}")


def build_payload(val, market):
    return {
        "date": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"),
        "cash_eur": round(val["cash"], 2),
        "daily_budget_eur": DAILY_BUDGET,
        "max_position_pct": MAX_POSITION_PCT,
        "total_value_eur": round(val["total"], 2),
        "total_deposited_eur": round(val["deposited"], 2),
        "portfolio": [{"symbol": h["symbol"], "quantity": round(h["quantity"], 8),
                       "avg_cost_eur": round(h["avg_cost"], 4), "price_eur": round(h["price"], 4),
                       "value_eur": round(h["value"], 2), "pnl_pct": round(h["pnl_pct"], 2)}
                      for h in val["holdings"]],
        "market": [{"symbol": s, "name": m["name"], "type": m["type"], "price_eur": round(m["price"], 4),
                    "change_1d_pct": m["change_1d_pct"], "change_7d_pct": m["change_7d_pct"]}
                   for s, m in market.items()],
    }


# ------------------------------------------------------------------ Exécution
def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def execute_orders(c, raw_orders, market):
    """Valide les décisions de l’IA puis les exécute. Ventes d’abord, achats ensuite."""
    if not isinstance(raw_orders, list):
        raw_orders = []
    cash = db.get_account(c)["cash"]
    held = {h["symbol"]: dict(h) for h in db.get_holdings(c)}
    cap = valuate(c, market)["total"] * MAX_POSITION_PCT / 100
    ts = db.now_iso()
    parsed = [{"action": str(o.get("action", "")).upper().strip(),
               "symbol": str(o.get("symbol", "")).upper().strip(), "o": o}
              for o in raw_orders if isinstance(o, dict)]
    parsed.sort(key=lambda p: {"SELL": 0, "BUY": 1}.get(p["action"], 2))
    out = []

    def rec(p, status, note="", amount=0.0, qty=0.0, price=None):
        return {"action": p["action"], "symbol": p["symbol"],
                "name": market.get(p["symbol"], {}).get("name", p["symbol"]),
                "amount_eur": round(amount, 2), "quantity": qty, "price_eur": price,
                "confidence": _num(p["o"].get("confidence")),
                "reason": str(p["o"].get("reason", ""))[:400], "status": status, "note": note}

    for p in parsed:
        act, sym, o = p["action"], p["symbol"], p["o"]
        m = market.get(sym)
        if act == "HOLD":
            out.append(rec(p, "hold"))
            continue
        if act not in ("BUY", "SELL"):
            out.append(rec(p, "rejected", "Action inconnue"))
            continue
        if not m:
            out.append(rec(p, "rejected", "Actif hors univers ou prix indisponible"))
            continue
        price, reason = m["price"], str(o.get("reason", ""))[:400]
        if act == "SELL":
            h = held.get(sym)
            if not h or h["quantity"] <= 0:
                out.append(rec(p, "rejected", "Aucune position à vendre"))
                continue
            v = _num(o.get("sell_pct"))
            pct = 100.0 if v is None else min(max(v, 0.0), 100.0)
            if pct <= 0:
                out.append(rec(p, "rejected", "Pourcentage de vente nul"))
                continue
            qty = h["quantity"] * pct / 100
            amount = qty * price
            db.apply_sell(c, sym, qty, price, amount, reason, ts)
            h["quantity"] -= qty
            cash += amount
            out.append(rec(p, "executed", f"Vente de {pct:.0f} % de la position", amount, qty, price))
        else:
            want = _num(o.get("amount_eur")) or 0.0
            room = max(0.0, cap - held.get(sym, {}).get("quantity", 0.0) * price)
            amount = math.floor(min(want, cash, room) * 100) / 100
            if amount < 1.0:
                out.append(rec(p, "rejected", "Montant trop faible (cash ou plafond de position atteint)"))
                continue
            note = "Montant ajusté (cash ou plafond)" if amount < round(want, 2) - 0.005 else ""
            qty = amount / price
            db.apply_buy(c, sym, m["name"], m["type"], qty, price, amount, reason, ts)
            cash -= amount
            held.setdefault(sym, {"quantity": 0.0})["quantity"] += qty
            out.append(rec(p, "executed", note, amount, qty, price))
    return out


# ------------------------------------------------------------------ Cycle quotidien
_cycle_lock = threading.Lock()
state = {"running": False}

def run_daily_cycle(manual=False):
    """Crédite 50 € (1 fois/jour) et lance l'analyse IA (jusqu'à 3 fois/jour)."""
    if not _cycle_lock.acquire(blocking=False):
        return {"status": "busy"}
    state["running"] = True
    try:
        today = datetime.now(TZ).date().isoformat()
        
        with db.conn() as c:
            account = db.get_account(c)
            already_credited = account["last_credit_date"] == today
            
            # Compter combien d'analyses ont déjà été faites aujourd'hui
            # On vérifie dans la table des décisions ou via une logique simple
            cursor = c.cursor()
            cursor.execute("SELECT COUNT(*) FROM decisions WHERE ts LIKE ?", (f"{today}%",))
            analyses_today = cursor.fetchone()[0]
            
            if analyses_today >= 3 and not manual:
                log.info("Limite de 3 analyses par jour atteinte.")
                return {"status": "skipped"}
                
            # Créditer les 50 € une seule fois par jour au premier run
            if not already_credited:
                db.credit(c, DAILY_BUDGET, today)
                log.info("+%.2f € crédités pour la journée", DAILY_BUDGET)

        market = get_market(force=True)
        if not market:
            with db.conn() as c:
                db.add_decision(c, "", None, [], "error", "Données de marché indisponibles")
            return {"status": "error"}

        with db.conn() as c:
            payload = build_payload(valuate(c, market), market)
        try:
            decision = ask_gemini(payload)
            if not isinstance(decision, dict):
                raise ValueError("Réponse Gemini inattendue (objet JSON attendu)")
        except Exception as e:
            log.error("Échec IA : %s", e)
            with db.conn() as c:
                db.add_decision(c, "", None, [], "error", str(e)[:400])
            return {"status": "error"}

        with db.conn() as c:
            orders = execute_orders(c, decision.get("decisions"), market)
            db.add_decision(c, str(decision.get("market_view", ""))[:500],
                            str(decision.get("risk_level", ""))[:10], orders, "ok")
            v = valuate(c, market)
            db.add_snapshot(c, v["cash"], v["holdings_value"], v["total"], v["deposited"])
        return {"status": "ok"}
    except Exception:
        log.exception("Cycle quotidien en échec")
        return {"status": "error"}
    finally:
        state["running"] = False
        _cycle_lock.release()
