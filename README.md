# Pocket self-hosted server

The standard Pocket API for families who operate their own server. Connect the Pocket iPhone app to your server address in **Family → Server**, then create a family or sign in with its family code.

Public source: [UpperDownGuy/pocket-server](https://github.com/UpperDownGuy/pocket-server).

This repository contains the standalone server and its tests. It does not contain the iPhone app source, hosted AI assistant, paid AI subscription verification, publisher credentials, hosted-service deployment settings, or family data. The normal family tracker works independently of the hosted service. Paid hosted features do not transfer to this server.

## Included features

- Separate families and parent/child accounts, with eight-digit family codes.
- Balances, allowances, purchases, transaction history, and scoped inbox notifications.
- Recurring weekly, monthly, and yearly balance deductions, including negative balances.
- The subscription feed used by the app's on-device Apple Reminders integration.
- File Tracker connection codes, computer logs, earnings QR redemption, and changed-item lists.
- Safari receipt-capture API and duplicate-purchase protection.
- Optional direct Apple push delivery when the operator has credentials authorized for the installed app.
- Online multi-family backups and an offline reset helper.

Pocket records money; it does not move real funds, authorize spending, or charge bank cards. Parents manage their family. Children can record their own purchases and redeem their own earnings; other families and siblings do not receive their private transaction details.

## Run with Node.js

Use **Node.js 22.13 or newer**. This server has no external npm dependencies.

```powershell
Copy-Item .env.example .env
npm start
```

The default address is `http://127.0.0.1:8787`. For local phone testing, set `HOST` in `.env` to the computer's private LAN address and allow TCP 8787 through its firewall. Enter `http://<server-lan-address>:8787` in Pocket. On an iPhone, `localhost` points to the phone, not the server.

Use HTTPS with a trusted certificate for access outside a trusted private development network. Place the API behind a reverse proxy; forward all API paths and allow at least 512 KiB request bodies for File Tracker reports. The API is designed for native clients and rejects browser requests carrying an `Origin` header. It is not a web-based admin dashboard.

## Run with Docker Compose

Docker Desktop on Windows must use its Linux engine.

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait
docker compose ps
```

The API is published only to `127.0.0.1:8787` by default. Configure a reverse proxy on the host for HTTPS, or change `POCKET_BIND_ADDRESS` in `.env` to the server's private LAN IP for development. Docker's `HOST`, `PORT`, and `DB_PATH` are set by Compose to listen inside the container and use the persistent volume.

The named `pocket-data` volume contains every family's records and backups. Keep the same Compose project name when updating. **Do not run `docker compose down -v`** unless you intentionally want to remove the data volume.

To apply an update, back up first, then stop on any failed command:

```powershell
git pull --ff-only
docker compose build --pull
docker compose up -d --wait
```

If the checkout has local commits, `git pull --ff-only` may refuse; resolve the divergence deliberately rather than resetting or discarding local deployment work.

## Create and use families

In Pocket, change the server address to your HTTPS or private-LAN URL and choose **Create a family**. This creates its first parent and returns a permanent eight-digit family code. Sign in with that code, your username, and your password. A family code alone grants no access. Passwords must be at least ten characters.

The parent adds children and other parents in **Family → Add member**. Balances begin at zero. Usernames can be reused in separate families. The server allows multiple separate families and throttles public family registration and login attempts. The legacy `POST /setup` route remains only for older clients before families have been registered; new clients use `/families`.

Parents can delete their own family from the app. Deletion does not delete other families or existing backup copies.

## Optional phone notifications

The in-app inbox works without Apple credentials. Background/lock-screen alerts require the installed iPhone app to have the push entitlement and the server to have a corresponding APNs key. **Owning an arbitrary Apple Developer account does not authorize sending notifications to another developer's App Store app.** Publisher keys are not included or distributed by this repository. A shared push relay is not included.

Operators who build and sign their own compatible app may configure its matching Apple credentials:

```dotenv
APNS_ENVIRONMENT=production
APNS_TEAM_ID=YOUR_TEAM_ID
APNS_KEY_ID=YOUR_KEY_ID
APNS_TOPIC=YOUR_SIGNED_APP_BUNDLE_ID
APNS_KEY_PATH=/run/pocket-apns/AuthKey.p8
```

For local Node, use the actual private key path. For Docker, keep the key outside the checkout and add a read-only file mount in `compose.override.yaml`:

```yaml
services:
  api:
    volumes:
      - type: bind
        source: /absolute/private/path/AuthKey.p8
        target: /run/pocket-apns/AuthKey.p8
        read_only: true
        bind:
          create_host_path: false
```

On Windows use a path such as `C:/Private/Pocket/AuthKey.p8` for the mount source. Ensure container user `node` can read the mounted file. Supply the `APNS_*` settings in `.env`, then recreate the API. Never commit the key or copy it into the image.

TestFlight, App Store, and ad hoc installations use APNs `production`; development-signed installations use `sandbox`. Match the signed app, not a build profile's name. In-app alerts go to every parent and only the child involved; phone alerts have the same recipient scope when configured and enabled.

## Backups and restore

For Docker, create an online backup:

```powershell
docker compose exec api node backup-families.mjs --db-path /app/data/pocket.sqlite
```

The helper writes a verified backup directory and manifest under `/app/data/family-backups` and prints its exact path. Copy it off the server using `docker compose cp api:/app/data/family-backups/<printed-directory-name> ./backups/` after creating your local `backups` directory. Local Node users run `node backup-families.mjs --db-path <absolute-database-path>` instead.

The storage set includes:

- `pocket.sqlite`: legacy family database.
- `pocket.sqlite.families.sqlite`: the family registry.
- `pocket.sqlite.families/`: separate family databases.
- SQLite WAL/SHM sidecars when using a filesystem copy.

For a filesystem backup, stop the API and copy the entire data directory, not just one SQLite file. Restore into the same data-path layout with the API stopped, preserve a copy of the old data, and verify the manifest. The online backup records absolute registry paths; changing the data location requires a deliberate migration. Avoid downgrading to a server that cannot understand the stored schema or completed family deletions.

`reset-families.mjs` is an administrator-only offline tool. It requires the API to be stopped and the explicit `WIPE-ALL-FAMILIES` confirmation, makes a backup, and removes every family. Normal use does not require it.

## Privacy and operator responsibilities

Your server stores family/member names, usernames, password hashes, sessions, ledger entries, notes, recurring-charge schedules, notification records, and optional device tokens. File Tracker reports include relative filenames and changes, not file contents. Safari sends recognized order details, not card numbers or full web pages. Apple Reminders synchronization runs on the phone; the server supplies subscription records.

Backups also contain these records. Protect the host, private configuration, logs, and backups; define your own access, backup-retention, and deletion practices. Supply a support contact and privacy policy for the server you operate. The app's default hosted service does not operate or back up your independent server.

## Tests

```powershell
npm test
```

The suite covers family isolation, account authorization, File Tracker redemption and pairing, recurring charges, scoped notification delivery, backup consistency, and deletion/reset behavior.

## Source history

This standalone snapshot was extracted from Pocket's standard server at commit `70626fdeff37b0a2458f9b02928ed098dc3210df`. It deliberately starts a new repository history without hosted-service configuration or application source. No additional software license has been asserted in this split.
