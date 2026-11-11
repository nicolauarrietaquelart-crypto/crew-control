# Crew Control — Cloudflare migration starter

Independent migration scaffold from Crew Control v11.2.38 Fluid Blocks. **Not yet a functional replacement** for the original Apps Script/Firebase application.

## Current status
- Original HTML preserved at `docs/legacy-Index-v11.2.38.html` for migration; **do not deploy that file publicly**: it contains legacy client configuration and references to old services.
- New D1 SQL schema for services, scenarios, teams, workers, incidents, requirements, and audit.
- Cloudflare Worker with static assets and `/api/health` endpoint.
- No data imported: D1 starts empty.
- Personnel CRUD, login, permissions, PDF parser, PDF export, and legacy UI integration remain to be implemented and tested.

## Setup
1. Create a new GitHub repository named `crew-control` and upload this directory.
2. `npm install`
3. `npx wrangler login`
4. `npx wrangler d1 create crew-control-db`
5. Copy the returned `database_id` into `wrangler.jsonc`.
6. `npm run db:local` for local development; `npm run db:remote` only after reviewing the migration.
7. `npm run dev` to test, then `npm run deploy` when ready.

**Security**: Do not enable write/read endpoints for workers or their mobile numbers until authentication, role authorization, input validation, and appropriate access controls have been implemented. Never commit tokens or secrets. Configure Cloudflare Access or equivalent before production use.

## Next implementation stages
1. Choose and implement Cloudflare Access-based authentication and authorization.
2. Implement Worker API CRUD with D1 transactions and validation.
3. Replace Firebase and `google.script.run` calls in Fluid Blocks UI with `fetch('/api/...')`.
4. Port and test PDF import, including Penny Wise style layout, and export.
5. End-to-end tests, backups and staged deployment.
