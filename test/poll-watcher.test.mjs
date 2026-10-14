import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPollWatcher } from '../surface/poll-watcher.mjs';
import { getHarness } from '../hooks/registry.mjs';
import { createPulseEmitter } from '../surface/pulse-emitter.mjs';
import { createActiveState } from '../surface/active-state.mjs';
import { processWatchFilename } from '../surface/watch-handlers.mjs';

test('Codex polling detects appended and newly created rollouts without native notifications', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaaro-watch-'));
  const dir = path.join(root, 'sessions/2026/10/14');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'rollout-test-01a025b4-1087-7bc1-aabc-47bf2806b894.jsonl';
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}\n');
  const seen = [];
  const watcher = createPollWatcher({ root, matchLogFile: getHarness('codex').watch.matchLogFile,
    onChange: rel => seen.push(rel), intervalMs: 60_000 });
  try {
    watcher.scan();
    assert.deepEqual(seen, [], 'existing history is not replayed on startup');
    fs.appendFileSync(file, '{}\n');
    watcher.scan();
    assert.deepEqual(seen, [path.relative(root, file)]);
    watcher.scan();
    assert.equal(seen.length, 1, 'unchanged files do not emit again');
    const next = path.join(dir, name.replace('01a025b4', '01a025b5'));
    fs.writeFileSync(next, '{}\n');
    watcher.scan();
    assert.equal(seen.at(-1), path.relative(root, next));
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), '{}\n');
    watcher.scan();
    assert.equal(seen.length, 2, 'unrelated metadata does not emit rollout changes');
  } finally {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missed native Codex updates reach SSE as live pulses without replaying history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaaro-watch-sse-'));
  const dir = path.join(root, 'sessions/2026/10/14');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-test-01a025b4-1087-7bc1-aabc-47bf2806b894.jsonl');
  const record = text => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(),
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  fs.writeFileSync(file, record('Old history'));
  const events = [];
  const emitter = createPulseEmitter({ activeState: createActiveState(),
    hub: { notify: (event, data) => events.push({ event, data: JSON.parse(data) }) } });
  const watcher = createPollWatcher({ root, intervalMs: 60_000,
    matchLogFile: getHarness('codex').watch.matchLogFile,
    onInitial: rel => emitter.primeFile(path.join(root, rel)),
    onChange: rel => {
      const change = processWatchFilename('codex', rel, root);
      emitter.tailAndPulse(change.absPath, change.ctx);
    } });
  try {
    fs.appendFileSync(file, record('Fresh live Codex response'));
    watcher.scan();
    const words = events.filter(e => e.event === 'words');
    assert.equal(words.length, 1);
    assert.equal(words[0].data.preview, 'Fresh live Codex response');
    assert.equal(words[0].data.harness, 'codex');
    assert.equal(words[0].data.session_id, '01a025b4-1087-7bc1-aabc-47bf2806b894');
    watcher.scan();
    assert.equal(events.filter(e => e.event === 'words').length, 1);
  } finally {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
