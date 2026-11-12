# Vercel deployment

The project is configured for Vercel with the Node.js 24 runtime, one API function, and static assets from `public/`.

## Persistent storage

Vercel function storage is temporary. The `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` secrets connect SQLite-compatible database reads and writes to Turso. Attachments, exported files, and encrypted database backups are stored as private chunks in that database; they are delivered only by authenticated API routes.

Use the Vercel Marketplace Turso Starter plan to keep database charges at $0. The deployment uses the Tokyo region. The plan has monthly read, write, and storage limits; check Turso usage if the application grows.

## Production secrets

The Vercel Production environment needs these secrets:

- `ADMIN_USERNAME`: first administrator account name.
- `ADMIN_PASSWORD`: initial password with at least 16 characters, including a letter and a number.
- `ADMIN_MFA_SECRET`: private 32-character Base32 seed for TOTP verification.
- `CRON_SECRET`: secret bearer token used by Vercel's daily backup schedule.
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`: supplied by the connected Turso integration.

On the first production request, the application creates a clean schema and the configured administrator. It does not upload or import the local `data/` directory. The administrator must enroll their TOTP seed in an authenticator app.

## Attachments and backups

Production attachments can be up to 50 MB. The browser sends 2 MB chunks, keeping each Base64 JSON request below Vercel Functions' 4.5 MB request-body limit. Unfinished upload sessions expire after one hour. Cloud backups are encrypted with AES-256-GCM and retained for 30 days. Vercel runs the backup route daily at 02:00 China Standard Time.

## Verification

Run `pnpm test` before deploying. The test suite uses disposable local directories and does not touch the production Turso database.
