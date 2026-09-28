// Groups configuration API
import type { Env } from '../index';
import { createDatabase } from '../db';
import { verifySessionToken, resolveSessionSecret } from '../auth';
import { normalizeModelAllowlist, serializeModelAllowlist } from '../utils/model-allowlist';

export async function handleGroupsRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  
  // Configuration is an administrator-only surface.
  {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    
    const token = authHeader.slice(7);
    const session = await verifySessionToken(token, await resolveSessionSecret(db, env.JWT_SECRET));
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // GET /api/v1/groups - list all groups
  if (method === 'GET') {
    const groups = await db.listGroups();
    return jsonData(groups);
  }
  
  // POST /api/v1/groups - create group
  if (method === 'POST') {
    let body: {
      name?: string; description?: string; priority?: number; enabled?: number | boolean;
      error_threshold?: number; error_count_threshold?: number; window_seconds?: number;
    };
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    const name = String(body.name || '').trim();
    if (!name) return jsonError('请填写分组名称', 400);

    const thresholds = readThresholds(body);
    if (typeof thresholds === 'string') return jsonError(thresholds, 400);

    const allowlist = readAllowlist(body);
    if (typeof allowlist === 'string') return jsonError(allowlist, 400);

    // groups.name is UNIQUE; check first so the client gets a readable message
    // instead of a raw D1 constraint error.
    if (await db.getGroupByName(name)) return jsonError(`分组名称「${name}」已存在`, 409);

    const result = await db.createGroup(name, String(body.description || '').trim(), Number(body.priority) || 0, {
      enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
      ...thresholds,
      ...allowlist
    });

    const group = await db.getGroup(result.lastRowId);
    return jsonData(group, 201);
  }
  
  // PUT /api/v1/groups/:id - update group
  if (method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid group ID', 400);

    let body: Record<string, any>;
    try { body = await request.json(); } catch { return jsonError('Invalid JSON body', 400); }

    if (!(await db.getGroup(id))) return jsonError('分组不存在', 404);

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return jsonError('分组名称不能为空', 400);
      const clash = await db.getGroupByName(name);
      if (clash && Number(clash.id) !== id) return jsonError(`分组名称「${name}」已存在`, 409);
      updates.name = name;
    }
    if (body.description !== undefined) updates.description = String(body.description).trim();
    if (body.priority !== undefined) updates.priority = Number(body.priority) || 0;
    if (body.enabled !== undefined) updates.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;

    const thresholds = readThresholds(body, true);
    if (typeof thresholds === 'string') return jsonError(thresholds, 400);
    Object.assign(updates, thresholds);

    const allowlist = readAllowlist(body, true);
    if (typeof allowlist === 'string') return jsonError(allowlist, 400);
    Object.assign(updates, allowlist);

    // Enabling the gate with nothing in it would deny every model; catch it
    // here whether the list arrives in this request or was empty already.
    const existing = await db.getGroup(id);
    const finalEnabled = updates.model_allowlist_enabled !== undefined
      ? Number(updates.model_allowlist_enabled)
      : Number(existing?.model_allowlist_enabled) || 0;
    if (finalEnabled) {
      const finalList = updates.model_allowlist !== undefined
        ? JSON.parse(String(updates.model_allowlist))
        : JSON.parse(existing?.model_allowlist || '[]');
      if (!Array.isArray(finalList) || finalList.length === 0) {
        return jsonError('启用模型白名单后至少需要一个模型', 400);
      }
    }

    await db.updateGroup(id, updates);
    const group = await db.getGroup(id);
    return jsonData(group);
  }
  
  // DELETE /api/v1/groups/:id - delete group
  if (method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop() || '0');
    if (!id) return jsonError('Invalid group ID', 400);

    // Deleting a referenced group would leave accounts permanently unroutable.
    const attached = await db.countAccountsInGroup(id);
    if (attached > 0) {
      return jsonError(`该分组下还有 ${attached} 个账号，请先移动或删除这些账号`, 400);
    }
    const mapped = await db.countModelMappingsForGroup(id);
    if (mapped > 0) {
      return jsonError(`该分组仍被 ${mapped} 条模型映射引用，请先调整映射`, 400);
    }

    await db.deleteGroup(id);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: JSON_HEADERS });
  }
  
  return jsonError('Method not allowed', 405);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/**
 * Validate failover thresholds. Out-of-range values would either disable
 * circuit breaking entirely or trip it on the first request, so reject them
 * here instead of storing a value that quietly breaks scheduling.
 * Returns an error string, or the fields to persist.
 */
function readThresholds(
  body: Record<string, any>,
  partial = false
): string | { error_threshold?: number; error_count_threshold?: number; window_seconds?: number } {
  const result: { error_threshold?: number; error_count_threshold?: number; window_seconds?: number } = {};

  if (body.error_threshold !== undefined) {
    const rate = Number(body.error_threshold);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return '错误率阈值必须在 0 到 1 之间';
    result.error_threshold = rate;
  } else if (!partial) {
    result.error_threshold = 0.5;
  }

  if (body.error_count_threshold !== undefined) {
    const count = Number(body.error_count_threshold);
    if (!Number.isInteger(count) || count < 1) return '错误次数阈值必须是不小于 1 的整数';
    result.error_count_threshold = count;
  } else if (!partial) {
    result.error_count_threshold = 5;
  }

  if (body.window_seconds !== undefined) {
    const window = Number(body.window_seconds);
    if (!Number.isInteger(window) || window < 10 || window > 86400) return '统计窗口必须是 10 到 86400 秒之间的整数';
    result.window_seconds = window;
  } else if (!partial) {
    result.window_seconds = 300;
  }

  return result;
}

/**
 * Validate the model allowlist. Wildcards only at the end of an entry, entries
 * deduped case-insensitively — and an enabled gate with an empty list would
 * deny every model, which is never what an operator means.
 * Returns an error string, or the fields to persist.
 */
function readAllowlist(
  body: Record<string, any>,
  partial = false
): string | { model_allowlist_enabled?: number; model_allowlist?: string } {
  const result: { model_allowlist_enabled?: number; model_allowlist?: string } = {};

  if (body.model_allowlist_enabled !== undefined) {
    result.model_allowlist_enabled = body.model_allowlist_enabled === true || body.model_allowlist_enabled === 1 ? 1 : 0;
  }

  if (body.model_allowlist !== undefined) {
    const normalized = normalizeModelAllowlist(body.model_allowlist);
    if (normalized.error) return normalized.error;
    const list = normalized.list || [];
    const enabled = result.model_allowlist_enabled !== undefined ? result.model_allowlist_enabled : 0;
    if (enabled && list.length === 0) return '启用模型白名单后至少需要一个模型';
    result.model_allowlist = serializeModelAllowlist(list);
  } else if (!partial && body.model_allowlist_enabled) {
    return '启用模型白名单后至少需要一个模型';
  }

  return result;
}
