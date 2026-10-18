"""Per-route paid totals from the server route log (read-only).

Source: the payer-free hash hp:rl:p:<ET day> written by lib/route-log.ts on every
paid_settled request:  "<route>|<rail>|calls" -> n,  "<route>|<rail>|atomic" -> sum
(atomic = the route's USD price in 6-decimal units, the same on every rail).

Two inputs, no writes anywhere:
  --from-json FILE   an export {"YYYY-MM-DD": {field: value, ...}, ...} (e.g. produced by
                     whoever holds read access: HGETALL hp:rl:p:<day> per day)
  (default)          Upstash REST with HP_ROUTE_LOG_URL + HP_ROUTE_LOG_READ_TOKEN from the
                     environment (a READ-ONLY token; never read from a file here). HGETALL only.

Output: one row per route (calls, USDC, per-rail split), newest data first; --json for machines.
Standard library only.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
from decimal import Decimal

ATOMIC = Decimal(10) ** 6


def parse_paid_hash(h):
    """{field: value} (or Upstash's flat [f, v, f, v...]) -> {route: {rail: {'calls': int, 'atomic': int}}}.
    Malformed fields are skipped, never raised."""
    if isinstance(h, list):
        h = dict(zip(h[0::2], h[1::2]))
    out = {}
    if not isinstance(h, dict):
        return out
    for field, value in h.items():
        parts = str(field).rsplit('|', 2)
        if len(parts) != 3 or parts[2] not in ('calls', 'atomic') or not parts[0].startswith('/api/'):
            continue
        try:
            n = int(value)
        except (TypeError, ValueError):
            continue
        if n < 0:
            continue
        route, rail, kind = parts
        out.setdefault(route, {}).setdefault(rail, {'calls': 0, 'atomic': 0})[kind] += n
    return out


def summarize(days):
    """{day: hash} -> list of {route, calls, usdc, rails: {rail: {calls, usdc}}, first_day, last_day},
    sorted by USDC desc then route."""
    acc = {}
    for day in sorted(days):
        for route, rails in parse_paid_hash(days[day]).items():
            r = acc.setdefault(route, {'route': route, 'calls': 0, 'atomic': 0, 'rails': {}, 'first_day': day, 'last_day': day})
            r['last_day'] = day
            for rail, v in rails.items():
                r['calls'] += v['calls']
                r['atomic'] += v['atomic']
                rr = r['rails'].setdefault(rail, {'calls': 0, 'atomic': 0})
                rr['calls'] += v['calls']
                rr['atomic'] += v['atomic']
    rows = []
    for r in acc.values():
        rows.append({
            'route': r['route'], 'calls': r['calls'], 'usdc': str(Decimal(r['atomic']) / ATOMIC),
            'rails': {k: {'calls': v['calls'], 'usdc': str(Decimal(v['atomic']) / ATOMIC)} for k, v in sorted(r['rails'].items())},
            'first_day': r['first_day'], 'last_day': r['last_day'],
        })
    rows.sort(key=lambda x: (-Decimal(x['usdc']), x['route']))
    return rows


def et_days(n, today=None):
    today = today or dt.datetime.now(dt.timezone(dt.timedelta(hours=-4))).date()  # ET (EDT); off by one hour in EST, harmless for a day list
    return [(today - dt.timedelta(days=i)).isoformat() for i in range(n)]


def fetch_days(url, token, days):
    out = {}
    for day in days:
        req = urllib.request.Request(url.rstrip('/'), data=json.dumps(['HGETALL', f'hp:rl:p:{day}']).encode(), method='POST',
                                     headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.load(r)
        if 'error' in body:
            raise RuntimeError(body['error'])
        if body.get('result'):
            out[day] = body['result']
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--from-json')
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    if a.from_json:
        with open(a.from_json) as f:
            days = json.load(f)
    else:
        url, token = os.environ.get('HP_ROUTE_LOG_URL', ''), os.environ.get('HP_ROUTE_LOG_READ_TOKEN', '')
        if not url.startswith('https://') or not token:
            sys.exit('use --from-json, or set HP_ROUTE_LOG_URL (https) and HP_ROUTE_LOG_READ_TOKEN (read-only token)')
        days = fetch_days(url, token, et_days(max(1, min(a.days, 90))))
    rows = summarize(days)
    if a.json:
        print(json.dumps(rows, indent=1))
        return
    print(f"{'route':28} {'calls':>6} {'USDC':>10}  rails")
    for r in rows:
        rails = ', '.join(f"{k} {v['calls']}/{v['usdc']}" for k, v in r['rails'].items())
        print(f"{r['route']:28} {r['calls']:>6} {r['usdc']:>10}  {rails}")
    print(f"{'total':28} {sum(r['calls'] for r in rows):>6} {str(sum(Decimal(r['usdc']) for r in rows)):>10}")


if __name__ == '__main__':
    main()
