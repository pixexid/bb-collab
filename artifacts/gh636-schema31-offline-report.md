# GH-636 schema-31 offline migration report

Source: exact pre-rollout production snapshot copy; the private source path is intentionally omitted.

The snapshot opened at schema 30 with foreign keys enabled and was migrated using the candidate schema-31 migration in one storage transaction.

| Table | Before count | After count | Before identity digest | After identity digest |
| --- | ---: | ---: | --- | --- |
| `execution_attempts` | 322 | 322 | `2803f53d74fe23e933240677e36f600ff7ab8ad0cd97d4e470f0dea6a4b5ec2b` | `2803f53d74fe23e933240677e36f600ff7ab8ad0cd97d4e470f0dea6a4b5ec2b` |
| `evidence_artifacts` | 8 | 8 | `ae9a653feaccb31fa8a8d388d158f1c2e56dcca26f4824865a8be7c0ac6e8ddd` | `ae9a653feaccb31fa8a8d388d158f1c2e56dcca26f4824865a8be7c0ac6e8ddd` |
| `decision_evidence` | 1 | 1 | `8ffe25448d61b983887511d6b5e8e67c2902093047bad542f54952a5ab321ed3` | `8ffe25448d61b983887511d6b5e8e67c2902093047bad542f54952a5ab321ed3` |
| `lane_capacity_refresh_evidence` | 1,740 | 1,740 | `2ce9e2f352f5e194c0beb0978d1f011060adcd0f71e9c6c4f3ff1cf0235c981a` | `2ce9e2f352f5e194c0beb0978d1f011060adcd0f71e9c6c4f3ff1cf0235c981a` |

Checks before and after: `integrity_check=ok`, `foreign_key_check=[]`, and `foreign_keys=1`. The retained decision row digest was `9a09f66cda13c1567914cab84c871869226d6d5e728a1577023d975b172836a8`, and the retained disposition row digest was `0e6a50933ad8b9fbecf571af91f09986ddbe441b95663c7a4ef6ac519261c325`; both, together with the one-row `decision_evidence` chain, were unchanged through success, rollback, and reopen. All three project exports returned `OK`. A fresh reopen retained the same counts and checks. The production-shaped fixture also proved the current parent-drop mutant fails with `FOREIGN KEY constraint failed` while the surrounding transaction preserves the original tables and rows.
