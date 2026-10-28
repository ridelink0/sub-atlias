// Read-only allowance snapshots. No credentials, network calls or invented quotas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABELS = { 'claude-plan': 'Claude plan', claude: 'Claude Code', codex: 'Codex', chatgpt: 'ChatGPT plan', responses: 'OpenAI API', anthropic: 'Anthropic API', gemini: 'Gemini API', openai: 'Custom API', ollama: 'Ollama' };
const read = file => { try { if (fs.statSync(file).size > 2 * 1024 * 1024) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

export function accountUsage({ connected = {}, active, state = {}, home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const native = read(env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(home, '.claude.json'))?.cachedUsageUtilization;
  const live = read(path.join(claudeDir, 'usage-limits-live.json'));
  const codex = read(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'usage-limits-codex-live.json'));
  const engines = Object.keys(LABELS).filter(e => connected[e] || active === e);
  return engines.map(engine => {
    let windows = [], at = null, source = '';
    if (engine === 'claude-plan' || engine === 'claude') {
      const snapshot = live?.utilization && Number(live.fetchedAtMs) > Number(native?.fetchedAtMs || 0) ? live : native;
      at = snapshot?.fetchedAtMs; source = snapshot === live ? 'Usage Limits cache' : 'Claude cache';
      windows = [['5h', snapshot?.utilization?.five_hour], ['week', snapshot?.utilization?.seven_day]].flatMap(([label, w]) => percent(w?.utilization) ? [{ label, used: w.utilization, resetsAt: Date.parse(w.resets_at) }] : []);
    } else if (engine === 'codex') {
      at = codex?.at; source = 'Codex cache';
      const limits = codex?.meter;
      windows = [['5h', limits?.primary], ['week', limits?.secondary]].flatMap(([label, w]) => percent(w?.used_percent) ? [{ label, used: w.used_percent, resetsAt: w.resets_at * 1000 }] : []);
    }
    const stale = !Number.isFinite(at) || now - at > 15 * 60000 || at > now + 60000;
    windows = windows.map(w => ({ ...w, expired: Number.isFinite(w.resetsAt) && w.resetsAt <= now }));
    let detail;
    if (windows.length) detail = windows.map(w => w.expired ? `${w.label} refresh needed` : `${w.label} ${Math.round(w.used)}% used`).join(' / ') + (stale ? ' (stale)' : ' (cached)');
    else if (engine === 'ollama') detail = 'local; no plan allowance';
    else if (['chatgpt', 'claude-plan', 'claude', 'codex'].includes(engine)) detail = 'allowance not reported';
    else detail = 'API allowance not reported';
    const p = state.engine === engine && Array.isArray(state.promptLog) ? state.promptLog : [];
    const o = state.engine === engine && Array.isArray(state.outLog) ? state.outLog : [];
    if (p.length || o.length) {
      const all = [...p, ...o];
      if (all.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) detail += `; ${all.reduce((a, b) => a + b, 0).toLocaleString('en-US')} session tokens`;
    }
    return { engine, label: LABELS[engine], windows, stale, source, text: `${LABELS[engine]}: ${detail}` };
  });
}
