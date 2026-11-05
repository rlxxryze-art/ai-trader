"""Serveur FastAPI + planificateur APScheduler.
Lancement dev  : uvicorn app:app --reload
Lancement prod : gunicorn app:app -k uvicorn.workers.UvicornWorker -w 1 -b 0.0.0.0:$PORT
(-w 1 est important : un seul worker = un seul planificateur.)"""
import hmac
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # doit précéder l’import de trade_bot (lecture des variables d’environnement)

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import db
import trade_bot

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")

BASE = Path(__file__).parent
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
RUN_H, RUN_M = (int(x) for x in os.getenv("DAILY_RUN_TIME", "10:00").split(":"))
SNAP_MIN = int(os.getenv("SNAPSHOT_MINUTES", "30"))
TZ = trade_bot.TZ

scheduler = BackgroundScheduler(timezone=TZ)


@asynccontextmanager
async def lifespan(_app):
    db.init_db()
    now = datetime.now(TZ)
    scheduler.add_job(trade_bot.run_daily_cycle, CronTrigger(hour=RUN_H, minute=RUN_M, timezone=TZ),
                      id="daily", misfire_grace_time=6 * 3600, coalesce=True, max_instances=1)
    scheduler.add_job(trade_bot.take_snapshot, IntervalTrigger(minutes=SNAP_MIN), id="snapshot",
                      next_run_time=now + timedelta(seconds=10), coalesce=True, max_instances=1)
    scheduler.start()
    # Rattrapage : serveur (re)démarré après l’heure prévue sans cycle du jour (ex. hébergeur en veille)
    with db.conn() as c:
        last = db.get_account(c)["last_credit_date"]
    if last != now.date().isoformat() and (now.hour, now.minute) >= (RUN_H, RUN_M):
        scheduler.add_job(trade_bot.run_daily_cycle, DateTrigger(run_date=now + timedelta(seconds=20)),
                          id="catchup", replace_existing=True)
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Alpha IA", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/health")
def health():
    return {"ok": True}


def _valuation():
    market = trade_bot.get_market()
    with db.conn() as c:
        return trade_bot.valuate(c, market)


@app.get("/api/summary")
def summary():
    v = _valuation()
    job = scheduler.get_job("daily")
    pnl = v["total"] - v["deposited"]
    return {"total": v["total"], "cash": v["cash"], "holdings_value": v["holdings_value"],
            "deposited": v["deposited"], "pnl_eur": pnl,
            "pnl_pct": (pnl / v["deposited"] * 100) if v["deposited"] else 0.0,
            "running": trade_bot.state["running"],
            "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None,
            "daily_budget": trade_bot.DAILY_BUDGET}


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
