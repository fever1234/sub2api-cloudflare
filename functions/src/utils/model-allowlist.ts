// Per-group model allowlist (ported from Go group_model_allowlist.go).
//
// An API key pinned to a group inherits that group's allowlist: models outside
// it must not be listed, must not be retrievable, and must not be generated —
// a 404 model_not_found, matching Go's openai_models_handler, so a client
// cannot tell a denied model from a nonexistent one.
//
// Entries are exact ids or `prefix*` wildcards (trailing star only). Matching
// is case-insensitive, and a requested id is tried with the `models/` prefix
// and the `-thinking` suffix removed so Gemini-style and thinking-variant ids
// resolve to the same entry.
import type { Group } from '../types';

export function modelAllowlistCandidates(model: string): string[] {
  const trimmed = model.trim();
  const candidates = [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('models/')) candidates.push(trimmed.slice('models/'.length));
  if (lower.endsWith('-thinking')) candidates.push(trimmed.slice(0, -'-thinking'.length));
  return candidates;
}

/**
 * Normalize a client-supplied allowlist: trim, drop empties, dedupe
 * case-insensitively, and reject anything that is not an exact id or a
 * trailing-`*` wildcard with a non-empty prefix. Returns an error string for
 * values that must not be stored.
 */
export function normalizeModelAllowlist(raw: unknown): { list?: string[]; error?: string } {
  if (!Array.isArray(raw)) return { error: '模型白名单必须是字符串数组' };
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: '模型白名单必须是字符串数组' };
    const value = item.trim();
    if (!value) continue;
    const stars = value.split('*').length - 1;
    if (stars > 0 && (stars > 1 || !value.endsWith('*') || value.length === 1)) {
      return { error: `通配符只能出现在模型名称末尾且只能有一个：「${value}」` };
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(value);
  }
  return { list };
}

export function parseModelAllowlist(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function serializeModelAllowlist(list: string[]): string {
  return JSON.stringify(list);
}

/** True when the group's allowlist admits the model. No group or a disabled gate admits everything. */
export function modelAllowed(model: string, group: Group | undefined | null): boolean {
  if (!group || !Number(group.model_allowlist_enabled)) return true;
  const allowlist = parseModelAllowlist(group.model_allowlist).map(entry => entry.toLowerCase());
  // The config API refuses to store this combination; a row that got here
  // anyway (manual SQL, a race during edits) blocks rather than opens up.
  if (allowlist.length === 0) return false;
  // No model asked means there is nothing to deny; later validation owns it.
  if (!model.trim()) return true;

  for (const candidate of modelAllowlistCandidates(model)) {
    const lowered = candidate.toLowerCase();
    for (const entry of allowlist) {
      if (entry.endsWith('*')) {
        if (lowered.startsWith(entry.slice(0, -1))) return true;
      } else if (lowered === entry) {
        return true;
      }
    }
  }
  return false;
}

/** Go's wording for both missing and denied models, so the two stay indistinguishable. */
export function modelAllowlistDeniedMessage(model: string): string {
  return `Model "${model}" does not exist or is not available for this group`;
}

export function modelAllowlistDenied(model: string): Response {
  return new Response(JSON.stringify({
    error: {
      message: modelAllowlistDeniedMessage(model),
      type: 'invalid_request_error',
      code: 'model_not_found'
    }
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}
