"""Couche PostgreSQL : solde, portefeuille, transactions, décisions IA, snapshots."""
import json
import os
import urllib.parse
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor
from dbutils.pooled_db import PooledDB

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL est manquante dans l'environnement")

urllib.parse.uses_netloc.append("postgres")
url = urllib.parse.urlparse(DATABASE_URL)

# Création du pool de connexions
pool = PooledDB(
    creator=psycopg2,
    maxconnections=5,
    mincached=2,
    maxcached=5,
    blocking=True,
    database=url.path[1:],
    user=url.username,
    password=url.password,
    host=url.hostname,
    port=url.port,
    cursor_factory=RealDictCursor,
    connect_timeout=10
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS account(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    cash REAL NOT NULL DEFAULT 0,
    total_deposited REAL NOT NULL DEFAULT 0,
    last_credit_date TEXT
);
CREATE TABLE IF NOT EXISTS holdings(
    symbol TEXT PRIMARY KEY, name TEXT, asset_type TEXT,
    quantity REAL NOT NULL, avg_cost REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions(
    id SERIAL PRIMARY KEY, ts TEXT, symbol TEXT, side TEXT,
    quantity REAL, price REAL, amount REAL, reason TEXT
);
CREATE TABLE IF NOT EXISTS decisions(
    id SERIAL PRIMARY KEY, ts TEXT, market_view TEXT, risk_level TEXT,
    orders_json TEXT, status TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS snapshots(
    id SERIAL PRIMARY KEY, ts TEXT, cash REAL,
    holdings_value REAL, total REAL, deposited REAL
);
"""

@contextmanager
def conn():
    c = pool.connection()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def init_db():
    with conn() as c:
        with c.cursor() as cur:
            cur.execute(SCHEMA)
            cur.execute("INSERT INTO account(id, cash, total_deposited) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING")

def get_account(c):
    with c.cursor() as cur:
        cur.execute("SELECT * FROM account WHERE id = 1")
        return dict(cur.fetchone())

def get_holdings(c):
    with c.cursor() as cur:
        cur.execute("SELECT * FROM holdings WHERE quantity > 0 ORDER BY symbol")
        return [dict(r) for r in cur.fetchall()]

def credit(c, amount, day):
    with c.cursor() as cur:
        cur.execute(
            "UPDATE account SET cash = cash + %s, total_deposited = total_deposited + %s, last_credit_date = %s WHERE id = 1",
            (amount, amount, day),
        )

def apply_buy(c, symbol, name, asset_type, qty, price, amount, reason, ts):
    with c.cursor() as cur:
        cur.execute("SELECT quantity, avg_cost FROM holdings WHERE symbol = %s", (symbol,))
        row = cur.fetchone()
        if row:
            new_qty = row["quantity"] + qty
            new_avg = (row["quantity"] * row["avg_cost"] + amount) / new_qty
            cur.execute("UPDATE holdings SET quantity = %s, avg_cost = %s WHERE symbol = %s", (new_qty, new_avg, symbol))
        else:
            cur.execute("INSERT INTO holdings VALUES (%s, %s, %s, %s, %s)", (symbol, name, asset_type, qty, price))
        cur.execute("UPDATE account SET cash = cash - %s WHERE id = 1", (amount,))
        cur.execute("INSERT INTO transactions(ts, symbol, side, quantity, price, amount, reason) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  (ts, symbol, "BUY", qty, price, amount, reason))

def apply_sell(c, symbol, qty, price, amount, reason, ts):
    with c.cursor() as cur:
        cur.execute("SELECT quantity FROM holdings WHERE symbol = %s", (symbol,))
        row = cur.fetchone()
        remaining = row["quantity"] - qty
        if remaining < 1e-9:
            cur.execute("DELETE FROM holdings WHERE symbol = %s", (symbol,))
        else:
            cur.execute("UPDATE holdings SET quantity = %s WHERE symbol = %s", (remaining, symbol))
        cur.execute("UPDATE account SET cash = cash + %s WHERE id = 1", (amount,))
        cur.execute("INSERT INTO transactions(ts, symbol, side, quantity, price, amount, reason) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  (ts, symbol, "SELL", qty, price, amount, reason))

def add_snapshot(c, cash, holdings_value, total, deposited):
    with c.cursor() as cur:
        cur.execute("INSERT INTO snapshots(ts, cash, holdings_value, total, deposited) VALUES (%s,%s,%s,%s,%s)",
                  (now_iso(), cash, holdings_value, total, deposited))

def add_decision(c, market_view, risk_level, orders, status, error=None):
    with c.cursor() as cur:
        cur.execute("INSERT INTO decisions(ts, market_view, risk_level, orders_json, status, error) VALUES (%s,%s,%s,%s,%s,%s)",
                  (now_iso(), market_view, risk_level, json.dumps(orders, ensure_ascii=False), status, error))

def recent_decisions(c, limit=15):
    with c.cursor() as cur:
        cur.execute("SELECT * FROM decisions ORDER BY id DESC LIMIT %s", (limit,))
        out = []
        for r in cur.fetchall():
            d = dict(r)
            d["orders"] = json.loads(d.pop("orders_json") or "[]")
            out.append(d)
        return out

def history(c, limit=2000):
    with c.cursor() as cur:
        cur.execute("SELECT ts, cash, holdings_value, total, deposited FROM snapshots ORDER BY id DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
        return [dict(r) for r in rows][::-1]
