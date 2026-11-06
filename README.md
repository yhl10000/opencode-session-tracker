

<div align="center">

# OpenCode Session Tracker

[![npm version](https://img.shields.io/npm/v/opencode-session-tracker.svg?style=flat-square)](https://www.npmjs.com/package/opencode-session-tracker)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-tracker.svg?style=flat-square)](https://www.npmjs.com/package/opencode-session-tracker)
[![GitHub stars](https://img.shields.io/github/stars/ykocaman/opencode-session-tracker?style=flat-square)](https://github.com/ykocaman/opencode-session-tracker/stargazers)

<a href="https://www.producthunt.com/products/opencode-session-tracker?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-opencode-session-tracker" target="_blank" rel="noopener noreferrer"><img alt="OpenCode Session Tracker - OpenCode TUI plugin &amp; Telegram Integration | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1210209&theme=light&t=1785440891271"></a>

</div>

One session tracker for [OpenCode](https://github.com/sst/opencode), two surfaces: a **TUI sidebar** in your terminal and a **Telegram remote control** on your phone. Both show the same sessions and live status, while Telegram's selected target stays independent of the conversation open in each terminal.

<p align="center">
  <img src="docs/tui1.png" width="400" alt="OpenCode Session Tracker Sidebar" />
</p>

---

## What you get

* **One session list, everywhere.** Sessions and subagents are tracked in real time and shown identically in the sidebar and in Telegram's `/sessions` and `/history`. Active and archived sessions are always bucketed the same way on both sides.
* **Session hierarchies.** Subagents nest under their parent session like folders. Toggle `[+]`/`[-]` to expand or collapse; active subagents pop out automatically even while their parent is collapsed.
* **Live status everywhere.** The same status — running, waiting, idle, asking a question, waiting on a permission — is reflected as a colored tag in the sidebar and as a live-updating message in Telegram.
* **Remote control from your phone.** Send prompts, follow your agent's updates and answers, and respond to pending permission requests and interactive questions — all via Telegram buttons, without touching your keyboard.
* **Independent remote targeting.** Select a session in Telegram to send prompts or follow replies without switching or focusing any terminal tab, even when several tabs share a directory.
* **Instance management from Telegram.** List running projects, launch OpenCode in a project that isn't running, or close/restart the current instance — all from `/projects`.
* **History, your way.** Sessions idle for 24h automatically move to History. Don't want to wait? Cmd+click (Alt+click on Windows/Linux) a session in the sidebar to archive it to History immediately.

---

## 🖥️ TUI Sidebar

* **Session Hierarchies:** Subagents nest under their parent session like folder trees. Toggle expand/collapse with `[+]` or `[-]`.
* **Smart Active Pop-out:** Collapsing a parent won't hide running work — active subagents pop out automatically.
* **Cmd/Alt+click to archive:** Cmd+click (Alt+click on Windows/Linux) any session to move it into History right away, without waiting for the 24h auto-expiry. (Plain right-click gets intercepted by your terminal's own context menu, and ctrl+click gets remapped to right-click by macOS itself — neither reaches the app reliably.)
* **Visual Status Tags:**
  * `[RUN]` (Green): Agent is actively running a tool or generating code.
  * `[IDLE]` (Gray): Agent completed its task and is idle.
  * `[WAIT]` (Yellow): Agent is waiting or retrying an internal process.
  * `[ASK]` (Magenta): Agent is waiting for you to answer a question.
  * `[PERM]` (Magenta): Agent is waiting for permission to execute a command.

---

## 📱 Telegram Remote Control

<p align="center">
  <img src="docs/telegram-projects.png" alt="Telegram Projects & Sessions Selection" />
  Projects & sessions — select an active session to monitor or interact with.</p>

<br>

<p align="center">
  <img src="docs/telegram-prompt.png" alt="Telegram Live Prompt Tracking" />
Live prompt tracking — follow assistant updates and session status, with buttons to approve or deny pending requests.</p>

* **Prose-First Tail:** `/tail [sessionId]` keeps assistant updates and answers visible, with a brief activity status instead of reasoning or tool-call logs. No extra model calls are needed.
* **Pending-Only Approvals:** Permission reminders are checked against the server after a short grace period. Automatically resolved requests stay silent; pending requests are grouped by session with individual approval buttons.
* **Interactive Questions:** Answer questions directly via Telegram buttons, independently of `/tail`.
* **Session & History Browsing:** `/sessions` lists everything currently active; `/history` lists everything archived — exactly matching what the sidebar shows.
* **Project Control:** `/projects` lists every known OpenCode project, shows which are online, and lets you launch, close, or restart an instance remotely.
* **Session-ID Routing:** Prompts go directly to the selected session on the shared OpenCode server. Each terminal keeps its own current conversation and focus.
* **Zero Overhead:** Idle-state polling is fully cached and throttled to respect Telegram rate limits.

> [!TIP]
> To get started with the mobile control bot, check out the [Telegram Setup Guide](docs/telegram-setup.md).

---

## 📥 Installation

> **OpenCode v2 supported.** Version 2.4.0 and newer require **OpenCode `>=2.0.0`** (tested on 2.0.25). If you are still on OpenCode v1, use version 2.3.x of this plugin instead.

Install using the official OpenCode plugin command:

```bash
opencode plugin add opencode-session-tracker
```

Run `/reload` in OpenCode to load the plugin. After adding a `telegram.json` config, reload the plugin again to enable Telegram control — see the [setup guide](docs/telegram-setup.md).

---

## 🔧 Developer Setup

If you want to customize or develop the plugin locally:

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/ykocaman/opencode-session-tracker.git
   cd opencode-session-tracker
   bun install
   ```
2. Build the plugin:
   ```bash
   bun run build
   ```
3. Load the plugin locally in OpenCode by adding the absolute path of this folder to the `plugins` array in your `~/.config/opencode/cli.json` file:
   ```json
   {
     "plugins": ["/absolute/path/to/opencode-session-tracker"]
   }
   ```
