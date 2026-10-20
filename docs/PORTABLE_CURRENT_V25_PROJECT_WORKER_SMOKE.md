# Current V25 Project Worker smoke

Both complete Verify runs on `767f1c0` passed 3,727 source and 980 mounted cases, then failed when the Project Worker smoke still requested historical V24 from the current identity-bearing installation. The failure logs are retained separately.

The smoke now explicitly checks V24 refusal and V25 success, including the current checkpoint and all existing artifact hashes. Project CRUD, assets, accepted-write retries, rollback, references, conflict and lifecycle assertions remain intact. Actual source-mode Worker/D1 smoke, a fresh `npm run build`, and the production Worker/assets smoke all exited successfully. The production smoke also checked health, SPA and JavaScript serving, Access rejection, and 201 distinct references. Both Miniflare owners and isolated fixture directories closed.

This corrects the verification client; application code, raw migrations and frozen writers are unchanged. New own-head complete Verify/Map gates remain required before merge. It does not qualify remote Access, providers or the complete Node application. Exact hashes and retained failure/pass logs are in [the receipt](PORTABLE_CURRENT_V25_PROJECT_WORKER_SMOKE_RECEIPT.json).
