import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { buildClaudeTraceIndex } from './claude-trace.js';
import { claudeBlocks, claudeTimestamp, type ClaudeNativeBlock, type ClaudeNativeRow } from './claude-native.js';
import type { ChangeRequestCreationEvent, ChangeRequestCreationEvidence } from './types.js';

type RecordValue = Record<string, unknown>;
type Provider = ChangeRequestCreationEvent['provider'];
interface Invocation { provider: Provider; source: ChangeRequestCreationEvent['source']; input: RecordValue; args?: string[] }
interface Occurrence { row: ClaudeNativeRow; block: ClaudeNativeBlock; owner: string }
const MAX_EVENTS = 100;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some((char) => /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Deliberately not a shell interpreter: accept only literal words and literal quotes. */
function literalWords(command: string): string[] | undefined {
  if (/[\r\n]/.test(command)) return;
  const words: string[] = [];
  let word = '', quote = '', active = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && /[$`\\]/.test(char)) return;
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (/\s/.test(char)) { if (active) words.push(word); word = ''; active = false; }
    else if (/[;&|<>$`\\(){}*?[\]~#]/.test(char)) return;
    else { word += char; active = true; }
  }
  if (quote) return;
  if (active) words.push(word);
  return words;
}

function invocation(block: ClaudeNativeBlock): Invocation | null | undefined {
  const input = object(block.input) ?? {};
  if (block.name === 'mcp__github__create_pull_request') return { provider: 'github', source: 'github_mcp', input };
  if (block.name === 'mcp__gitlab__create_merge_request') return { provider: 'gitlab', source: 'gitlab_mcp', input };
  if (block.name !== 'Bash' || typeof input.command !== 'string') return;
  if (!/^\s*(?:gh\s+pr|glab\s+mr)\s+create\b/.test(input.command)) return;
  const words = literalWords(input.command);
  if (!words || words[2] !== 'create') return null;
  // These modes do not provide a successful direct-create result contract.
  if (words.slice(3).some((arg) => /^(?:--(?:help|web|dry-run|recover)|-h|-w)(?:=|$)/.test(arg))) return null;
  return { provider: words[0] === 'gh' ? 'github' : 'gitlab', source: words[0] === 'gh' ? 'gh_cli' : 'glab_cli', input, args: words.slice(3) };
}

function parseUrl(value: unknown, provider: Provider): Pick<ChangeRequestCreationEvent, 'host' | 'repository' | 'number' | 'url'> | undefined {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return;
  // Check before URL normalizes dot segments or encoded separators.
  const rawPath = value.match(/^https:\/\/[^/]+(\/[^?#]*)/)?.[1];
  if (!rawPath || /%|\/\.{1,2}(?:\/|$)/.test(rawPath)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !identity(url.host)) return;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*(?::\d+)?$/i.test(url.host)) return;
    if (provider === 'github' && url.host !== 'github.com') return;
    const match = provider === 'github' ? url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/) : url.pathname.match(/^\/(.+\/.+)\/-\/merge_requests\/(\d+)$/);
    if (!match || !identity(match[1]) || !match[1].split('/').every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')) return;
    const number = Number(match[2]);
    if (!positive(number) || String(number) !== match[2]) return;
    return { host: url.host, repository: match[1], number, url: `https://${url.host}/${match[1]}/${provider === 'github' ? 'pull' : '-/merge_requests'}/${number}` };
  } catch { return; }
}

function targetMatches(value: unknown, result: NonNullable<ReturnType<typeof parseUrl>>, provider: Provider): boolean {
  if (typeof value !== 'string' || !value || /^\d+$/.test(value)) return false;
  if (value === result.repository) return true;
  let selector = value;
  if (selector.startsWith('https://')) {
    try { const url = new URL(selector); if (url.username || url.password || url.search || url.hash || url.host !== result.host) return false; selector = url.pathname.slice(1); } catch { return false; }
  } else if (selector.split('/')[0].includes('.') || selector.split('/')[0].includes(':')) {
    const slash = selector.indexOf('/');
    if (selector.slice(0, slash).toLowerCase() !== result.host) return false;
    selector = selector.slice(slash + 1);
  }
  return provider === 'github' ? selector.toLowerCase() === result.repository.toLowerCase() : selector === result.repository;
}

function cliMatches(call: Invocation, result: NonNullable<ReturnType<typeof parseUrl>>): boolean {
  const args = call.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-R' || arg === '--repo') { if (!targetMatches(args[++i], result, call.provider)) return false; }
    else if (arg.startsWith('--repo=')) { if (!targetMatches(arg.slice(7), result, call.provider)) return false; }
    else if (arg.startsWith('-R') && arg.length > 2) { if (!targetMatches(arg.slice(2), result, call.provider)) return false; }
    else if (arg === '--hostname' || arg === '--host') { if (args[++i]?.toLowerCase() !== result.host) return false; }
    else if (/^--(?:hostname|host)=/.test(arg) && arg.split('=')[1]?.toLowerCase() !== result.host) return false;
  }
  return true;
}

function failed(value: unknown): boolean {
  const record = object(value);
  if (!record) return false;
  return record.is_error === true || record.isError === true || record.error != null || record.interrupted === true
    || ['failed', 'error', 'cancelled'].includes(String(record.status))
    || ['exitCode', 'exit_code', 'code'].some((key) => record[key] !== undefined && record[key] !== null && record[key] !== 0 && record[key] !== '0');
}

function responseContent(value: unknown): unknown {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return value; } }
  if (Array.isArray(value)) {
    if (value.length !== 1 || object(value[0])?.type !== 'text') return;
    return responseContent(object(value[0])?.text);
  }
  return value;
}

function verifiedResult(call: Invocation, occurrence: Occurrence): ReturnType<typeof parseUrl> {
  const block = occurrence.block as ClaudeNativeBlock & { content?: unknown; structuredContent?: unknown };
  if (failed(block) || failed(occurrence.row.toolUseResult)) return;
  if (call.args) {
    const content = typeof block.content === 'string' ? block.content : undefined;
    if (!content || /\b(?:error|failed|failure|already|exists|preview)\b/i.test(content)) return;
    const lines = content.trim().split(/\r?\n/).map((line) => line.trim());
    const urls = lines.filter((line) => /^https:\/\/\S+$/.test(line));
    if (urls.length !== 1) return;
    const result = parseUrl(urls[0], call.provider);
    return result && cliMatches(call, result) ? result : undefined;
  }
  const raw = responseContent(block.structuredContent ?? block.content);
  // If integrations emit more than one representation, every supplied identity must agree.
  const representations: RecordValue[] = [];
  const collect = (value: unknown): boolean => {
    const record = object(responseContent(value));
    if (!record || failed(record)) return false;
    if (record.html_url !== undefined || record.web_url !== undefined) representations.push(record);
    for (const field of ['structuredContent', 'content']) {
      if (record[field] !== undefined && !collect(record[field])) return false;
    }
    return true;
  };
  if (!collect(raw)) return;
  if (block.structuredContent !== undefined && block.content !== undefined && !collect(block.content)) return;
  const envelope = object(raw);
  if (!envelope || failed(envelope)) return;
  const payload = object(envelope.structuredContent) ?? (envelope.content !== undefined ? object(responseContent(envelope.content)) : envelope);
  if (!payload || failed(payload)) return;
  const result = parseUrl(call.provider === 'github' ? payload.html_url : payload.web_url, call.provider);
  if (!result) return;
  for (const representation of representations) {
    const identityUrl = parseUrl(call.provider === 'github' ? representation.html_url : representation.web_url, call.provider);
    if (!identityUrl || identityUrl.url !== result.url
      || (call.provider === 'github' ? representation.number !== result.number : representation.iid !== result.number || representation.project_id !== payload.project_id)) return;
  }
  for (const field of ['host', 'hostname']) {
    if (call.input[field] !== undefined && call.input[field] !== result.host) return;
    if (payload[field] !== undefined && payload[field] !== result.host) return;
    if (envelope[field] !== undefined && envelope[field] !== result.host) return;
  }
  if (call.provider === 'github') {
    if (payload.number !== result.number) return;
    if (call.input.owner !== undefined && call.input.owner !== result.repository.split('/')[0]) return;
    if (call.input.repo !== undefined && call.input.repo !== result.repository.split('/')[1]) return;
  } else {
    if (payload.iid !== result.number || !positive(payload.project_id)) return;
    const project = call.input.project_id;
    if (typeof project === 'number' || typeof project === 'string' && /^\d+$/.test(project)) {
      if (!positive(Number(project)) || Number(project) !== payload.project_id) return;
    } else if (typeof project === 'string') {
      try { if (!targetMatches(decodeURIComponent(project), result, 'gitlab')) return; } catch { return; }
    } else return;
  }
  return result;
}

/** Inspect owned native tool pairs without interpreting arbitrary shell or exporting raw content. */
export function extractChangeRequestCreationEvidence(parsed: ParsedSession, window: { start?: number; end?: number } = {}): ChangeRequestCreationEvidence {
  const index = buildClaudeTraceIndex(parsed);
  const calls = new Map<string, Occurrence[]>(), results = new Map<string, Occurrence[]>();
  const evidence: ChangeRequestCreationEvidence = { status: 'available', events: [] };
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      for (const block of claudeBlocks(row ?? {})) {
        const id = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : undefined;
        if (!id) continue;
        const map = block.type === 'tool_use' ? calls : results;
        const values = map.get(id) ?? [];
        values.push({ row, block, owner: owner.id }); map.set(id, values);
      }
    }
  }
  const inWindow = (time: number): boolean => (window.start === undefined || time >= window.start) && (window.end === undefined || time < window.end);
  for (const [id, occurrences] of calls) {
    if (!occurrences.some((entry) => invocation(entry.block) !== undefined)) continue;
    const owner = index.toolOwners.get(id);
    const owned = occurrences.filter((entry) => entry.owner === owner);
    const uniqueCalls = new Set(occurrences.map((entry) => JSON.stringify([entry.block, entry.row.timestamp])));
    const paired = (results.get(id) ?? []).filter((entry) => entry.owner === owner);
    const uniqueResults = new Set(paired.map((entry) => JSON.stringify([entry.block, entry.row.timestamp, entry.row.toolUseResult])));
    const first = owned[0], response = paired[0];
    const begin = first && claudeTimestamp(first.row), end = response && claudeTimestamp(response.row);
    // A replay outside the receiving session's bounds is not a candidate for that session.
    if (begin !== undefined && !inWindow(begin) || end !== undefined && !inWindow(end)) continue;
    const call = first && invocation(first.block);
    let linked = owner === index.rootOwnerId;
    let ancestor = owner;
    const visited = new Set<string>();
    while (ancestor && !linked && !visited.has(ancestor)) {
      visited.add(ancestor);
      const agent = index.agents.get(ancestor);
      const launches = agent?.toolUseId ? calls.get(agent.toolUseId)?.filter((entry) => entry.owner === agent.ownerAgentId) : undefined;
      if (!launches?.length || launches.some((launch) => {
        const time = claudeTimestamp(launch.row);
        return time === undefined || !inWindow(time);
      })) break;
      ancestor = agent?.relationshipStatus === 'resolved' ? agent.ownerAgentId : undefined;
      linked = ancestor === index.rootOwnerId;
    }
    if (!call || !identity(id) || !owner || !identity(owner) || !linked || index.conflictingTools.has(id)
      || uniqueCalls.size !== 1 || uniqueResults.size !== 1 || begin === undefined || end === undefined || end < begin) {
      evidence.status = 'partial'; continue;
    }
    const result = verifiedResult(call, response);
    if (!result) { evidence.status = 'partial'; continue; }
    if (evidence.events.length === MAX_EVENTS) { evidence.status = 'partial'; continue; }
    evidence.events.push({ type: call.provider === 'github' ? 'pr_created' : 'mr_created', provider: call.provider, ...result,
      timestamp: new Date(end).toISOString(), source: call.source, toolUseId: id,
      owner: owner === index.rootOwnerId ? 'root' : 'subagent', ...(owner !== index.rootOwnerId ? { ownerId: owner } : {}) });
  }
  evidence.events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return evidence;
}
