#!/usr/bin/env python3
"""attach-hunt — batch-score CWR (or any wholesale) SKUs as Amazon FBM attach candidates.

Runs each ASIN through the live NexLaunch SP-API server (real Buy Box, real FBM
fees) and applies the 8 attach gates from the first-product plan. Stdlib only.

Usage:
    python3 tools/attach-hunt.py candidates.csv [-o report.csv]

Input CSV columns (header required, extra columns ignored):
    asin       required  Amazon child ASIN
    wholesale  required  your CWR dealer cost per unit ($)
    ship       optional  supplier ship-to-customer cost (default 9.95 — CWR flat special)
    name       optional  your label for the row (falls back to live catalog title)
    stock      optional  units in stock at supplier; 0 kills the row

Gates (KILL = hard fail, WARN = list anyway but flagged for manual check):
    1 live-buybox   no live Buy Box (variation parent / dead listing)      KILL
    2 multi-offer   fewer than 3 offers (gating/attach-hostile risk)       KILL (WARN if unknown)
    3 price-band    Buy Box outside $60-150                               KILL
    4 margin        net < $15/unit or ROI < 25% (real FBM fees)            KILL
    5 brand         CWR authorized-brand list hit                         KILL
                    other brand-looking token in title                     WARN (check "Sell on Amazon")
    6 seasonal      title/category smells end-of-season                    WARN
    7 velocity      modeled sales < 30 units/mo (BSR power-law)            KILL (WARN if no BSR)
    8 stock         stock column present and 0                             KILL

Needs the VPS API. Token read from $NEXLAUNCH_API_TOKEN or ~/Desktop/nexlaunch-vps-connect.txt.
Throttled to ~1 req/1.5s to protect the SP-API fees quota.
"""

import csv, json, math, os, re, sys, time, urllib.request

API_BASE = os.environ.get("NEXLAUNCH_API_BASE", "http://100.125.249.79:4879")  # box1 tailnet IP; public 5.161.117.84 is firewalled
CONNECT_FILE = os.path.expanduser("~/Desktop/nexlaunch-vps-connect.txt")

# Gate knobs — defaults are the CWR-era profile ($60-150 accessories, FBM attach).
# Override per supplier, e.g. a Kole low-ticket/bundle run:
#   HUNT_BAND_MIN=15 HUNT_BAND_MAX=60 HUNT_MIN_NET=6 HUNT_SHIP=6.50 tools/attach-hunt.py kole.csv
BAND_MIN = float(os.environ.get("HUNT_BAND_MIN", 60))
BAND_MAX = float(os.environ.get("HUNT_BAND_MAX", 150))
MIN_NET = float(os.environ.get("HUNT_MIN_NET", 15))
MIN_ROI = float(os.environ.get("HUNT_MIN_ROI", 0.25))
DEFAULT_SHIP = float(os.environ.get("HUNT_SHIP", 9.95))

# CWR brands that require manufacturer authorization (captured from their
# dealer application 2026-07-26). We declared none, so these are off-limits.
CWR_AUTH_BRANDS = [
    "abu garcia", "acr electronics", "airhead", "airmar", "ancor", "arco zeus",
    "b&g", "battery tender", "bep marine", "berkley", "blue sea", "c-map",
    "c.e. smith", "coleman", "curt", "daiwa", "dometic", "ds18", "fell marine",
    "flir", "furuno", "fusion", "garmin", "golight", "hatteland", "icom",
    "jl audio", "kicker", "lenco", "lewmar", "lowrance", "lumishore", "lumitec",
    "magma", "marinco", "mastervolt", "navico", "ocean signal", "penn",
    "pflueger", "power-pole", "promariner", "ram mount", "raymarine",
    "scanstrut", "seakeeper", "seaview", "seipel", "simrad", "sionyx",
    "standard horizon", "steiner", "sureshade", "taylor made", "thetford",
    "tigress", "vesper", "guest",
]

SEASONAL_SMELLS = [
    "dock line", "buoy", "fender", "towable", "tube", "water ski", "wakeboard",
    "kayak", "paddle", "inflatable", "snorkel", "swim", "pool", "bimini",
    "winteriz", "snow", "ice fishing",
]

# BSR -> monthly sales power law, ported from js/data.js
BSR_MODEL = {
    "electronics": (96000, 0.55), "home & kitchen": (132000, 0.52),
    "sports & outdoors": (78000, 0.55), "beauty": (118000, 0.53),
    "grocery": (105000, 0.52), "toys & games": (88000, 0.54),
    "pet supplies": (72000, 0.54), "office products": (61000, 0.56),
}
BSR_DEFAULT = (90000, 0.54)

# Generic words that look brand-ish but aren't (subset of app.js RS_COMMON_WORDS
# plus marine vocabulary). Lowercase.
COMMON_WORDS = set(("""with for and the pro max mini plus set kit pack premium marine boat deck hull
stainless steel waterproof wireless portable adjustable mount mounting bracket holder cover
led light lights navigation anchor rod reel line trolling motor battery charger cable adapter
antenna radio speaker gauge sensor pump switch panel plug socket hitch trailer winch strap
tie-down organizer storage box case bag heavy duty universal replacement accessory accessories
digital electric manual automatic compact folding telescoping swivel quick release low profile
high performance series model amazon product bed memory foam""").split())


def load_token():
    tok = os.environ.get("NEXLAUNCH_API_TOKEN")
    if tok:
        return tok.strip()
    try:
        with open(CONNECT_FILE) as f:
            for line in f:
                if line.lower().startswith("bearer token:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    sys.exit("No API token: set NEXLAUNCH_API_TOKEN or keep it in " + CONNECT_FILE)


def api_xray(asin, token):
    url = f"{API_BASE}/api/xray?asin={asin}&fulfillment=fbm"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def est_sales(bsr, rank_title):
    key = (rank_title or "").lower()
    a, b = BSR_DEFAULT
    for k, coef in BSR_MODEL.items():
        if k in key:
            a, b = coef
            break
    return max(1, round(a * bsr ** (-b)))


def brand_token(title):
    for w in title.split()[1:]:
        if re.fullmatch(r"[A-Z][A-Za-z&-]{2,}", w) and w.lower() not in COMMON_WORDS:
            return w
    return None


def score_row(row, live):
    kills, warns = [], []
    title = None; buybox = None; net = roi = None; units = None

    cat = live.get("catalog") or {}
    summaries = cat.get("summaries") or [{}]
    title = row.get("name") or summaries[0].get("itemName") or row["asin"]

    # gate 1: live buy box
    if not live.get("hasLiveBuyBox"):
        kills.append("no live Buy Box" + (" — " + live["priceWarning"] if live.get("priceWarning") else ""))
        return title, buybox, net, roi, units, kills, warns

    offers = ((live.get("offers") or {}).get("payload") or {}).get("Summary") or {}
    bb = (offers.get("BuyBoxPrices") or [{}])[0].get("LandedPrice", {})
    buybox = float(bb.get("Amount") or 0)
    offer_count = offers.get("TotalOfferCount")

    # gate 2: multi-offer
    if offer_count is None:
        warns.append("offer count unknown")
    elif offer_count < 3:
        kills.append(f"only {offer_count} offer(s) — attach-hostile/gating risk")

    # gate 3: price band
    if not (BAND_MIN <= buybox <= BAND_MAX):
        kills.append(f"Buy Box ${buybox:.2f} outside ${BAND_MIN:g}-{BAND_MAX:g} band")

    # gate 4: margin with real FBM fees (validated against feesEstimatedAt)
    fees_total = None
    fe = ((live.get("fees") or {}).get("payload") or {}).get("FeesEstimateResult", {}).get("FeesEstimate", {})
    amt = (fe.get("TotalFeesEstimate") or {}).get("Amount")
    est_at = live.get("feesEstimatedAt")
    if amt is not None and est_at is not None and abs(float(est_at) - buybox) <= 0.01:
        fees_total = float(amt)
        fee_note = "real"
    else:
        fees_total = round(buybox * 0.15, 2)
        fee_note = "est 15%"
        warns.append("fees estimated (fee endpoint unavailable/mismatched)")
    wholesale = float(row["wholesale"])
    ship = float(row.get("ship") or DEFAULT_SHIP)
    net = buybox - fees_total - wholesale - ship
    cash_in = wholesale + ship
    roi = net / cash_in if cash_in else 0
    if net < MIN_NET or roi < MIN_ROI:
        kills.append(f"margin: net ${net:.2f}, ROI {roi*100:.0f}% ({fee_note} fees)")

    # gate 5: brands
    tl = title.lower()
    hit = next((b for b in CWR_AUTH_BRANDS if b in tl), None)
    if hit:
        kills.append(f"CWR authorized-brand list: {hit} (not authorized)")
    else:
        tok = brand_token(title)
        if tok:
            warns.append(f'brand-ish token "{tok}" — verify ungated via Sell on Amazon button')

    # gate 6: seasonality
    smell = next((s for s in SEASONAL_SMELLS if s in tl), None)
    if smell:
        warns.append(f"seasonal smell: {smell} (late-July timing — check demand curve)")

    # gate 7: velocity
    bsr = rank_title = None
    for sr in cat.get("salesRanks") or []:
        entry = (sr.get("displayGroupRanks") or sr.get("classificationRanks") or [{}])[0]
        if entry.get("rank"):
            bsr, rank_title = entry["rank"], entry.get("title")
            break
    if bsr:
        units = est_sales(bsr, rank_title)
        if units < 30:
            kills.append(f"velocity: ~{units} units/mo modeled (BSR #{bsr})")
    else:
        warns.append("no BSR — velocity unknown")

    # gate 8: stock
    if row.get("stock") not in (None, "",) and float(row["stock"]) <= 0:
        kills.append("out of stock at supplier")

    return title, buybox, net, roi, units, kills, warns


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out_path = sys.argv[sys.argv.index("-o") + 1] if "-o" in sys.argv else None
    token = load_token()

    with open(src, newline="") as f:
        rows = [{k.strip().lower(): v.strip() for k, v in r.items()} for r in csv.DictReader(f)]
    results = []
    for i, row in enumerate(rows):
        asin = row.get("asin", "").upper()
        if not re.fullmatch(r"B0[A-Z0-9]{8}", asin):
            results.append((row.get("name") or asin or "?", asin, None, None, None, None, ["invalid ASIN"], []))
            continue
        try:
            live = api_xray(asin, token)
        except Exception as e:
            results.append((row.get("name") or asin, asin, None, None, None, None, [f"API error: {e}"], []))
            continue
        title, bb, net, roi, units, kills, warns = score_row(row, live)
        results.append((title, asin, bb, net, roi, units, kills, warns))
        status = "KILL" if kills else ("WARN" if warns else "PASS")
        print(f"[{i+1}/{len(rows)}] {status:4} {asin} {title[:50]}")
        if i < len(rows) - 1:
            time.sleep(1.5)  # protect the ~1rps fees quota

    survivors = [r for r in results if not r[6]]
    survivors.sort(key=lambda r: -(r[3] or 0))
    dead = [r for r in results if r[6]]

    print("\n=== SURVIVORS (ranked by net/unit) ===")
    if not survivors:
        print("none — every candidate died. That is a valid (and cheap) outcome.")
    for t, asin, bb, net, roi, units, _, warns in survivors:
        print(f"  {asin}  ${bb:.2f} BB  net ${net:.2f}/unit  ROI {roi*100:.0f}%  ~{units or '?'} u/mo  {t[:46]}")
        for w in warns:
            print(f"        ⚠ {w}")
    print(f"\n=== KILLED ({len(dead)}) ===")
    for t, asin, bb, net, roi, units, kills, _ in dead:
        print(f"  {asin}  {t[:46]}")
        for k in kills:
            print(f"        ✖ {k}")

    if out_path:
        with open(out_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["status", "asin", "title", "buybox", "net_per_unit", "roi_pct", "est_units_mo", "kills", "warns"])
            for t, asin, bb, net, roi, units, kills, warns in results:
                w.writerow(["KILL" if kills else "PASS", asin, t,
                            f"{bb:.2f}" if bb else "", f"{net:.2f}" if net is not None else "",
                            f"{roi*100:.0f}" if roi is not None else "", units or "",
                            " | ".join(kills), " | ".join(warns)])
        print(f"\nreport written to {out_path}")


if __name__ == "__main__":
    main()
