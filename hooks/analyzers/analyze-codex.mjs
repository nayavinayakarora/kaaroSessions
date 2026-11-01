#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { deriveLabel } from '../helpers/analyze-helpers.mjs';
import { parseJsonlFile } from '../jsonl-io.mjs';
import { buildSessionsOutput } from '../../surface/analyze-orchestrator.mjs';
import { recordsToNormalized } from '../adapters/codex.mjs';
import { reduceSession } from '../session-reducer.mjs';
import { enrichSession } from '../enrich-session.mjs';
import { walkSessions, dirNames } from '../scan-walk.mjs';
import { CODEX_HOME_ROOT } from '../harness-paths.mjs';

const OUT_FILE = path.join(process.cwd(), 'sessions-data.json');

function sessionIdFromFilename(file) {
  const base = path.basename(file, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : base.replace(/^rollout-[^-]+-/, '');
}

function slugFromTitle(title, fallback) {
  return String(title || fallback || 'codex')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'codex';
}

function projectFromRecords(records) {
  const meta = records.find(r => r.type === 'session_meta')?.payload || {};
  const ctx = records.find(r => r.type === 'turn_context')?.payload || {};
  const cwd = meta.cwd || ctx.cwd || 'codex';
  const projectId = cwd.replace(/\\/g, '/').replace(/^\/Users\/[^/]+\//, 'Users--').replace(/[/:]+/g, '-');
  return {
    cwd,
    project_id: projectId,
    project_label: deriveLabel(path.basename(cwd) || 'codex'),
  };
}

export function readCodexSessionIndex(indexPath = path.join(CODEX_HOME_ROOT, 'session_index.jsonl')) {
  const out = {};
  let parsed;
  try {
    parsed = parseJsonlFile(indexPath).records;
  } catch {
    return out;
  }
  for (const rec of parsed) {
    if (!rec?.id) continue;
    const prev = out[rec.id];
    if (!prev || String(rec.updated_at || '') >= String(prev.updated_at || '')) out[rec.id] = rec;
  }
  return out;
}

export function analyzeCodexSession(filePath, opts = {}) {
  const { records, sizeBytes } = parseJsonlFile(filePath);
  const sessionId = sessionIdFromFilename(filePath);
  const project = projectFromRecords(records);
  const session = reduceSession(recordsToNormalized(records), {
    session_id: sessionId,
    project_id: project.project_id,
    project_label: project.project_label,
    harness: 'codex',
    file_size_bytes: sizeBytes,
    capabilities: { size_proxy: 'tokens_work' },
  });

  session.file_size_bytes = sizeBytes;
  session.source = 'codex';
  session.cwd ||= project.cwd;
  const title = opts.titleIndex?.[sessionId]?.thread_name;
  if (title) session.ai_title = title;
  enrichSession(session);
  return session;
}

function* rolloutFiles(root) {
  const sessionsRoot = path.join(root, 'sessions');
  const years = fs.existsSync(sessionsRoot)
    ? fs.readdirSync(sessionsRoot, { withFileTypes: true })
    : [];
  for (const year of dirNames(years)) {
    const yearDir = path.join(sessionsRoot, year);
    for (const month of dirNames(fs.readdirSync(yearDir, { withFileTypes: true }))) {
      const monthDir = path.join(yearDir, month);
      for (const day of dirNames(fs.readdirSync(monthDir, { withFileTypes: true }))) {
        const dayDir = path.join(monthDir, day);
        for (const file of fs.readdirSync(dayDir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).sort()) {
          yield path.join(dayDir, file);
        }
      }
    }
  }

  const archivedRoot = path.join(root, 'archived_sessions');
  if (fs.existsSync(archivedRoot)) {
    for (const file of fs.readdirSync(archivedRoot).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).sort()) {
      yield path.join(archivedRoot, file);
    }
  }
}

function codexMetadataSession(rec) {
  const title = rec.thread_name || rec.id;
  const projectSlug = slugFromTitle(title, rec.id);
  const session = {
    session_id: rec.id,
    project_id: `codex-index-${projectSlug}`,
    project_label: title,
    harness: 'codex',
    source: 'codex',
    ai_title: title,
    slug: rec.id.slice(0, 8),
    first_timestamp: rec.updated_at || null,
    last_timestamp: rec.updated_at || null,
    duration_ms: 0,
    tokens: { input: 0, cache_create: 0, cache_read: 0, output: 0 },
    tools: {},
    file_ops: {},
    skills: [],
    builtin_commands: [],
    bash_categories: {},
    content_blocks: {},
    stop_reasons: {},
    branches: [],
    skill_timeline: [],
    skill_attribution: {},
    tool_calls: 0,
    tool_errors: 0,
    message_count: 0,
    user_turns: 0,
    assistant_turns: 0,
    context_resets: 0,
    subagent_count: 0,
    file_size_bytes: 0,
    metadata_only: true,
  };
  enrichSession(session);
  return session;
}

export function scanCodexSessions(root = CODEX_HOME_ROOT) {
  const titleIndex = readCodexSessionIndex(path.join(root, 'session_index.jsonl'));
  const seenSessionIds = new Set();
  return walkSessions(root, 'codex', function* () {
    for (const filePath of rolloutFiles(root)) {
      yield {
        id: path.relative(root, filePath),
        analyze: () => {
          const session = analyzeCodexSession(filePath, { root, titleIndex });
          seenSessionIds.add(session.session_id);
          return session;
        },
      };
    }

    const indexed = Object.values(titleIndex)
      .sort((a, b) => String(a.updated_at || '') < String(b.updated_at || '') ? -1 : 1);
    for (const rec of indexed) {
      if (!rec?.id || seenSessionIds.has(rec.id)) continue;
      yield {
        id: `session_index.jsonl:${rec.id}`,
        analyze: () => {
          if (seenSessionIds.has(rec.id)) return null;
          seenSessionIds.add(rec.id);
          return codexMetadataSession(rec);
        },
      };
    }
  });
}

export { CODEX_HOME_ROOT, sessionIdFromFilename };

function main() {
  console.log('Scanning', CODEX_HOME_ROOT, '...');
  const result = scanCodexSessions();
  if (!result) {
    console.error(`Codex home directory not found: ${CODEX_HOME_ROOT}`);
    process.exit(1);
  }

  const output = buildSessionsOutput([result]);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  const t = output.rollup.tokens;
  const total = t.input + t.cache_create + t.cache_read + t.output;
  console.log(`\nSessions: ${output.sessions.length}  Projects: ${output.projects.length}  Tokens: ${total.toLocaleString()}`);
  console.log(`Output: ${OUT_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
