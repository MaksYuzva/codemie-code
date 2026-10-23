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

/** Consume value options before inspecting flags, since quoted values may themselves look like flags. */
function cliOptions(args: string[], provider: Provider): string[] | undefined {
  const values = new Set(provider === 'github'
    ? ['--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H', '--reviewer', '-r', '--assignee', '-a', '--label', '-l', '--milestone', '-m', '--project', '-p', '--template', '-T']
    : ['--title', '-t', '--description', '-d', '--target-branch', '-b', '--source-branch', '-s', '--reviewer', '--assignee', '-a', '--label', '-l', '--milestone', '-m']);
  const options: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.split('=')[0];
    if (values.has(flag)) { if (!arg.includes('=') && args[++i] === undefined) return; continue; }
    if (/^(?:--(?:help|web|dry-run|recover)|-h|-w)(?:=|$)/.test(arg)) return;
    options.push(arg);
    if (/^--(?:host|hostname)(?:=|$)/.test(arg)) return;
    if (['--repo', '-R'].includes(arg)) {
      if (args[i + 1] === undefined) return;
      options.push(args[++i]);
    }
  }
  return options;
}

function invocation(block: ClaudeNativeBlock): Invocation | null | undefined {
  const input = object(block.input) ?? {};
  if (block.name === 'mcp__github__create_pull_request') return { provider: 'github', source: 'github_mcp', input };
  if (block.name === 'mcp__gitlab__create_merge_request') return { provider: 'gitlab', source: 'gitlab_mcp', input };
  if (block.name !== 'Bash' || typeof input.command !== 'string') return;
  if (!/^\s*(?:gh\s+pr|glab\s+mr)\s+create\b/.test(input.command)) return;
  const words = literalWords(input.command);
  if (!words || words[2] !== 'create') return null;
  const provider = words[0] === 'gh' ? 'github' : 'gitlab';
  const args = cliOptions(words.slice(3), provider);
  if (!args) return null;
  return { provider, source: provider === 'github' ? 'gh_cli' : 'glab_cli', input, args };
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

function cliResult(call: Invocation, content: unknown): ReturnType<typeof parseUrl> {
  if (typeof content !== 'string' || !content) return;
  const lines = content.trim().split(/\r?\n/).map((line) => line.trim());
  const urls = lines.filter((line) => /^https:\/\/\S+$/.test(line));
  const prose = lines.filter((line) => !/^https:\/\/\S+$/.test(line))
    .filter((line) => !(call.provider === 'gitlab' && /^Creating (?:draft )?merge request for \S+ into \S+ in \S+$/.test(line))).join('\n');
  if (urls.length !== 1 || /\b(?:error|failed|failure|already|exists|preview)\b/i.test(prose)) return;
  const result = parseUrl(urls[0], call.provider);
  return result && cliMatches(call, result) ? result : undefined;
}

function collectRepresentations(value: unknown, records: RecordValue[]): boolean {
  const record = object(responseContent(value));
  if (!record || failed(record)) return false;
  records.push(record);
  for (const field of ['structuredContent', 'content']) {
    if (record[field] !== undefined && !collectRepresentations(record[field], records)) return false;
  }
  return true;
}

function mcpTargetMatches(call: Invocation, payload: RecordValue, result: NonNullable<ReturnType<typeof parseUrl>>): boolean {
  if (call.provider === 'github') {
    return payload.number === result.number
      && (call.input.owner === undefined || typeof call.input.owner === 'string' && call.input.owner.toLowerCase() === result.repository.split('/')[0].toLowerCase())
      && (call.input.repo === undefined || typeof call.input.repo === 'string' && call.input.repo.toLowerCase() === result.repository.split('/')[1].toLowerCase());
  }
  if (payload.iid !== result.number || !positive(payload.project_id)) return false;
  const project = call.input.project_id;
  if (typeof project === 'number' || typeof project === 'string' && /^\d+$/.test(project)) {
    return positive(Number(project)) && Number(project) === payload.project_id;
  }
  if (typeof project !== 'string') return false;
  try { return targetMatches(decodeURIComponent(project), result, 'gitlab'); } catch { return false; }
}

function mcpResult(call: Invocation, block: ClaudeNativeBlock & { content?: unknown; structuredContent?: unknown }): ReturnType<typeof parseUrl> {
  const raw = responseContent(block.structuredContent ?? block.content);
  // Validate every envelope and alternative representation, not just the chosen payload.
  const representations: RecordValue[] = [];
  if (!collectRepresentations(raw, representations)) return;
  if (block.structuredContent !== undefined && block.content !== undefined && !collectRepresentations(block.content, representations)) return;
  const envelope = object(raw);
  if (!envelope) return;
  const payload = object(envelope.structuredContent) ?? (envelope.content !== undefined ? object(responseContent(envelope.content)) : envelope);
  if (!payload) return;
  const result = parseUrl(call.provider === 'github' ? payload.html_url : payload.web_url, call.provider);
  if (!result) return;
  for (const representation of [call.input, block, ...representations]) {
    if (['host', 'hostname'].some((field) => representation[field] !== undefined && representation[field] !== result.host)) return;
  }
  for (const representation of representations) {
    if (representation.html_url === undefined && representation.web_url === undefined) continue;
    const identityUrl = parseUrl(call.provider === 'github' ? representation.html_url : representation.web_url, call.provider);
    if (!identityUrl || identityUrl.url !== result.url
      || (call.provider === 'github' ? representation.number !== result.number : representation.iid !== result.number || representation.project_id !== payload.project_id)) return;
  }
  return mcpTargetMatches(call, payload, result) ? result : undefined;
}

function verifiedResult(call: Invocation, occurrence: Occurrence): ReturnType<typeof parseUrl> {
  const block = occurrence.block as ClaudeNativeBlock & { content?: unknown; structuredContent?: unknown };
  if (failed(block) || failed(occurrence.row.toolUseResult)) return;
  return call.args ? cliResult(call, block.content) : mcpResult(call, block);
}

type TraceIndex = ReturnType<typeof buildClaudeTraceIndex>;
type Occurrences = Map<string, Occurrence[]>;
interface EvidenceWindow { start?: number; end?: number; observedEnd?: number }

function collectRow(row: ClaudeNativeRow, owner: string, calls: Occurrences, results: Occurrences): boolean {
  let partial = false;
  for (const block of claudeBlocks(row ?? {})) {
    const id = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : undefined;
    if (!id) {
      partial ||= block.type === 'tool_use' && invocation(block) !== undefined;
      continue;
    }
    const map = block.type === 'tool_use' ? calls : results;
    const values = map.get(id) ?? [];
    values.push({ row, block, owner }); map.set(id, values);
  }
  return partial;
}

function collectOccurrences(index: TraceIndex, evidence: ChangeRequestCreationEvidence): { calls: Occurrences; results: Occurrences } {
  const calls: Occurrences = new Map(), results: Occurrences = new Map();
  let partial = false;
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      const rowPartial = collectRow(row, owner.id, calls, results);
      partial ||= rowPartial;
    }
  }
  if (partial) evidence.status = 'partial';
  return { calls, results };
}

function linkedOwner(owner: string | undefined, index: TraceIndex, calls: Occurrences, inWindow: (time: number) => boolean): boolean {
  let ancestor = owner;
  const visited = new Set<string>();
  while (ancestor && ancestor !== index.rootOwnerId && !visited.has(ancestor)) {
    visited.add(ancestor);
    const agent = index.agents.get(ancestor);
    const launches = agent?.toolUseId ? calls.get(agent.toolUseId)?.filter((entry) => entry.owner === agent.ownerAgentId) : undefined;
    if (!launches?.length || launches.some((launch) => {
      const time = claudeTimestamp(launch.row);
      return time === undefined || !inWindow(time);
    })) return false;
    ancestor = agent?.relationshipStatus === 'resolved' ? agent.ownerAgentId : undefined;
  }
  return ancestor === index.rootOwnerId;
}

/** Inspect owned native tool pairs without interpreting arbitrary shell or exporting raw content. */
export function extractChangeRequestCreationEvidence(parsed: ParsedSession, window: EvidenceWindow = {}): ChangeRequestCreationEvidence {
  const index = buildClaudeTraceIndex(parsed);
  const evidence: ChangeRequestCreationEvidence = { status: 'available', events: [] };
  const { calls, results } = collectOccurrences(index, evidence);
  const inWindow = (time: number): boolean => (window.start === undefined || time >= window.start)
    && (window.end === undefined || time < window.end) && (window.observedEnd === undefined || time <= window.observedEnd);
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
    if (begin !== undefined && !inWindow(begin) || end !== undefined && !inWindow(end)) {
      if (begin !== undefined && inWindow(begin) || end !== undefined && inWindow(end)) evidence.status = 'partial';
      continue;
    }
    const call = first && invocation(first.block);
    if (!call || !identity(id) || !owner || !identity(owner) || !linkedOwner(owner, index, calls, inWindow) || index.conflictingTools.has(id)
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
