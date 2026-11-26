# Working with your team

With a [team server](self-hosting.md), Local Notes becomes a shared, real-time wiki for your team — and every person keeps a private space.

## Connect

- **Desktop app:** vault menu (top-left) → **Connect to a team server**, enter its address, then sign in.
- **Browser:** open your server's address, e.g. `https://notes.yourcompany.com`.

Don't have a server yet? [Set one up](self-hosting.md): host it from the desktop app with one click, or install it on a Linux machine with one command. Whoever sets it up becomes the admin.

People join when an admin adds them in the **Admin console** (they get a link to choose a password) or when someone sends them an **invite link** to a workspace. Forgot your password? Ask an admin for a reset link.

## Private and shared

The sidebar shows **Private** — pages only you can see unless you share them — then **Shared with me**, then each team workspace you belong to. Workspace members see every page in it, except pages set to *Only people invited*.

You can belong to as many workspaces as you like, so a company can have one per team (Engineering, Sales, Leadership…). Create one with **New workspace** at the bottom of the sidebar.

| Role | Can |
| --- | --- |
| Owner | Everything, plus add or remove people, change roles, rename or delete the workspace |
| Editor | Create, edit, move and delete pages; comment |
| Viewer | Read pages and comments |

## Server admins

Admins manage the whole server from their account menu → **Server admin**: add people, send password reset links, suspend someone's access, see every workspace, change who can join, and set up AI. See [Admin console](self-hosting.md#admin-console).

## Add people to a workspace

Open a workspace's `•••` menu → **Share & members**. Workspace owners can:

- **Add people already on this server**: type a name or email, pick a role and click **Add**. They're notified and the workspace appears in their sidebar straight away.
- **Invite with a link** for people who don't have an account yet. Links work for 14 days.
- Change anyone's role, or remove them with **×**. Removing someone disconnects them from the workspace's pages immediately.

## Share a page (like Google Docs)

Click **Share** at the top of any page — including pages in your private space.

1. Start typing a name or email. Suggestions appear underneath, like in Gmail: people on this server, people you've shared with before (most recent first) and your [contacts](#contacts). Press `Enter` or click to add them; add as many as you like. Pasting a list of email addresses works too.
2. Choose **Editor** or **Viewer**.
3. Leave **Notify people** ticked, add a message if you like, and click **Send**.

People who already have an account get an email (if your server has email set up) and a notification in their Inbox, and the page appears under **Shared with me**. **Anyone else gets an invitation**: they open the link, create their account with that email address, and land on the page. If email isn't set up, the dialog shows their invitation links to copy and send yourself.

In the same window:

- **People with access**: change someone to Editor or Viewer, or **Remove access**. Changes apply live: someone viewing the page is switched to read-only or taken off it. Invitations that haven't been accepted show as *Invited*; you can copy their link again or cancel them.
- **General access**:
  - **Only people invited**: hidden from everyone else in the workspace, including the sidebar, search, links, graph and Ask AI. A lock appears next to it in the sidebar.
  - **Everyone in *workspace***: the usual for team pages.
  - **Anyone with the link**: anyone signed in to this server who has the link can view (or edit, if you choose). They're added to the list when they open it; switching the link off removes them.
- **Copy link** copies the page's address to paste anywhere.
- Subpages inherit access from their parent; the dialog shows where someone's access comes from.

Anyone who can edit a page can share it. Changing general access and removing people is for the page's creator and workspace owners. Admins can limit who may invite people from outside the server (Server admin → Server).

## Contacts

Your account menu → **Contacts** lists the people suggested when you share. People you share with are added automatically. To bring in your whole address book, export it and import the file:

- **Gmail**: [Google Contacts](https://contacts.google.com) → **Export** → **Google CSV**
- **Outlook**: People → **Manage contacts** → **Export contacts** (CSV)
- **Apple Contacts / others**: export a **vCard** (`.vcf`)

Imported contacts are private to you.

## Move pages between workspaces

Use a page's `•••` menu → **Move to…** to move it (and its subpages) to another workspace or to your private space — for example, to share a private draft with the team. History and comments move with it.

## Edit together

Open the same page as a teammate and you'll see their avatar at the top and their named cursor as they type. Changes merge automatically, even if your connection drops for a moment — the status shows **Live**, **Connecting…** or **Offline**.

## Comments and mentions

Select text and click **Comment** (`Ctrl Alt M`). Type `@` to mention someone — they get a notification. Reply, **resolve** threads when done, and switch between open and resolved comments in the comments panel.

## Inbox

Mentions, replies, pages shared with you and workspaces you're added to arrive in **Inbox** with a badge. Click one to jump straight to the comment.

## Version history

Click the clock icon. A version is saved automatically every 10 minutes while people edit, and you can **Save a named version** any time. Click a version to preview it and **Restore** it — the current text is saved as a version first, so nothing is lost.

## Trash

Deleted team pages go to the workspace **Trash** (workspace `•••` menu), where anyone with edit access can restore them.

## AI

If the server admin has turned AI on, everyone can use the [AI assistant](ai.md) without their own key.
