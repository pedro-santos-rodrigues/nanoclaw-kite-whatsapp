---
name: kite
description: Manage websites via the Kite API — list sites, edit content, create new sites, publish. Use when the user mentions their website, site, pages, publishing, or wants to build a new site.
allowed-tools: Bash(node /home/node/.claude/skills/kite/*)
---

# Kite Website Manager

Manage all of the user's websites through the Kite API. The helper script at `/home/node/.claude/skills/kite/kite-api.mjs` handles authentication and HTTP calls.

## IMPORTANT: URLs

Always use `staging.kite.ai` for all user-facing links. Never use `kite.ai` directly.

When linking the user to their site in Kite, use this URL format:

```
https://staging.kite.ai/app-details/{application_id}/design
```

Replace `{application_id}` with the actual application ID. Use this link whenever the user needs to view or select designs, preview their site, or interact with Kite visually.

## Authentication

The Kite session cookie is already configured at `/workspace/group/kite-config.json`. Do NOT ask the user for a cookie — just call the API directly. Only if the helper script exits with an error containing "401" or "Unauthorized" should you tell the user their session has expired and ask for a fresh cookie to save with:

```bash
echo '{"session": "PASTE_HERE"}' > /workspace/group/kite-config.json
```

## Helper Script Reference

All commands output JSON to stdout. Errors go to stderr with a non-zero exit code.

```bash
KITE="/home/node/.claude/skills/kite/kite-api.mjs"

# List all sites
node $KITE list-sites

# Send a message to the site's orchestrator
node $KITE send-message '{"application_id":"APP_ID","thread_id":"THREAD_ID","user_message":"change the headline to Welcome"}'

# Poll for the orchestrator's response
# Blocks up to 2 min normally, or up to 10 min for design generation (when application_id is included)
node $KITE poll-response '{"thread_id":"THREAD_ID","after":"2026-03-11T10:00:00.000Z","application_id":"APP_ID"}'

# Create a brand-new site
node $KITE create-site

# Select a design iteration (iter1, iter2, or iter3)
node $KITE select-iteration '{"application_id":"APP_ID","iteration":"iter1"}'
```

## Behaviors

### 1. Site Discovery

When you need to know the user's sites (first interaction, or when asked), call `list-sites` and cache the result in your CLAUDE.md memory under a `## Kite Sites` section. Don't call `list-sites` every message — use the cached version unless the user asks to refresh or you just created/deleted a site.

### 2. Site Selection

- If the user has **one site**, use it automatically.
- If the user has **multiple sites** and the message is ambiguous (e.g. "change the headline"), ask which site they mean.
- If the user mentions a site **by name**, match it from your cached list.
- Store the active site in CLAUDE.md. When the user says "switch to my bakery site", update it.

### 3. Sending Commands to the Orchestrator

When the user wants to change something on their site:

1. **Immediately** send a brief acknowledgement via `mcp__nanoclaw__send_message` so the user knows you're on it (e.g. "Let me check with Kite..." or "Sending that to Kite..."). Keep it honest — don't say "creating" or "done" before the orchestrator has responded.
2. Record the current timestamp **right before** calling send-message (not after — the orchestrator may reply fast).
3. Call `send-message` with the user's instruction forwarded as `user_message`.
4. **Immediately** call `poll-response` with the thread_id, the timestamp from step 2, and `application_id` — do not do any other work between send-message and poll-response.
5. Relay the orchestrator's response to the user naturally.

The orchestrator can take 10–60 seconds for quick edits. For design generation, it can take 5–10 minutes — the polling helper automatically extends its wait time when `application_id` is included. Always include `application_id` in poll-response calls.

If the orchestrator asks a follow-up question, relay it to the user conversationally and wait for their answer before sending the next message.

### 4. Creating New Sites

When the user says something like "create a new website for my food truck" or "build me a site for...":

1. **Immediately** send "Setting things up — Kite will have a few questions for you first!" via `mcp__nanoclaw__send_message`.
2. Call `create-site`. It returns `{application: {id}, thread: {id}}`.
3. Update CLAUDE.md: set this as the active site, add it to the sites list.
4. Forward the user's full description to the orchestrator via `send-message`.
5. Poll for the response with `application_id` included and relay it.
6. The orchestrator will ask follow-up questions about the business (name, style, etc.) — relay them naturally and wait for the user's answers before continuing.
7. When the orchestrator generates design options (3 iterations), present them with the direct Kite link so the user can preview visually:

   ```
   Here are 3 design options for your site! You can preview and pick your favorite here:
   👉 https://staging.kite.ai/app-details/{application_id}/design

   Or just reply with 1, 2, or 3 and I'll select it for you.
   ```

   Always use the URL format from the "IMPORTANT: URLs" section above. If the user replies with a number in chat, call `select-iteration` with `iter1`, `iter2`, or `iter3`.
8. Continue the conversation with the orchestrator for any refinements.

### 5. Publishing

When the user says "publish", "make it live", "deploy", or similar — just forward it to the orchestrator as a normal message via `send-message` + `poll-response`. The orchestrator has its own publish agent that handles Vercel deployment.

### 6. Listing Sites

When the user asks "what sites do I have?" or "show me my websites":

1. Call `list-sites`.
2. Format the response as a clean list:

```
You have 3 sites:
1. Casa da Avó — casadaavo.kite.site (published)
2. Taco Libre — not published yet
3. My Portfolio — myportfolio.kite.site (published)

Which one do you want to work on?
```

3. Update the cached sites in CLAUDE.md.

### 7. Answering From Memory

If the user asks something that doesn't need the orchestrator — like "which site am I on?", "what's the URL for my bakery site?" — answer directly from your CLAUDE.md memory without calling the API.

## Memory Format

Maintain this in your CLAUDE.md file:

```
## Kite Sites

ACTIVE_SITE: <application_id>
ACTIVE_THREAD: <thread_id>

SITES:
- name: Casa da Avó, id: abc-123, thread: def-456, url: casadaavo.kite.site
- name: Taco Libre, id: ghi-789, thread: jkl-012, url: (not published)
```

Update this whenever you fetch the sites list, create a new site, or the user switches sites.
