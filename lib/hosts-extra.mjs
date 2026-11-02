// Every other harness atlias can find. Each one gets the same atlias MCP server in its own
// config shape and the same instruction block in its own instructions file.
// Two rules keep this honest:
//   1. atlias only writes into a harness whose config directory already exists,
//      so it never litters the disk for tools that are not installed.
//   2. every config shape that could not be checked against a primary source is
//      marked UNVERIFIED here and in the README. `atlias uninstall --extras`
//      removes exactly what was added and nothing else.
import path from 'node:path';
import { nodeCommand, HOME, START_MARK, readText, writeText, readJson, writeJson, exists } from './core.mjs';
import { mergeBlock, stripBlock, instructionBlock, serverPathForConfig } from './hosts.mjs';

const cfgHome = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const stdio = () => ({ command: nodeCommand(), args: [serverPathForConfig()] });
// Cline keeps its MCP settings inside the editor's global storage.
function clineDir() {
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support')
      : cfgHome;
  return path.join(base, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
}

// How each harness stores an MCP server. Pure functions of the parsed document.
const SHAPES = {
  mcpServers: {
    add: (doc) => ({ ...doc, mcpServers: { ...(doc.mcpServers || {}), atlias: stdio() } }),
    remove: (doc) => { const d = { ...doc, mcpServers: { ...(doc.mcpServers || {}) } }; delete d.mcpServers.atlias; return d; },
    has: (doc) => Boolean(doc && doc.mcpServers && doc.mcpServers.atlias),
  },
  opencode: { // opencode.json: { "mcp": { "<name>": { "type": "local", "command": [...] } } }
    add: (doc) => ({ ...doc, mcp: { ...(doc.mcp || {}), atlias: { type: 'local', command: [nodeCommand(), serverPathForConfig()], enabled: true } } }),
    remove: (doc) => { const d = { ...doc, mcp: { ...(doc.mcp || {}) } }; delete d.mcp.atlias; return d; },
    has: (doc) => Boolean(doc && doc.mcp && doc.mcp.atlias),
  },
  ampSettings: { // settings.json with a dotted key
    add: (doc) => ({ ...doc, 'amp.mcpServers': { ...(doc['amp.mcpServers'] || {}), atlias: stdio() } }),
    remove: (doc) => { const d = { ...doc, 'amp.mcpServers': { ...(doc['amp.mcpServers'] || {}) } }; delete d['amp.mcpServers'].atlias; return d; },
    has: (doc) => Boolean(doc && doc['amp.mcpServers'] && doc['amp.mcpServers'].atlias),
  },
  zed: { // settings.json: { "context_servers": { "<name>": { "source": "custom", ... } } }
    add: (doc) => ({ ...doc, context_servers: { ...(doc.context_servers || {}), atlias: { source: 'custom', command: nodeCommand(), args: [serverPathForConfig()] } } }),
    remove: (doc) => { const d = { ...doc, context_servers: { ...(doc.context_servers || {}) } }; delete d.context_servers.atlias; return d; },
    has: (doc) => Boolean(doc && doc.context_servers && doc.context_servers.atlias),
  },
};

export const EXTRAS = [
  { id: 'cursor', label: 'Cursor', dir: path.join(HOME, '.cursor'), mcp: path.join(HOME, '.cursor', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.cursor', 'rules', 'atlias.mdc'), verified: false },
  { id: 'windsurf', label: 'Windsurf', dir: path.join(HOME, '.codeium', 'windsurf'), mcp: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), shape: 'mcpServers', docs: path.join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'), verified: false },
  { id: 'opencode', label: 'OpenCode', dir: path.join(cfgHome, 'opencode'), mcp: path.join(cfgHome, 'opencode', 'opencode.json'), shape: 'opencode', docs: path.join(cfgHome, 'opencode', 'AGENTS.md'), verified: false },
  { id: 'amp', label: 'Amp', dir: path.join(cfgHome, 'amp'), mcp: path.join(cfgHome, 'amp', 'settings.json'), shape: 'ampSettings', docs: path.join(cfgHome, 'amp', 'AGENTS.md'), verified: false },
  { id: 'zed', label: 'Zed', dir: path.join(cfgHome, 'zed'), mcp: path.join(cfgHome, 'zed', 'settings.json'), shape: 'zed', docs: path.join(cfgHome, 'zed', 'AGENTS.md'), verified: false },
  { id: 'kiro', label: 'Kiro', dir: path.join(HOME, '.kiro'), mcp: path.join(HOME, '.kiro', 'settings', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.kiro', 'steering', 'atlias.md'), verified: false },
  { id: 'droid', label: 'Droid (Factory)', dir: path.join(HOME, '.factory'), mcp: path.join(HOME, '.factory', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.factory', 'AGENTS.md'), verified: false },
  { id: 'aider', label: 'Aider', dir: path.join(HOME, '.aider'), mcp: null, shape: null, docs: path.join(HOME, '.aider', 'CONVENTIONS.md'), verified: false },
  { id: 'trae', label: 'Trae', dir: path.join(HOME, '.trae'), mcp: path.join(HOME, '.trae', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.trae', 'rules', 'atlias.md'), verified: false },
  { id: 'cline', label: 'Cline', dir: clineDir(), mcp: path.join(clineDir(), 'cline_mcp_settings.json'), shape: 'mcpServers', docs: path.join(HOME, '.clinerules', 'atlias.md'), verified: false },
  { id: 'continue', label: 'Continue', dir: path.join(HOME, '.continue'), mcp: null, shape: null, docs: path.join(HOME, '.continue', 'rules', 'atlias.md'), verified: false },
  { id: 'codebuddy', label: 'CodeBuddy', dir: path.join(HOME, '.codebuddy'), mcp: path.join(HOME, '.codebuddy', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.codebuddy', 'CODEBUDDY.md'), verified: false },
  { id: 'hermes', label: 'Hermes Agent', dir: path.join(HOME, '.hermes'), mcp: path.join(HOME, '.hermes', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.hermes', 'AGENTS.md'), verified: false },
  { id: 'pi', label: 'Pi', dir: path.join(HOME, '.pi'), mcp: path.join(HOME, '.pi', 'mcp.json'), shape: 'mcpServers', docs: path.join(HOME, '.pi', 'AGENTS.md'), verified: false },
];

// Cursor reads a rule file only when it declares itself. alwaysApply keeps
// the block in context the way the other harnesses keep their instructions.
export const MDC_FRONTMATTER = ['---', 'description: atlias sub-harness: shared memory, knowledge graph, verification', 'alwaysApply: true', '---', ''].join('\n');
export function installed(h) { return exists(h.dir); }
export function byId(id) { return EXTRAS.find((h) => h.id === id) || null; }

export function install(h) {
  if (!installed(h)) return `${h.label}: not installed here (${h.dir} does not exist), skipped`;
  const done = [];
  if (h.mcp && h.shape) {
    writeJson(h.mcp, SHAPES[h.shape].add(readJson(h.mcp, {}) || {}));
    done.push(`mcp server in ${h.mcp}`);
  }
  if (h.docs) {
    const body = instructionBlock(h.label);
    // A Cursor rule file is only read when it carries frontmatter.
    const existing = readText(h.docs) || (h.docs.endsWith('.mdc') ? MDC_FRONTMATTER : '');
    writeText(h.docs, mergeBlock(existing, body));
    done.push(`instruction block in ${h.docs}`);
  }
  return `${h.label}: ${done.join(', ')}${h.verified ? '' : ' (config shape UNVERIFIED; uninstall --extras reverses it)'}`;
}
export function uninstall(h) {
  const done = [];
  if (h.mcp && h.shape && exists(h.mcp)) {
    const doc = readJson(h.mcp);
    if (doc) { writeJson(h.mcp, SHAPES[h.shape].remove(doc)); done.push('mcp server'); }
  }
  if (h.docs && exists(h.docs)) { writeText(h.docs, stripBlock(readText(h.docs))); done.push('instruction block'); }
  return `${h.label}: ${done.length ? done.join(' and ') + ' removed' : 'nothing to remove'}`;
}
export function installAll(ids) {
  const list = ids && ids.length ? ids.map(byId).filter(Boolean) : EXTRAS;
  return list.map(install);
}
export function uninstallAll(ids) {
  const list = ids && ids.length ? ids.map(byId).filter(Boolean) : EXTRAS;
  return list.map(uninstall);
}
export function doctorRows() {
  return EXTRAS.filter(installed).map((h) => {
    const mcpOk = !h.mcp || !h.shape || SHAPES[h.shape].has(readJson(h.mcp, {}) || {});
    const docsOk = !h.docs || (readText(h.docs) || '').includes(START_MARK);
    return { name: h.label.toLowerCase(), ok: mcpOk && docsOk, detail: h.mcp || h.docs, fix: `atlias install --extras (or --extras ${h.id})` };
  });
}
export function statusLine() {
  const here = EXTRAS.filter(installed).map((h) => h.label);
  return here.length ? `extra harnesses detected: ${here.join(', ')}` : 'no extra harnesses detected on this machine';
}
export { SHAPES };
