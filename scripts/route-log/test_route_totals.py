import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import route_totals as rt  # noqa: E402

B, S = 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'


class RouteTotals(unittest.TestCase):
    def test_parse_dict_and_flat_list(self):
        h = {f'/api/pulse|{B}|calls': '3', f'/api/pulse|{B}|atomic': '15000'}
        flat = [x for kv in h.items() for x in kv]
        exp = {'/api/pulse': {B: {'calls': 3, 'atomic': 15000}}}
        self.assertEqual(rt.parse_paid_hash(h), exp)
        self.assertEqual(rt.parse_paid_hash(flat), exp)

    def test_route_with_pipe_free_rail_and_malformed_skipped(self):
        h = {f'/api/grocery/normalize|{S}|calls': '1', 'junk': '1', '/api/x|r|other': '1', 'nope|r|calls': '1',
             f'/api/gas|{B}|calls': 'x', f'/api/gas|{B}|atomic': '-5'}
        self.assertEqual(rt.parse_paid_hash(h), {'/api/grocery/normalize': {S: {'calls': 1, 'atomic': 0}}})
        self.assertEqual(rt.parse_paid_hash(None), {})

    def test_summarize_across_days_and_rails(self):
        days = {
            '2026-10-18': {f'/api/pulse|{B}|calls': '2', f'/api/pulse|{B}|atomic': '10000',
                           f'/api/signals|{S}|calls': '1', f'/api/signals|{S}|atomic': '15000'},
            '2026-10-17': {f'/api/pulse|{S}|calls': '1', f'/api/pulse|{S}|atomic': '5000'},
        }
        rows = rt.summarize(days)
        self.assertEqual([r['route'] for r in rows], ['/api/pulse', '/api/signals'])
        p = rows[0]
        self.assertEqual((p['calls'], p['usdc'], p['first_day'], p['last_day']), (3, '0.015', '2026-10-17', '2026-10-18'))
        self.assertEqual(p['rails'], {B: {'calls': 2, 'usdc': '0.01'}, S: {'calls': 1, 'usdc': '0.005'}})

    def test_cli_from_json(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump({'2026-10-18': {f'/api/gas|{B}|calls': '1', f'/api/gas|{B}|atomic': '10000'}}, f)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rt.main(['--from-json', f.name, '--json'])
            self.assertEqual(json.loads(buf.getvalue())[0]['usdc'], '0.01')
        finally:
            os.unlink(f.name)

    def test_no_env_no_file_exits_without_network(self):
        env = {k: os.environ.pop(k) for k in ('HP_ROUTE_LOG_URL', 'HP_ROUTE_LOG_READ_TOKEN') if k in os.environ}
        try:
            with self.assertRaises(SystemExit):
                rt.main([])
        finally:
            os.environ.update(env)

    def test_et_days(self):
        import datetime as dt
        self.assertEqual(rt.et_days(2, dt.date(2026, 10, 1)), ['2026-10-01', '2026-09-30'])


if __name__ == '__main__':
    unittest.main()
