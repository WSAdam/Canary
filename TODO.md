# Canary TODO

- [x] Spend guardrail no longer pages hourly on a genuine $0 at billing-cycle reset — {total:0,items:[]} with an explicit empty items array is accepted; $0 without any items structure still fails loud (deno-spend.ts)
- [x] Test suite runs on an in-memory KV (CANARY_KV_PATH) so leftover local rows from a different Deno/V8 version can't poison it with deserialize errors (_kv.ts, deno.json)
