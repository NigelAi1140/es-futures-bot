"""
Fetch 5-minute continuous futures data from Yahoo Finance for multiple markets.
Saves in same format as ES.txt: MM/DD/YYYY,HH:MM,open,high,low,close,volume
"""
import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta
import time, sys

MARKETS = {
    "YM":  "YM=F",   # Dow Jones futures
    "RTY": "RTY=F",  # Russell 2000 futures
    "CL":  "CL=F",   # Crude Oil futures
    "GC":  "GC=F",   # Gold futures
    "6E":  "6E=F",   # Euro FX futures
    "ZB":  "ZB=F",   # 30yr Treasury Bond
    "ZN":  "ZN=F",   # 10yr Treasury Note
}

# Yahoo only gives ~60 days of 5m data per request.
# We'll pull in 58-day chunks going back to 2020.
START = datetime(2020, 1, 1)
END   = datetime.now()

def fetch_all(ticker_sym, label):
    all_bars = []
    chunk_end = END
    while chunk_end > START:
        chunk_start = max(chunk_end - timedelta(days=58), START)
        try:
            df = yf.download(
                ticker_sym,
                start=chunk_start.strftime("%Y-%m-%d"),
                end=chunk_end.strftime("%Y-%m-%d"),
                interval="5m",
                progress=False,
                auto_adjust=True,
            )
        except Exception as e:
            print(f"  Error fetching {label}: {e}")
            break

        if df.empty:
            chunk_end = chunk_start
            continue

        # Flatten multi-level columns if present
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        df = df.dropna(subset=["Close"])
        all_bars.append(df)
        oldest = df.index.min()
        print(f"  [{label}] chunk {chunk_start.date()} → {chunk_end.date()} : {len(df)} bars (oldest in chunk: {oldest})")
        chunk_end = chunk_start
        time.sleep(1)  # be polite

    if not all_bars:
        print(f"  [{label}] No data fetched.")
        return

    combined = pd.concat(all_bars).sort_index().drop_duplicates()

    lines = []
    for ts, row in combined.iterrows():
        # Convert to UTC explicitly
        try:
            t = ts.to_pydatetime()
            if t.tzinfo is not None:
                import pytz
                t = t.astimezone(pytz.utc).replace(tzinfo=None)
        except Exception:
            t = ts.to_pydatetime().replace(tzinfo=None)

        mo = str(t.month).zfill(2)
        dy = str(t.day).zfill(2)
        yr = t.year
        hr = str(t.hour).zfill(2)
        mn = str(t.minute).zfill(2)
        o  = round(float(row["Open"]),  4)
        h  = round(float(row["High"]),  4)
        l  = round(float(row["Low"]),   4)
        c  = round(float(row["Close"]), 4)
        v  = int(row.get("Volume", 0) or 0)
        lines.append(f"{mo}/{dy}/{yr},{hr}:{mn},{o},{h},{l},{c},{v}")

    out_path = f"./{label}.txt"
    with open(out_path, "w") as f:
        f.write("\n".join(lines))
    print(f"  [{label}] ✅ {len(lines)} bars written to {out_path}\n")

for label, sym in MARKETS.items():
    print(f"\nFetching {label} ({sym})...")
    fetch_all(sym, label)

print("Done.")
