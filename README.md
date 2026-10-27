# hermes-grok-bridge

A small stdio MCP server that turns a Grok Bot chat into a thin window into your real Hermes agent.

- Messages you type in the Grok chat go into your Hermes default bot's **Bot Chat**, the same thread the Hermes desktop app opens from the bot row. History is shared, so you can switch between the desktop app and Grok and see the same conversation.
- Hermes's replies come back verbatim. The Grok bot adds no personality of its own.
- Other Grok bots can message the Hermes chat like any teammate, and it goes to Hermes as-is.
- Hermes can message Grok first by calling a Grok routine webhook.

It uses the Hermes gateway API server (`API_SERVER_ENABLED=true`, port 8642 by default). No Node dependencies beyond Node 20+.

## How it reaches Bot Chat

The Hermes API server can only run turns in sessions it created. Bot Chat is the exception: `POST /api/sessions/{id}/chat` is the door `hermes peer dm` uses. If the desktop app has Bot Chat open, Hermes drops the message into the open chat and waits up to 300 s for the reply. If the turn takes longer, it answers `202 queued` and the reply lands in the chat later.

## Install from a Grok Bot

You can ask a Grok Bot to install this on its own computer:

1. Clone the repo: `git clone https://github.com/mpotter2002/hermes-grok-bridge ~/hermes-grok-bridge`
2. Save the Hermes `API_SERVER_KEY` to `~/.hermes/api_server_key` and `chmod 600` it. The bot should ask for the key through a secret request, not have you paste it into chat.
3. Register a stdio MCP server named `hermes`:
   - command: `node`
   - args: `["/absolute/path/to/hermes-grok-bridge/server.mjs"]` (expand `~` to the real home directory)
   - env: `HERMES_BASE_URL=http://<hermes-host>:8642`
4. Restart MCP servers (`RestartMcpServers`), then call the `hermes` server's `health` tool.

The tool list Grok shows may stay stale for a while after install or upgrade; calls to the new tools still work.

## Setup

1. **Install.** Copy this folder somewhere on the machine that runs Grok Bot's MCP servers. `npm install` (nothing to fetch, but it validates the package).

2. **Add the MCP server in Grok Bot.** Name it `hermes`. Command: `node /path/to/hermes-grok-bridge/server.mjs`. Env:
   - `HERMES_BASE_URL=http://<hermes-host>:8642` (required; a Tailscale or LAN address works)
   - `HERMES_API_KEY_FILE=~/.hermes/api_server_key` (or `HERMES_API_KEY=...`)
   - optional: `HERMES_BRIDGE_TZ=America/New_York` for displayed times

3. **Put the API key in place.** It is `API_SERVER_KEY` from the Hermes profile's `.env`. Save it to the key file with `chmod 600`. Don't paste it into a chat.

4. **Find your Bot Chat id.** Bot Chat is hidden from normal session lists:
   ```
   curl -H "Authorization: Bearer $KEY" \
     "http://<hermes-host>:8642/api/sessions?title=Bot%20Chat&include_hidden=true"
   ```

5. **Configure.** Copy `bridge.example.json` to `~/.hermes/bridge.json` and set `default_session_id` to that id. Or call the `set_default_session` tool. The file holds no secrets.

6. **Create the Grok bot** (from the template). Its job: pass each message to `hermes.send` and show the reply verbatim; show `read_session` output when asked what's new.

7. **Let Hermes reach Grok first.** On the Grok bot, create a routine with a webhook trigger. Give Hermes the webhook URL and key by putting them in a file on the Hermes host (for example `~/.hermes/grok_webhook`, `chmod 600`) and telling Hermes where it is. Keep the key out of Hermes's memory and out of chat history where you can.

8. **Test both ways.** Send "reply 'got it' only" from the Grok chat and check it shows in the desktop app's Bot Chat. Then ask Hermes to ping the Grok webhook and check the Grok chat gets it.

## Tools

| Tool | Args | What it does |
| --- | --- | --- |
| `send` | `message`, `session_id?`, `wait_sec?`, `instructions?`, `author?`, `profile?` | Bot Chat: returns `{status:"completed", reply}` or `{status:"queued", delivery_id}`. API sessions: background run. |
| `check_reply` | `delivery_id?` or `since?`, `session_id?`, `profile?` | New messages and replies since a queued send. |
| `read_session` | `session_id?`, `last?`, `since?`, `full?`, `profile?` | Messages oldest-first with times and a `from` label (`owner`, `hermes`, `bot:<name>`, `peer/external`, `system:*`). |
| `list_sessions` | `profile?`, `source?`, `limit?`, `offset?`, `include_cron?` | Recent sessions. |
| `set_default_session` | `session_id?`, `transport?`, `profile?` | Saves the default to the config. |
| `create_session` | `title?`, `make_default?`, `profile?` | New API-owned session. |
| `run_status` / `steer` / `stop` | `run_id`, ... | Control background runs in API-owned sessions. |
| `respond_approval` | `run_id`, `choice`, `request_id?` | Answer a run's pending tool approval. |
| `health` / `capabilities` | `profile?` | Liveness and what the API server supports. |
| `ask` | `prompt`, `timeout_sec?`, `session_id?` | Old one-shot call; kept for compatibility. |

## Gotchas

- **Never resend after `202 queued` or a client timeout.** The message is already in the chat and will run. Resending runs it twice. Use `check_reply`.
- **`ask` opens a new session each time** unless you pass `session_id`. Use `send` for the shared thread.
- **After upgrading, Grok's tool list can stay stale** in an open chat. Calls to the new tools still work; a new chat or connector restart refreshes the list.
- **One Grok bot per Hermes profile.** Named profiles are reached at `/p/<profile>/` and need that profile's own `API_SERVER_KEY` (the default key gets 401) plus its own Bot Chat id. Put keys in `~/.hermes/profile_keys/<name>` or `HERMES_PROFILE_KEY_<NAME>`.
- **Desktop-app sessions other than Bot Chat** are refused by the API (409 `permission_denied`). Reaching them would need the dashboard WebSocket, which this bridge doesn't implement yet.
- **Hermes memory:** test prompts like "remember X" will write to the profile's real memory. Say "don't save to memory" in tests.

## License

MIT
