// Anthropic prompt-cache breakpoint injection.
//
// Anthropic only caches a prefix when a message (or the tool list) carries a
// cache_control marker. Official clients add them; most third-party clients
// do not, so their long system prompts and tool definitions are re-billed in
// full on every turn. When a request has no markers at all, this adds a small
// set — capped at Anthropic's own limit of four — at the positions that cover
// the stable prefix: the tool list, the last message, and (on long enough
// conversations) the previous user turn. Requests that already mark their own
// breakpoints are left untouched so the client keeps full control.

/** Anthropic rejects more than four cache_control markers per request. */
const MAX_BREAKPOINTS = 4;

function hasCacheControl(node: any, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  if (node.cache_control) return true;
  if (Array.isArray(node)) {
    return node.some(item => hasCacheControl(item, depth + 1));
  }
  for (const key of Object.keys(node)) {
    if (key === 'cache_control') continue;
    if (hasCacheControl((node as any)[key], depth + 1)) return true;
  }
  return false;
}

/** Content must be a block array before a block can carry cache_control. */
function toBlocks(content: any): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Inject cache breakpoints into an Anthropic /v1/messages body.
 * Returns true when the body was modified (so callers that reuse the original
 * raw body know to re-serialize it).
 */
export function applyAnthropicCacheBreakpoints(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  if (hasCacheControl(body)) return false;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return false;

  let placed = 0;
  const mark = (block: any): boolean => {
    if (placed >= MAX_BREAKPOINTS || !block || typeof block !== 'object') return false;
    block.cache_control = { type: 'ephemeral' };
    placed += 1;
    return true;
  };
  const markMessage = (message: any): boolean => {
    if (!message || typeof message !== 'object') return false;
    const blocks = toBlocks(message.content);
    if (blocks.length === 0) return false;
    if (typeof message.content === 'string') message.content = blocks;
    return mark(blocks[blocks.length - 1]);
  };

  let changed = false;

  // The tool list sits before every message in the cached prefix, so marking
  // the last tool caches the whole stable head of the request.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1];
    if (lastTool && typeof lastTool === 'object' && !lastTool.cache_control) {
      changed = mark(lastTool) || changed;
    }
  }

  changed = markMessage(messages[messages.length - 1]) || changed;

  // On a real conversation, also pin the previous user turn so a two-turn-old
  // prefix stays reusable while the newest exchange streams in.
  if (messages.length >= 4) {
    const userIndexes: number[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const message = messages[i];
      if (message && typeof message === 'object' && message.role === 'user') userIndexes.push(i);
    }
    if (userIndexes.length >= 2) {
      changed = markMessage(messages[userIndexes[userIndexes.length - 2]]) || changed;
    }
  }

  return changed;
}
