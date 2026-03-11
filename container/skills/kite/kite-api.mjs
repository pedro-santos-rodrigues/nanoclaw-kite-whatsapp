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

const CONFIG_PATH = '/workspace/group/kite-config.json';
const BASE_URL = 'https://kite.appsmith.com/api/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

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

async function api(method, path, body) {
  const session = loadSession();
  const opts = {
    method,
    headers: {
      Cookie: `v2_session=${session}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(JSON.stringify({ error: `HTTP ${res.status}`, body: text.slice(0, 500) }));
    process.exit(1);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const data = await api('POST', '/chat/message', {
    application_id,
    thread_id,
    user_message,
    should_save_message: true,
  });
  console.log(JSON.stringify(data, null, 2));
}

async function pollResponse(argsJson) {
  const { thread_id, after } = JSON.parse(argsJson);
  if (!thread_id || !after) {
    console.error(JSON.stringify({ error: 'Required: thread_id, after (ISO timestamp)' }));
    process.exit(1);
  }

  const afterDate = new Date(after);
  let elapsed = 0;

  while (elapsed < POLL_TIMEOUT_MS) {
    const messages = await api('GET', `/threads/${thread_id}/messages`);
    const candidates = (Array.isArray(messages) ? messages : [])
      .filter(
        (m) =>
          m.role === 'assistant' &&
          m.status === 'completed' &&
          new Date(m.created_at) > afterDate,
      );

    if (candidates.length > 0) {
      const latest = candidates[candidates.length - 1];
      console.log(JSON.stringify(latest, null, 2));
      return;
    }

    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;
  }

  console.error(JSON.stringify({ error: 'Polling timed out after 120 seconds' }));
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
