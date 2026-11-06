# Telegram Bot Setup Guide

The Telegram Integration allows you to monitor and control your OpenCode sessions, run prompts, receive live progress updates, answer questions, and approve command permissions directly from your phone.

---

## 🛠️ Step-by-Step Configuration

### 1. Create Your Telegram Bot
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start a conversation and send the `/newbot` command.
3. Follow the instructions to give your bot a name and a username.
4. Copy the **API Token** provided (e.g., `1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ`).

### 2. Get Your Telegram User ID
For security, only authorized users can interact with your OpenCode sessions.
1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram.
2. Send any message to get your unique numeric **ID** (e.g., `987654321`).

### 3. Create the Configuration File
Create a JSON file named `telegram.json` in your local OpenCode configuration directory:

* **macOS / Linux:** `~/.config/opencode/telegram.json`
* **Windows:** `%USERPROFILE%\.config\opencode\telegram.json`

Add the following content (replace with your token and user ID):

```json
{
  "token": "YOUR_TELEGRAM_BOT_TOKEN",
  "allowedUsers": [
    987654321
  ]
}
```

> [!NOTE]
> After creating or modifying `telegram.json`, run `/reload` in the OpenCode TUI to reinitialize the plugin and read the configuration. Resolve pending questions or permission requests first; a full reload can cancel them.

> [!IMPORTANT]
> Keep your bot token secure. Anyone with your token can access your bot, but the `allowedUsers` whitelist ensures only *you* can send commands to your OpenCode daemon.

---

## 🚀 How It Works

Once configured, the plugin automatically spawns the Telegram bot in the background when you start OpenCode. 

* **Leader Lock:** If you have multiple TUI windows open, only one window (the "leader") runs the Telegram bot listener to avoid API polling conflicts.
* **Session-ID Routing:** Telegram selects its own target session and sends prompts directly through the connected OpenCode server. Selecting or messaging session B does not navigate a terminal displaying A; a terminal already showing B receives its normal session updates.
* **Status Cache:** All logs and temporary synchronization data are safely stored in `~/.cache/opencode-session-tracker/`.

## Selecting a Session

Choose a project with `/projects`, then use `/sessions` to select an existing session or **New Session**. The first time you use this version, select the Telegram target again: the old terminal-derived selection is intentionally not reused. Without an explicit selection, the bot asks you to choose instead of guessing which tab you meant.

Telegram selection does not change Windows Terminal focus, tab titles or the conversation displayed in any terminal. Terminal sidebar clicks still navigate that terminal normally. Replying to a Telegram message sends that interaction to the message's bound session without changing your default Telegram target.

A session does not need to be displayed in a terminal to receive a prompt, but it must be reachable on the bot's connected OpenCode server. If delivery fails, the bot reports the error; it does not switch a terminal or fall back to another session.

## Permission Reminders

The plugin does not change OpenCode's permission policy or autoaccept setting. It waits one second before checking whether a permission request is still pending on the server. Requests already resolved are not forwarded. Multiple pending requests for one session share a Telegram message, with separate approval buttons for each request. Each message shows up to 20 requests; additional requests stay queued and appear as the visible ones are resolved. When a request is resolved, its buttons are removed.

If the pending-state check fails, the plugin keeps retrying and shows a grouped status-check warning instead of assuming that permission is required or that the request has disappeared. There is still a small race between checking a request and sending a Telegram message; a later resolution clears obsolete buttons.

## Reading Session Progress

Use `/tail` for the selected session, or `/tail <sessionId>` for a specific session. The live message shows assistant prose and a brief activity status. Tool arguments, raw outputs and reasoning are not included. Existing prose stays visible while tools run; a new user turn starts a fresh prose view. Questions and permission requests still arrive as separate interactive messages.

Long prose is shortened to fit Telegram's message limit and marked as truncated. This is a filtered view of what the assistant wrote, not an AI-generated summary of tool activity.
