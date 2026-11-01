import fs from 'node:fs';
import path from 'node:path';

// Native recursive watchers can miss appends; compare file signatures as a fallback.
export function createPollWatcher({ root, matchLogFile, onChange, onInitial = () => {}, intervalMs = 1000 }) {
  let previous = new Map();
  let initialized = false;
  function scan() {
    const next = new Map();
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(file); continue; }
        const rel = path.relative(root, file);
        if (!entry.isFile() || !matchLogFile(rel)) continue;
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        next.set(rel, signature);
        if (!initialized) onInitial(rel);
        if (initialized && previous.get(rel) !== signature) onChange(rel);
      }
    }
    previous = next;
    initialized = true;
  }
  scan();
  const timer = setInterval(scan, intervalMs);
  timer.unref?.();
  return { scan, close: () => clearInterval(timer) };
}
