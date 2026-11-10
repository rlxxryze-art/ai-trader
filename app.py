"""Serveur FastAPI + planificateur APScheduler."""

import hmac
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

# 1. Chargement de l'environnement en premier (Bonne pratique)
from dotenv import load_dotenv
load_dotenv()

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import trade_bot

# --- 2. DÉFINITION DES VARIABLES GLOBALES ---
BASE = Path(__file__).resolve().parent
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")
SNAP_MIN = 5
TZ = trade_bot.TZ

scheduler = BackgroundScheduler()

# --- 3. GESTION DU DÉMARRAGE (LIFESPAN) ---
@asynccontextmanager
async def lifespan(_app):
    db.init_db()
    now = datetime.now(TZ)
    
    # OPTIMISATION : Analyse toutes les 4 heures (évite l'erreur 429 de Gemini)
    scheduler.add_job(
        trade_bot.run_daily_cycle, 
        CronTrigger(hour="*/4", minute=0, timezone=TZ),
        id="daily", 
        misfire_grace_time=1800, 
        coalesce=True, 
        max_instances=1
    )
    
    # Snapshot pour le graphique
    scheduler.add_job(
        trade_bot.take_snapshot, 
        IntervalTrigger(minutes=SNAP_MIN), 
        id="snapshot",
        next_run_time=now + timedelta(seconds=10), 
        coalesce=True, 
        max_instances=1
    )
    
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)

# --- 4. INITIALISATION DE FASTAPI ---
app = FastAPI(title="Alpha IA", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

# --- 5. MODÈLES DE DONNÉES ---
class BuyRequest(BaseModel):
    symbol: str
    amount_eur: float
class SellRequest(BaseModel):
    symbol: str
    sell_pct: float
# --- 6. ROUTES DE L'APPLICATION ---
@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")

# AJOUTE CES 3 LIGNES ICI :
@app.get("/observer")
def observer():
    return FileResponse(BASE / "static" / "observer.html")

@app.get("/health")
def health():
    return {"status": "ok"}

def _valuation():
    market = trade_bot.get_market()
    with db.conn() as c:
        return trade_bot.valuate(c, market)

@app.get("/api/summary")
def summary():
    v = _valuation()
    job = scheduler.get_job("daily")
    pnl = v["total"] - v["deposited"]
    return {
        "total": v["total"], 
        "cash": v["cash"], 
        "holdings_value": v["holdings_value"],
        "deposited": v["deposited"], 
        "pnl_eur": pnl,
        "pnl_pct": (pnl / v["deposited"] * 100) if v["deposited"] else 0.0,
        "running": trade_bot.state["running"],
        "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None,
        "daily_budget": trade_bot.DAILY_BUDGET
    }

@app.get("/api/holdings")
def holdings():
    return _valuation()["holdings"]

@app.get("/api/history")
def history():
    with db.conn() as c:
        return db.history(c)

@app.get("/api/decisions")
def decisions(limit: int = 15):
    with db.conn() as c:
        return db.recent_decisions(c, min(max(limit, 1), 50))

@app.post("/api/run", status_code=202)
def run_now(bg: BackgroundTasks, x_admin_token: str | None = Header(default=None)):
    if ADMIN_TOKEN and not hmac.compare_digest(x_admin_token or "", ADMIN_TOKEN):
        raise HTTPException(401, "Token admin invalide")
    if trade_bot.state["running"]:
        raise HTTPException(409, "Une analyse est déjà en cours")
    bg.add_task(trade_bot.run_daily_cycle, True)
    return {"status": "started"}

# LA NOUVELLE ROUTE POUR LE GOD MODE
@app.post("/api/buy")
def manual_buy(req: BuyRequest, x_admin_token: str | None = Header(default=None)):
    if ADMIN_TOKEN and not hmac.compare_digest(x_admin_token or "", ADMIN_TOKEN):
        raise HTTPException(401, "Token admin invalide")
        
    result = trade_bot.execute_manual_buy(req.symbol, req.amount_eur)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result

@app.post("/api/sell")
def manual_sell(req: SellRequest, x_admin_token: str | None = Header(default=None)):
    if ADMIN_TOKEN and not hmac.compare_digest(x_admin_token or "", ADMIN_TOKEN):
        raise HTTPException(401, "Token admin invalide")
        
    result = trade_bot.execute_manual_sell(req.symbol, req.sell_pct)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result
