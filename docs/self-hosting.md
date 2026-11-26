# Setting up a team server

The team server is what lets your team share notes. It stores everything in one folder: a database and a **markdown copy** of every page, laid out like a Local Notes / Obsidian vault.

Pick whichever fits; all three run the same server.

| | Best for | You need |
| --- | --- | --- |
| [**Host from the desktop app**](#host-from-the-desktop-app) | Small teams in one office | A Windows, Mac or Linux PC that stays on |
| [**One-command Linux install**](#one-command-linux-install) | An office server or a small cloud server | A Linux machine and its terminal |
| [**Docker**](#docker-with-https) | Reaching it from the internet with your own domain | Docker and a domain name |

## Host from the desktop app

No terminal, no IT setup.

1. Install the [desktop app](getting-started.md) on a computer that stays on during working hours.
2. Open the vault menu (top-left) → **Host a team server on this computer**. On the welcome screen it's **Host one on this computer**.
3. Click **Start hosting**. If Windows asks whether Local Notes can use the network, choose **Allow** (private networks).
4. Click **Open the team workspace** and follow the three setup steps below.
5. Copy the **Address for teammates** shown in the window and send it to your team.

Tick **Start when this computer starts** so the team can always connect. Closing the window keeps the server running in the system tray (menu bar on a Mac); quit from the tray icon to stop it. The **Open data folder** button shows where the team's notes are stored: back that folder up.

## One-command Linux install

On the Linux machine, open a terminal and run:

```bash
curl -fsSL https://harshid-lgtm.github.io/local-notes/install.sh | bash
```

It downloads the server (and its own copy of Node.js if needed, checksum-verified), sets it up to run in the background and start with the computer, and prints the address to open. No admin rights needed. Run it as `root` instead to install for the whole system in `/opt/local-notes-team`.

Open the printed address in a browser and follow the setup steps below.

Options go after `bash -s --`, for example `… | bash -s -- --port 3001`:

| Option | |
| --- | --- |
| `--port N` | Port to use (default 3000, or the next free one) |
| `--dir PATH` | Where to install (default `~/local-notes-team`) |
| `--no-service` | Don't run it in the background; start it with `manage.sh start` |
| `--uninstall` | Remove it (asks before deleting your notes) |

Already running a team server set up by hand with a `local-notes-team` service? The installer takes it over and keeps its data, port and team name.

### Managing it

Everything is in `~/local-notes-team/manage.sh`:

```bash
~/local-notes-team/manage.sh status
```

| Command | |
| --- | --- |
| `status` | Is it running, and its address |
| `start`, `stop`, `restart` | |
| `logs` | Recent log lines |
| `update` | Install the latest version (keeps your data) |
| `backup` | Save a copy of the database |
| `reset-password EMAIL` | Choose a new password for someone (or use the Admin console) |
| `uninstall` | Remove it |

Settings are in `~/local-notes-team/config.env`; run `manage.sh restart` after changing them.

## First-run setup

The first time anyone opens a new server, it asks for three things:

1. **Your team's name.** This becomes your first shared workspace.
2. **The admin account.** Your name, email and a password.
3. **Who can join.** *Only people I invite* (recommended) or *Anyone who can reach this server*.

Then the **Admin console** opens so you can add your team.

## Admin console

Server admins open it from their account menu (top-left) → **Server admin**. It works the same in the desktop app and in a browser.

- **People:** **Add person** creates an account and gives you a link to send them; they open it and choose their own password. From a person's `•••` menu you can make a **password reset link**, make them a server admin, or **suspend access** (signs them out everywhere until you restore it).
- **Workspaces:** every team workspace with its members and owners. **Join as owner** lets you manage one whose owners have left.
- **Server:** the team name, who can create an account, the address to give teammates, and where the data is stored.
- **Email:** connect your email server (SMTP) so the server can send invitations, share notifications and password links. Use your company's mail server or a provider such as Microsoft 365, Google Workspace, Brevo or SendGrid. **Send test email** checks it works. Without email, people are notified inside Local Notes and you copy invitation links yourself.
- **AI:** choose the AI provider and key everyone uses.

The **Server** tab also chooses who may invite people who aren't on the server yet: anyone who can edit a page (like Google Docs), or only admins.

## Docker (with HTTPS)

You need a small Linux server (1 GB RAM is plenty) with Docker, and a domain name.

1. Point a DNS record such as `notes.yourcompany.com` at the server.
2. Download the deploy kit: [`docker-compose.yml`](https://github.com/harshid-lgtm/local-notes/blob/main/team-server/deploy/docker-compose.yml), [`Caddyfile`](https://github.com/harshid-lgtm/local-notes/blob/main/team-server/deploy/Caddyfile) and [`.env.example`](https://github.com/harshid-lgtm/local-notes/blob/main/team-server/deploy/.env.example).
3. Configure and start:

   ```bash
   cp .env.example .env    # set DOMAIN
   docker compose up -d
   ```

4. Open `https://notes.yourcompany.com` and follow the setup steps.

[Caddy](https://caddyserver.com) gets and renews the HTTPS certificate automatically. Update with:

```bash
docker compose pull && docker compose up -d
```

Reset a password from the terminal with:

```bash
docker compose exec -it notes node src/reset-password.js you@example.com
```

## Settings

The team name and who can join are set in the setup wizard and the Admin console. These environment variables (in `config.env`, the Docker `.env`, or your service file) cover the rest:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database and markdown copy are stored |
| `PUBLIC_URL` | — | The address people use, e.g. `https://notes.example.com`, for links the server creates |
| `MIRROR` | `true` | Write every page to `DATA_DIR/vault` as markdown |
| `AI_RATE_LIMIT` | `60` | AI requests per person per 10 minutes |
| `TEAM_NAME`, `SIGNUP` | `Team`, `invite` | Defaults before setup; the Admin console overrides them |

## Backups

Back up the data folder: it holds `team.db` (accounts, pages, history and comments) and `vault/` (a plain markdown copy of every page). For a consistent copy of the database while it's running, use `manage.sh backup`, or:

```bash
node -e "new (require('node:sqlite').DatabaseSync)('team.db').exec(\"VACUUM INTO 'backup.db'\")"
```

## From source

Requires Node.js 22.13 or newer.

```bash
npm install && npm run build      # in the repository root
cd team-server && npm install
npm start                         # http://localhost:3000
```

## Security notes

- Use HTTPS whenever the server is reachable from the internet. On a private office network, plain http is common.
- Passwords are hashed with scrypt; sessions and password links are random tokens stored hashed; sign-in is rate-limited.
- Private spaces and invite-only pages are enforced on the server. Admins can't read other people's private pages through the app.
- The AI key set by the admin is stored in the server database and never sent to browsers.
