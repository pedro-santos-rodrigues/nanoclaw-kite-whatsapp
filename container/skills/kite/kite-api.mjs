#!/usr/bin/env node

/**
 * Kite API helper for NanoClaw container agents.
 * Zero dependencies — uses Node 22 built-in fetch.
 *
 * Usage:
 *   node kite-api.mjs list-sites
 *   node kite-api.mjs send-message '{"application_id":"...","thread_id":"...","user_message":"..."}'
 *   node kite-api.mjs poll-response '{"thread_id":"...","after":"2026-03-11T10:00:00Z"}'
 *   node kite-api.mjs create-site
 *   node kite-api.mjs select-iteration '{"application_id":"...","iteration":"iter1"}'
 */

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = '/workspace/group/kite-config.json';
const IPC_CONTEXT_PATH = '/workspace/ipc/context.json';
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const ACTIVE_SITE_PATH = '/tmp/kite-active-site.json';
const BASE_URL = 'https://kite.appsmith.com/api/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;
const STATUS_THROTTLE_MS = 8000;

// Design generation can take 5–10 minutes. When we detect this is a
// design-generation poll (application_id is available), extend the
// timeout and use a gentler poll interval after the initial 2 minutes.
const DESIGN_POLL_TIMEOUT_MS = 600000;
const DESIGN_POLL_INTERVAL_MS = 10000;

function loadSession() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(JSON.stringify({
      error: 'kite-config.json not found',
      hint: 'Create /workspace/group/kite-config.json with {"session": "<your v2_session cookie value>"}',
    }));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  if (!config.session) {
    console.error(JSON.stringify({ error: 'No "session" field in kite-config.json' }));
    process.exit(1);
  }
  return config.session;
}

async function api(method, apiPath, body) {
  const session = loadSession();
  const opts = {
    method,
    headers: {
      Cookie: `v2_session=${session}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${apiPath}`, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(JSON.stringify({ error: `HTTP ${res.status}`, body: text.slice(0, 500) }));
    process.exit(1);
  }

  return res.json();
}

// Like api() but throws on error instead of process.exit(1).
// Used during extended polling where transient errors should be retried.
async function apiSafe(method, apiPath, body) {
  const session = loadSession();
  const opts = {
    method,
    headers: {
      Cookie: `v2_session=${session}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${apiPath}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadIpcContext() {
  try {
    return JSON.parse(fs.readFileSync(IPC_CONTEXT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveActiveSite(applicationId, threadId) {
  try {
    fs.writeFileSync(ACTIVE_SITE_PATH, JSON.stringify({ application_id: applicationId, thread_id: threadId }));
  } catch { /* best-effort */ }
}

function loadActiveSite() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_SITE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function sendIpcStatus(chatJid, text) {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filename = `kite-status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const tempPath = path.join(IPC_MESSAGES_DIR, `${filename}.tmp`);
    const finalPath = path.join(IPC_MESSAGES_DIR, filename);
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', chatJid, text }));
    fs.renameSync(tempPath, finalPath);
  } catch { /* best-effort */ }
}

// ── Commands ────────────────────────────────────────────────────

async function listSites() {
  const data = await api('GET', '/applications');
  console.log(JSON.stringify(data, null, 2));
}

async function sendMessage(argsJson) {
  const { application_id, thread_id, user_message } = JSON.parse(argsJson);
  if (!application_id || !thread_id || !user_message) {
    console.error(JSON.stringify({ error: 'Required: application_id, thread_id, user_message' }));
    process.exit(1);
  }
  saveActiveSite(application_id, thread_id);
  const data = await api('POST', '/chat/message', {
    application_id,
    thread_id,
    user_message,
    should_save_message: true,
  });
  console.log(JSON.stringify(data, null, 2));
}

function findLatestOrchestratorReply(allMessages) {
  const lastUserIdx = allMessages.findLastIndex(
    (m) => m.type === 'conversation-update' && m.role === 'user',
  );
  const searchFrom = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const candidates = allMessages.slice(searchFrom).filter(
    (m) =>
      m.type === 'conversation-update' &&
      m.role !== 'user' &&
      m.message && m.message.trim(),
  );
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

async function pollResponse(argsJson) {
  const { thread_id, after, application_id } = JSON.parse(argsJson);
  if (!thread_id || !after) {
    console.error(JSON.stringify({ error: 'Required: thread_id, after (ISO timestamp)' }));
    process.exit(1);
  }

  const ctx = loadIpcContext();
  const chatJid = ctx?.chatJid;
  const afterDate = new Date(after);

  // When application_id is known (explicit or from last send-message),
  // this is likely a design generation poll — allow up to 10 minutes.
  const resolvedAppId = application_id || loadActiveSite()?.application_id;
  const timeout = resolvedAppId ? DESIGN_POLL_TIMEOUT_MS : POLL_TIMEOUT_MS;

  let elapsed = 0;
  const seenNotifications = new Set();
  let lastStatusAt = 0;

  while (elapsed < timeout) {
    const inExtendedPhase = resolvedAppId && elapsed >= POLL_TIMEOUT_MS;

    let allMessages;
    try {
      // During extended phase, use apiSafe to tolerate transient errors
      const data = inExtendedPhase
        ? await apiSafe('GET', `/threads/${thread_id}/messages`)
        : await api('GET', `/threads/${thread_id}/messages`);
      allMessages = Array.isArray(data) ? data : (data.messages || []);
    } catch {
      // Transient error during extended polling — retry on next interval
      await sleep(DESIGN_POLL_INTERVAL_MS);
      elapsed += DESIGN_POLL_INTERVAL_MS;
      continue;
    }

    // Primary: strict timestamp filter
    const candidates = allMessages.filter(
      (m) =>
        m.type === 'conversation-update' &&
        m.role !== 'user' &&
        new Date(m.created_at) > afterDate &&
        m.message && m.message.trim(),
    );

    if (candidates.length > 0) {
      const latest = candidates[candidates.length - 1];
      console.log(JSON.stringify(latest, null, 2));
      return;
    }

    // Fallback: if a user_action_required or iteration_complete exists after our
    // timestamp, the orchestrator already finished but the conversation-update
    // may have landed before our `after` due to clock skew / agent delay.
    // Return the latest orchestrator reply after the last user message instead.
    const hasDesignReady = allMessages.some(
      (m) =>
        (m.type === 'user_action_required' || m.type === 'iteration_complete') &&
        new Date(m.created_at) > new Date(afterDate.getTime() - 10 * 60 * 1000),
    );
    if (hasDesignReady) {
      const fallback = findLatestOrchestratorReply(allMessages);
      if (fallback) {
        console.log(JSON.stringify(fallback, null, 2));
        return;
      }
    }

    // Relay in-progress notifications as WhatsApp status updates
    if (chatJid) {
      const now = Date.now();
      const newNotifications = allMessages.filter(
        (m) =>
          m.type === 'notification' &&
          m.status === 'in_progress' &&
          !seenNotifications.has(m.id),
      );
      for (const n of newNotifications) seenNotifications.add(n.id);

      if (newNotifications.length > 0 && now - lastStatusAt >= STATUS_THROTTLE_MS) {
        const latest = newNotifications[newNotifications.length - 1];
        const label = latest.title || latest.action || 'Working';
        sendIpcStatus(chatJid, `⏳ ${label}...`);
        lastStatusAt = now;
      }
    }

    const interval = inExtendedPhase ? DESIGN_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    await sleep(interval);
    elapsed += interval;
  }

  console.error(JSON.stringify({ error: `Polling timed out after ${Math.round(timeout / 1000)} seconds` }));
  process.exit(1);
}

async function createSite() {
  const data = await api('POST', '/applications/with-thread', {});
  console.log(JSON.stringify(data, null, 2));
}

async function selectIteration(argsJson) {
  const { application_id, iteration } = JSON.parse(argsJson);
  if (!application_id || !iteration) {
    console.error(JSON.stringify({ error: 'Required: application_id, iteration (e.g. iter1)' }));
    process.exit(1);
  }
  const data = await api(
    'POST',
    `/applications/${application_id}/iterations/select`,
    { selected_iteration: iteration },
  );
  console.log(JSON.stringify(data, null, 2));
}

// ── Main ────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'list-sites':
    await listSites();
    break;
  case 'send-message':
    await sendMessage(rest[0]);
    break;
  case 'poll-response':
    await pollResponse(rest[0]);
    break;
  case 'create-site':
    await createSite();
    break;
  case 'select-iteration':
    await selectIteration(rest[0]);
    break;
  default:
    console.error(
      'Usage: kite-api.mjs <command> [args]\n' +
        'Commands: list-sites, send-message, poll-response, create-site, select-iteration',
    );
    process.exit(1);
}
