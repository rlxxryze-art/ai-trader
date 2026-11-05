"""Couche SQLite : solde, portefeuille, transactions, décisions IA, snapshots."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "trading.db"))

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
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, symbol TEXT, side TEXT,
    quantity REAL, price REAL, amount REAL, reason TEXT
);
CREATE TABLE IF NOT EXISTS decisions(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, market_view TEXT, risk_level TEXT,
    orders_json TEXT, status TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS snapshots(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, cash REAL,
    holdings_value REAL, total REAL, deposited REAL
);
"""


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
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
        c.executescript(SCHEMA)
        c.execute("INSERT OR IGNORE INTO account(id, cash, total_deposited) VALUES (1, 0, 0)")


def get_account(c):
    return dict(c.execute("SELECT * FROM account WHERE id = 1").fetchone())


def get_holdings(c):
    return [dict(r) for r in c.execute("SELECT * FROM holdings WHERE quantity > 0 ORDER BY symbol")]


def credit(c, amount, day):
    c.execute(
        "UPDATE account SET cash = cash + ?, total_deposited = total_deposited + ?, last_credit_date = ? WHERE id = 1",
        (amount, amount, day),
    )


def apply_buy(c, symbol, name, asset_type, qty, price, amount, reason, ts):
    row = c.execute("SELECT quantity, avg_cost FROM holdings WHERE symbol = ?", (symbol,)).fetchone()
    if row:
        new_qty = row["quantity"] + qty
        new_avg = (row["quantity"] * row["avg_cost"] + amount) / new_qty
        c.execute("UPDATE holdings SET quantity = ?, avg_cost = ? WHERE symbol = ?", (new_qty, new_avg, symbol))
    else:
        c.execute("INSERT INTO holdings VALUES (?, ?, ?, ?, ?)", (symbol, name, asset_type, qty, price))
    c.execute("UPDATE account SET cash = cash - ? WHERE id = 1", (amount,))
    c.execute("INSERT INTO transactions(ts, symbol, side, quantity, price, amount, reason) VALUES (?,?,?,?,?,?,?)",
              (ts, symbol, "BUY", qty, price, amount, reason))


def apply_sell(c, symbol, qty, price, amount, reason, ts):
    row = c.execute("SELECT quantity FROM holdings WHERE symbol = ?", (symbol,)).fetchone()
    remaining = row["quantity"] - qty
    if remaining < 1e-9:
        c.execute("DELETE FROM holdings WHERE symbol = ?", (symbol,))
    else:
        c.execute("UPDATE holdings SET quantity = ? WHERE symbol = ?", (remaining, symbol))
    c.execute("UPDATE account SET cash = cash + ? WHERE id = 1", (amount,))
    c.execute("INSERT INTO transactions(ts, symbol, side, quantity, price, amount, reason) VALUES (?,?,?,?,?,?,?)",
              (ts, symbol, "SELL", qty, price, amount, reason))


def add_snapshot(c, cash, holdings_value, total, deposited):
    c.execute("INSERT INTO snapshots(ts, cash, holdings_value, total, deposited) VALUES (?,?,?,?,?)",
              (now_iso(), cash, holdings_value, total, deposited))


def add_decision(c, market_view, risk_level, orders, status, error=None):
    c.execute("INSERT INTO decisions(ts, market_view, risk_level, orders_json, status, error) VALUES (?,?,?,?,?,?)",
              (now_iso(), market_view, risk_level, json.dumps(orders, ensure_ascii=False), status, error))


def recent_decisions(c, limit=15):
    out = []
    for r in c.execute("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", (limit,)):
        d = dict(r)
        d["orders"] = json.loads(d.pop("orders_json") or "[]")
        out.append(d)
    return out


def history(c, limit=2000):
    rows = c.execute("SELECT ts, cash, holdings_value, total, deposited FROM snapshots ORDER BY id DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows][::-1]
