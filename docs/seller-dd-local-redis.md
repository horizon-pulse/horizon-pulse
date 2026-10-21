# Seller DD caps: local Redis check (not CI)

`node scripts/test-redis-caps.mjs` runs the real `SPEND_RESERVE_MULTI_LUA` / `ADJUST_ONCE_LUA` scripts, through
`UpstashPremiumStore` and a thin Upstash-REST→RESP shim, against a throwaway local **Redis OSS** (needs `redis-server`
on PATH; bound to 127.0.0.1, random port, no persistence). Keys are under `hp:test:ddcap:<random>:` and the server is
flushed and shut down afterwards. It refuses to run when `CI` is set and is not part of `npm test`.

Cases: 200 parallel reserves (no cap overshoot), day-cap edge, lifetime edge (24.7 + 30 parallel), per-host
(25 parallel), 20 parallel releases refund once, release-before-reserve legacy seed (Sentinel MEDIUM-1).
This is Redis OSS, not Upstash; semantics of EVAL/INCRBY/SET NX are the same, but it is not an Upstash run.
