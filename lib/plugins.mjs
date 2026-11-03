// Claude Code plugins, read from the files Claude Code itself reads (Gev, 2026-11-03). A plugin is
// mostly files: skills, slash commands and agent definitions are Markdown in its folder, its MCP
// servers are a .mcp.json (or the manifest's mcpServers), its hooks a hooks/hooks.json. Nothing here
// runs Claude Code or copies a plugin: Atlias reads the folder the plugin is installed in.
//
// Which plugins: the ones ~/.claude/plugins/installed_plugins.json records and ~/.claude/settings.json
// enables, the same pair Claude Code consults. Atlias's own plugin (atlias@atlias) is left out: its
// MCP server and hooks are Atlias itself.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, config, readJson, readText } from './core.mjs';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// agent.plugins (on by default): off reads no plugin folder at all.
export function pluginsOn(cfg = config().agent) { return (cfg && cfg.plugins) !== 'off'; }

// [{ key, name, marketplace, root, manifest }] for every enabled plugin, sorted by key so every
// list built from it is the same from one session to the next.
export function enabled({ claudeDir = CLAUDE_DIR, cfg } = {}) {
  if (!pluginsOn(cfg)) return [];
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), null);
  const on = (readJson(path.join(claudeDir, 'settings.json'), null) || {}).enabledPlugins || {};
  const records = installed && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const out = [];
  for (const [key, list] of Object.entries(records)) {
    if (on[key] !== true) continue;
    const [name, marketplace = ''] = key.split('@');
    if (!name || name === 'atlias') continue;
    // Version 2 keeps a list of installs per plugin; the newest install is the one Claude Code loads.
    const rec = (Array.isArray(list) ? list : [list]).filter((r) => r && typeof r.installPath === 'string').sort((a, b) => String(b.lastUpdated || b.installedAt || '').localeCompare(String(a.lastUpdated || a.installedAt || '')))[0];
    if (!rec || !isDir(rec.installPath)) continue;
    const manifest = readJson(path.join(rec.installPath, '.claude-plugin', 'plugin.json'), null) || {};
    out.push({ key, name, marketplace, root: rec.installPath, manifest });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// A manifest may point a part at other folders (a string or a list, relative to the plugin root);
// left out, the part is the folder of that name. A path that leaves the plugin folder is ignored.
function partDirs(plugin, part) {
  const given = plugin.manifest[part];
  const list = typeof given === 'string' ? [given] : Array.isArray(given) ? given.filter((x) => typeof x === 'string') : [part];
  const inside = (p) => { const r = path.relative(plugin.root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  return [...new Set(list.map((p) => path.resolve(plugin.root, p)))].filter((p) => inside(p) && isDir(p));
}

// Skill folders, one root per plugin folder. Claude Code names a plugin's skill plugin:skill, and so does Atlias.
export function skillRoots(opts) {
  return enabled(opts).flatMap((p) => partDirs(p, 'skills').map((dir) => ({ dir, source: 'plugin', prefix: `${p.name}:` })));
}
// Slash command folders, named plugin:command as in Claude Code.
export function commandDirs(opts) {
  return enabled(opts).flatMap((p) => partDirs(p, 'commands').map((dir) => ({ dir, source: 'plugin', prefix: `${p.name}:` })));
}

// The frontmatter between the first two --- lines, top-level keys only (the shape skills.mjs reads).
function front(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    let v = line.slice(at + 1).trim();
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[line.slice(0, at).trim()] = v;
  }
  return out;
}
const bodyOf = (text) => String(text || '').replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim();

// Agent definitions: plugin:name, one line of what each is for, and the file holding its instructions.
export function agents(opts) {
  const out = [];
  for (const p of enabled(opts)) {
    for (const dir of partDirs(p, 'agents')) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort(); } catch { continue; }
      for (const n of names) {
        const file = path.join(dir, n);
        const f = front(readText(file));
        const name = `${p.name}:${String(f.name || n.replace(/\.md$/i, '')).trim()}`;
        out.push({ name, description: String(f.description || '').replace(/\s+/g, ' ').trim(), file });
      }
    }
  }
  return out;
}
// The instructions an agent runs with: its file without the frontmatter, or null when no agent has that name.
export function agentBody(name, opts) {
  const want = String(name || '').trim().toLowerCase();
  const a = agents(opts).find((x) => x.name.toLowerCase() === want) || agents(opts).find((x) => x.name.toLowerCase().endsWith(':' + want));
  if (!a) return null;
  const text = bodyOf(readText(a.file));
  return text ? { ...a, text } : null;
}

// ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA} and ${user_config.x} as Claude Code fills them: the
// option from settings.json pluginConfigs, else the manifest's default, else empty.
export function substitute(value, plugin, { claudeDir = CLAUDE_DIR } = {}) {
  if (typeof value !== 'string') return value;
  const options = (((readJson(path.join(claudeDir, 'settings.json'), null) || {}).pluginConfigs || {})[plugin.key] || {}).options || {};
  const defaults = plugin.manifest.userConfig && typeof plugin.manifest.userConfig === 'object' ? plugin.manifest.userConfig : {};
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.root)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir(plugin, claudeDir))
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (m, k) => {
      const v = Object.hasOwn(options, k) ? options[k] : defaults[k] && Object.hasOwn(defaults[k], 'default') ? defaults[k].default : '';
      return v == null ? '' : String(v);
    });
}
export function dataDir(plugin, claudeDir = CLAUDE_DIR) {
  return path.join(claudeDir, 'plugins', 'data', `${plugin.name}-${plugin.marketplace || plugin.name}`.replace(/[^A-Za-z0-9_.-]/g, '-'));
}

// MCP servers a plugin brings: { name: definition } from its .mcp.json, else its manifest's mcpServers
// (an object, or a path to a JSON file), with the plugin's variables filled in.
export function mcpServers(opts = {}) {
  const out = [];
  for (const p of enabled(opts)) {
    let map = null;
    const own = path.join(p.root, '.mcp.json');
    if (isFile(own)) map = (readJson(own, null) || {}).mcpServers || null;
    if (!map && typeof p.manifest.mcpServers === 'string') map = (readJson(path.resolve(p.root, p.manifest.mcpServers), null) || {}).mcpServers || null;
    if (!map && p.manifest.mcpServers && typeof p.manifest.mcpServers === 'object') map = p.manifest.mcpServers;
    if (!map || typeof map !== 'object') continue;
    for (const [name, def] of Object.entries(map)) {
      if (!def || typeof def !== 'object') continue;
      const fill = (v) => substitute(v, p, opts);
      out.push({ name, plugin: p.name, source: `plugin ${p.name}`, def: {
        ...def,
        ...(def.command ? { command: fill(def.command) } : {}),
        ...(Array.isArray(def.args) ? { args: def.args.map(fill) } : {}),
        ...(def.env && typeof def.env === 'object' ? { env: Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, fill(v)])) } : {}),
        ...(def.url ? { url: fill(def.url) } : {}),
        ...(def.headers && typeof def.headers === 'object' ? { headers: Object.fromEntries(Object.entries(def.headers).map(([k, v]) => [k, fill(v)])) } : {}),
      }, root: p.root });
    }
  }
  return out;
}

// Hooks, by event: [{ plugin, matcher, command, shell, timeout }] with ${CLAUDE_PLUGIN_ROOT} filled in.
export function hooks(opts = {}) {
  const out = {};
  for (const p of enabled(opts)) {
    const file = typeof p.manifest.hooks === 'string' ? path.resolve(p.root, p.manifest.hooks) : path.join(p.root, 'hooks', 'hooks.json');
    const doc = p.manifest.hooks && typeof p.manifest.hooks === 'object' ? { hooks: p.manifest.hooks } : readJson(file, null);
    const events = doc && doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
    for (const [event, groups] of Object.entries(events)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
          if (!h || h.type !== 'command' || typeof h.command !== 'string') continue;
          (out[event] || (out[event] = [])).push({ plugin: p.name, root: p.root, dataDir: dataDir(p, opts.claudeDir), matcher: typeof g.matcher === 'string' ? g.matcher : '', command: substitute(h.command, p, opts), shell: typeof h.shell === 'string' ? h.shell : '', timeout: Number(h.timeout) > 0 ? Number(h.timeout) : 60 });
        }
      }
    }
  }
  return out;
}

// One line per plugin for /plugins: what Atlias reads from it.
export function describe(opts) {
  const list = enabled(opts);
  if (!list.length) return pluginsOn(opts && opts.cfg) ? 'no enabled Claude Code plugins found (Atlias reads ~/.claude/plugins/installed_plugins.json and the enabledPlugins of ~/.claude/settings.json).' : 'plugins are off (agent.plugins); /config agent.plugins on reads them again.';
  return list.map((p) => {
    const parts = ['skills', 'commands', 'agents'].filter((x) => partDirs(p, x).length);
    if (mcpServers({ ...opts }).some((s) => s.plugin === p.name)) parts.push('MCP');
    if (Object.values(hooks({ ...opts })).some((l) => l.some((h) => h.plugin === p.name))) parts.push('hooks');
    return `${p.key.padEnd(44)} ${parts.join(', ') || 'nothing Atlias reads'}`;
  }).join('\n');
}
