"""End-to-end gateway tests: routing, model mapping, scheduling, failover.

Runs against `wrangler pages dev` with fake upstream providers, so it exercises
the real worker code path (auth -> mapping -> account selection -> proxy ->
failover -> usage logging) rather than mocking it.

Usage:
  python tests/gateway.test.py [base_url]
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, 'tests')
from upstream_stub import serve  # noqa: E402

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788').rstrip('/')
API = f'{BASE}/api/v1'
ADMIN = ('gwadmin', 'gateway-pass-9911')

PORT_A, PORT_B, PORT_C = 9101, 9102, 9103
# Fresh upstreams for the sticky-routing and cooldown fixtures: their accounts
# start with a clean error window, so account selection is decided by the
# factors under test rather than by history left over from earlier cases.
PORT_D, PORT_E = 9104, 9105
# Dedicated upstream for the Responses field-strip fixture.
PORT_F = 9106
# Dedicated upstream for the OpenAI silent-refusal fixture.
PORT_G = 9107

passed = 0
failures = []


def check(name, ok, detail=''):
    global passed
    if ok:
        passed += 1
        print('PASS', name)
    else:
        failures.append(f'{name} {detail}')
        print('FAIL', name, detail)


def call(path, method='GET', body=None, token=None, headers=None, base=API):
    url = path if path.startswith('http') else base + path
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header('content-type', 'application/json')
    if token:
        request.add_header('authorization', f'Bearer {token}')
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            try:
                return response.status, json.loads(raw)
            except Exception:
                return response.status, {'raw': raw}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except Exception:
            return error.code, {'raw': raw}


def control(port, **config):
    call(f'http://127.0.0.1:{port}/__control', 'POST', config, base='')


def requests_seen(port):
    _, payload = call(f'http://127.0.0.1:{port}/__control', 'GET', base='')
    return payload.get('requests', [])


def all_requests_seen():
    """Requests observed on any stub, in call order.

    Which account the scheduler picks depends on live error history, so tests
    that only care about the forwarded payload must not pin a single port.
    """
    collected = []
    for port in (PORT_A, PORT_B, PORT_C):
        collected.extend(requests_seen(port))
    return collected


def reset_upstreams():
    for port in (PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, PORT_F, PORT_G):
        control(port, reset=True, status=200, stream=False, retry_after=None,
                reject_once=None, silent_refusal=None)


# ---------------------------------------------------------------- fixtures
for port in (PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, PORT_F, PORT_G):
    serve(port)
time.sleep(0.4)
print(f'stub upstreams ready on {PORT_A}, {PORT_B}, {PORT_C}, {PORT_D}, {PORT_E}, {PORT_F}, {PORT_G}')

call('/auth/setup', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
status, payload = call('/auth/login', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
token = payload.get('token')
check('admin login', bool(token), payload)
if not token:
    raise SystemExit('cannot continue without an admin token')

# Two groups: primary (priority 0) and backup (priority 10).
_, primary = call('/groups', 'POST', {'name': 'gw-primary', 'priority': 0, 'error_count_threshold': 3}, token=token)
_, backup = call('/groups', 'POST', {'name': 'gw-backup', 'priority': 10, 'error_count_threshold': 3}, token=token)
primary_id = primary.get('data', {}).get('id')
backup_id = backup.get('data', {}).get('id')

# Accounts now carry their own base_url and key; there is no channel layer.
account_ids = {}
for name, port, priority, group in (
    ('gw-a', PORT_A, 0, 'primary'),
    ('gw-b', PORT_B, 5, 'primary'),
    ('gw-c', PORT_C, 0, 'backup'),
):
    _, created = call('/accounts', 'POST', {
        'name': name, 'provider': 'openai', 'api_key': f'sk-account-{name}',
        'base_url': f'http://127.0.0.1:{port}',
        'group_id': primary_id if group == 'primary' else backup_id,
        'priority': priority,
    }, token=token)
    account_ids[name] = created.get('data', {}).get('id')

check('fixtures created', bool(primary_id and backup_id), f'groups={primary_id},{backup_id}')
check('three accounts created', all(account_ids.values()), account_ids)

_, key_payload = call('/keys', 'POST', {'name': 'gw-key', 'quota_limit': 0}, token=token)
client_key = key_payload.get('data', {}).get('key')
check('client api key issued', bool(client_key))

# ------------------------------------------------------- gateway auth gate
status, _ = call('/v1/chat/completions', 'POST', {'model': 'gpt-4o', 'messages': []}, base=BASE)
check('gateway rejects missing key', status == 401, status)

status, _ = call('/v1/chat/completions', 'POST', {'model': 'gpt-4o', 'messages': []},
                 token='sk-not-a-real-key', base=BASE)
check('gateway rejects unknown key', status == 401, status)

# --------------------------------------------------- happy path + priority
reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('chat completion succeeds', status == 200, (status, payload))
check('response came from priority-0 account', payload.get('id') == f'chatcmpl-{PORT_A}', payload.get('id'))
check('only the selected upstream was called', len(requests_seen(PORT_A)) == 1 and not requests_seen(PORT_B))

seen = requests_seen(PORT_A)[0]
check('account key forwarded to upstream', seen['authorization'] == 'Bearer sk-account-gw-a', seen['authorization'])

# Failover must forward the next account's own credential.
reset_upstreams()
control(PORT_A, status=500)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('failover produced a success', status == 200, (status, payload))
check('failover used the next account', payload.get('id') == f'chatcmpl-{PORT_B}', payload.get('id'))
b_seen = requests_seen(PORT_B)
check('account key forwarded on failover', bool(b_seen) and b_seen[0]['authorization'] == 'Bearer sk-account-gw-b',
      b_seen[0]['authorization'] if b_seen else None)

# 400 is a caller error and must NOT trigger failover.
reset_upstreams()
control(PORT_A, status=400)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
check('client error passes through', status == 400, status)
check('client error did not failover', len(requests_seen(PORT_B)) == 0, requests_seen(PORT_B))

# 429 should trigger failover.
reset_upstreams()
control(PORT_A, status=429)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('rate limit triggers failover', status == 200 and payload.get('id') == f'chatcmpl-{PORT_B}',
      (status, payload.get('id')))

# Account-level 4xx must switch accounts too. An expired key (401), an unpaid
# balance (402), a plan without access (403) and an upstream that does not serve
# the model (404) all describe the *credential*, not the request, so another
# account can serve them. Returning them to the caller left the dead account in
# rotation and made the gateway look broken.
#
# The assertion is that the caller never sees the upstream's status: whichever
# account is picked first, the answer must come from a working one. Checking the
# reply's origin rather than which port was touched keeps this stable even once
# the error window has circuit-broken the failing account.
for code in (401, 402, 403, 404, 409, 500, 502, 503, 529):
    reset_upstreams()
    control(PORT_A, status=code)
    status, payload = call('/v1/chat/completions', 'POST',
                           {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                           token=client_key, base=BASE)
    check(f'HTTP {code} switches accounts instead of reaching the client',
          status == 200 and payload.get('id') != f'chatcmpl-{PORT_A}',
          (status, payload.get('id')))

# The other half of the rule: a 4xx that describes the request must NOT be
# replayed. Retrying it produces the identical error on every account while
# burning each one's quota, so every upstream is set to the same status and the
# test asserts a single attempt was made in total.
for code in (400, 413, 422):
    reset_upstreams()
    for port in (PORT_A, PORT_B, PORT_C):
        control(port, status=code)
    status, _ = call('/v1/chat/completions', 'POST',
                     {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                     token=client_key, base=BASE)
    attempts = sum(len(requests_seen(port)) for port in (PORT_A, PORT_B, PORT_C))
    check(f'HTTP {code} is returned to the client', status == code, status)
    check(f'HTTP {code} is not replayed on another account', attempts == 1, attempts)

# Both primary accounts down -> must fall through to the backup group.
reset_upstreams()
control(PORT_A, status=500)
control(PORT_B, status=503)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('falls through to backup group', status == 200 and payload.get('id') == f'chatcmpl-{PORT_C}',
      (status, payload.get('id')))

# Every upstream down -> a single clear error, not a hang.
reset_upstreams()
for port in (PORT_A, PORT_B, PORT_C):
    control(port, status=500)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('all accounts failed reports an error', status >= 500, (status, payload))

# ------------------------------------------------------------ model mapping
reset_upstreams()
call('/models', 'POST', {
    'requested_model': 'fast', 'provider': 'openai',
    'upstream_model': 'gpt-4o-mini', 'group_id': primary_id,
}, token=token)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'fast', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
mapped = all_requests_seen()
check('mapped model rewritten upstream',
      status == 200 and bool(mapped) and mapped[0]['model'] == 'gpt-4o-mini',
      mapped[0]['model'] if mapped else None)

# Wildcard mapping: claude-* -> the upstream prefix plus the caller's suffix.
reset_upstreams()
call('/models', 'POST', {
    'requested_model': 'legacy-*', 'provider': 'openai',
    'upstream_model': 'gpt-4o-', 'group_id': primary_id,
}, token=token)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'legacy-turbo', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
wild = all_requests_seen()
check('wildcard mapping expands suffix',
      status == 200 and bool(wild) and wild[0]['model'] == 'gpt-4o-turbo',
      wild[0]['model'] if wild else None)

# ---------------------------------------------------------------- streaming
reset_upstreams()
request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                 data=json.dumps({'model': 'gpt-4o', 'stream': True,
                                                  'messages': [{'role': 'user', 'content': 'hi'}]}).encode())
request.add_header('content-type', 'application/json')
request.add_header('authorization', f'Bearer {client_key}')
with urllib.request.urlopen(request, timeout=30) as response:
    content_type = response.headers.get('content-type', '')
    stream_body = response.read().decode()
check('stream keeps SSE content type', 'text/event-stream' in content_type, content_type)
check('stream body carries sse frames', 'data:' in stream_body, stream_body[:80])
stream_seen = all_requests_seen()
check('upstream saw stream flag', bool(stream_seen) and stream_seen[0]['stream'] is True)

# ----------------------------------------------------- anthropic + messages
call('/accounts', 'POST', {
    'name': 'gw-anthropic-acct', 'provider': 'anthropic', 'api_key': 'sk-anthropic-acct',
    'base_url': f'http://127.0.0.1:{PORT_C}',
    'group_id': primary_id, 'client_spoofing': 'claude-code',
}, token=token)

reset_upstreams()
status, payload = call('/v1/messages', 'POST',
                       {'model': 'claude-3-5-sonnet-20241022', 'max_tokens': 32,
                        'messages': [{'role': 'user', 'content': 'hi'}]},
                       headers={'x-api-key': client_key, 'anthropic-version': '2023-06-01'},
                       base=BASE)
check('anthropic messages route works', status == 200, (status, payload))
claude_seen = requests_seen(PORT_C)
check('anthropic used x-api-key header',
      bool(claude_seen) and claude_seen[0]['x_api_key'] == 'sk-anthropic-acct',
      claude_seen[0]['x_api_key'] if claude_seen else None)
check('anthropic version header forwarded',
      bool(claude_seen) and claude_seen[0]['anthropic_version'] == '2023-06-01',
      claude_seen[0]['anthropic_version'] if claude_seen else None)
check('client spoofing applied',
      bool(claude_seen) and 'claude-cli' in (claude_seen[0]['user_agent'] or ''),
      claude_seen[0]['user_agent'] if claude_seen else None)
check('anthropic hit the messages path',
      bool(claude_seen) and '/v1/messages' in claude_seen[0]['path'],
      claude_seen[0]['path'] if claude_seen else None)

# --------------------------------------------------- disabled account skip
reset_upstreams()
call(f'/accounts/{account_ids["gw-a"]}', 'PUT', {'enabled': 0}, token=token)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('disabled account is skipped',
      status == 200 and payload.get('id') != f'chatcmpl-{PORT_A}' and not requests_seen(PORT_A),
      (status, payload.get('id')))
call(f'/accounts/{account_ids["gw-a"]}', 'PUT', {'enabled': 1}, token=token)

# --------------------------------------------- 429 Retry-After cooldown ---
# A rate-limited account must stay out of rotation for the advertised window.
# The fresh account below has priority 0 and a clean error window, so it is
# the one picked first; after its 429 + Retry-After the next request — with
# the stub healthy again — must be served by a different account.
_, cooled_created = call('/accounts', 'POST', {
    'name': 'gw-cooldown-acct', 'provider': 'openai', 'api_key': 'sk-cooldown-acct',
    'base_url': f'http://127.0.0.1:{PORT_D}',
    'group_id': primary_id, 'priority': 0,
}, token=token)
cooled_id = cooled_created.get('data', {}).get('id')
check('cooldown fixture created', bool(cooled_id), cooled_created)

reset_upstreams()
control(PORT_D, status=429, retry_after=60)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('429 fails over to another account', status == 200, (status, payload))
check('429 reply did not come from the limited account',
      payload.get('id') != f'chatcmpl-{PORT_D}', payload.get('id'))

reset_upstreams()  # stub is healthy again; only the cooldown keeps it out
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('rate-limited account stays cooled for the next request',
      status == 200 and payload.get('id') != f'chatcmpl-{PORT_D}', (status, payload.get('id')))

# ------------------------------------------------ sticky session routing --
# Two fresh equal-priority accounts on a clean window: with nothing else to
# distinguish them, only the session key decides. Without sticky routing the
# LRU tie-break would rotate every turn, so this fails if stickiness regresses.
_, sticky_one = call('/accounts', 'POST', {
    'name': 'gw-sticky-1', 'provider': 'openai', 'api_key': 'sk-sticky-1',
    'base_url': f'http://127.0.0.1:{PORT_D}',
    'group_id': primary_id, 'priority': 0,
}, token=token)
_, sticky_two = call('/accounts', 'POST', {
    'name': 'gw-sticky-2', 'provider': 'openai', 'api_key': 'sk-sticky-2',
    'base_url': f'http://127.0.0.1:{PORT_E}',
    'group_id': primary_id, 'priority': 0,
}, token=token)
check('sticky fixtures created',
      bool(sticky_one.get('data', {}).get('id') and sticky_two.get('data', {}).get('id')))

reset_upstreams()
sticky_ports = []
for turn in range(4):
    status, payload = call('/v1/chat/completions', 'POST',
                           {'model': 'gpt-4o', 'prompt_cache_key': 'sess-sticky-e2e',
                            'messages': [{'role': 'user', 'content': f'turn {turn}'}]},
                           token=client_key, base=BASE)
    if status != 200:
        break
    try:
        sticky_ports.append(int(str(payload.get('id', '')).rsplit('-', 1)[-1]))
    except ValueError:
        sticky_ports.append(None)
check('sticky session turns all succeeded', len(sticky_ports) == 4, (status, sticky_ports))
check('same session key lands on one account across turns',
      len(sticky_ports) == 4 and len(set(sticky_ports)) == 1, sticky_ports)
if sticky_ports:
    landed = requests_seen(sticky_ports[-1])
    check('sticky turn was served by a sticky credential',
          bool(landed) and landed[-1].get('authorization') in ('Bearer sk-sticky-1', 'Bearer sk-sticky-2'),
          landed[-1].get('authorization') if landed else None)

# ------------------------------------------------------ usage + model probe
status, payload = call('/v1/models', token=client_key, base=BASE)
check('models probe lists ids', status == 200 and bool(payload.get('data')), status)

status, payload = call('/usage?limit=200', token=token)
records = payload.get('data', [])
check('usage records were written', status == 200 and len(records) > 0, len(records))
check('usage captured token counts', any(num for num in (r.get('total_tokens') or 0 for r in records) if num > 0))
check('usage captured latency', any((r.get('latency_ms') or 0) > 0 for r in records))

status, payload = call('/stats?hours=24', token=token)
totals = payload.get('data', {}).get('totals', {})
check('stats aggregates requests', status == 200 and int(totals.get('total_requests') or 0) > 0,
      totals.get('total_requests'))

# ------------------------------------------------------- connection tester
reset_upstreams()
status, payload = call(f'/accounts/{account_ids["gw-a"]}/test', 'POST', token=token)
check('account connection test succeeds', status == 200 and payload.get('success') is True, payload)

control(PORT_A, status=401)
status, payload = call(f'/accounts/{account_ids["gw-a"]}/test', 'POST', token=token)
check('account connection test reports failure', status == 200 and payload.get('success') is False, payload)

# ------------------------------------------- chat -> responses bridge (opencode)
# muse-spark only exists on /v1/responses upstream, but the client speaks
# /v1/chat/completions: the gateway must convert the request, hit the
# Responses endpoint, and convert the reply (and stream) back to chat shape.
_, opencode_created = call('/accounts', 'POST', {
    'name': 'gw-opencode-acct', 'provider': 'opencode_go', 'api_key': 'sk-opencode-acct',
    'base_url': f'http://127.0.0.1:{PORT_C}',
    'group_id': primary_id, 'priority': 0,
}, token=token)
opencode_acct_id = opencode_created.get('data', {}).get('id')
# The mapping pins the model to the opencode_go provider so account selection
# is deterministic regardless of the other accounts' error history.
call('/models', 'POST', {
    'requested_model': 'muse-spark-1.3', 'provider': 'opencode_go',
    'upstream_model': 'muse-spark-1.3', 'group_id': primary_id,
}, token=token)

reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'muse-spark-1.3', 'stream': False,
                        'prompt_cache_key': 'sess-e2e-bridge',
                        'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('bridged chat request returns 200', status == 200, (status, payload))
check('bridged reply is a chat.completion', payload.get('object') == 'chat.completion', payload.get('object'))
check('bridged reply keeps the client model', payload.get('model') == 'muse-spark-1.3', payload.get('model'))
check('bridged reply content came back', payload.get('choices', [{}])[0].get('message', {}).get('content') == 'from-responses',
      payload.get('choices'))
check('bridged reply usage mapped from responses usage',
      payload.get('usage', {}).get('prompt_tokens') == 7 and payload.get('usage', {}).get('completion_tokens') == 3,
      payload.get('usage'))

bridge_seen = requests_seen(PORT_C)
bridge_seen = [r for r in bridge_seen if r.get('model') == 'muse-spark-1.3']
check('upstream was called on /v1/responses',
      bool(bridge_seen) and bridge_seen[-1]['path'].endswith('/v1/responses'),
      bridge_seen[-1]['path'] if bridge_seen else None)
check('request was converted to input (no messages)',
      bool(bridge_seen) and bridge_seen[-1]['has_input'] and not bridge_seen[-1]['has_messages'],
      bridge_seen[-1] if bridge_seen else None)
check('upstream always streams (bridge buffers for the client)',
      bool(bridge_seen) and bridge_seen[-1]['stream'] is True)
check('opencode session header forwarded from prompt_cache_key',
      bool(bridge_seen) and bridge_seen[-1]['x_opencode_session'] == 'sess-e2e-bridge',
      bridge_seen[-1]['x_opencode_session'] if bridge_seen else None)
check('opencode user agent applied',
      bool(bridge_seen) and bridge_seen[-1]['user_agent'] == 'opencode/1.0.0',
      bridge_seen[-1]['user_agent'] if bridge_seen else None)

# Streaming client: responses SSE must be re-emitted as chat chunks + [DONE].
reset_upstreams()
request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                 data=json.dumps({'model': 'muse-spark-1.3', 'stream': True,
                                                  'prompt_cache_key': 'sess-e2e-bridge',
                                                  'messages': [{'role': 'user', 'content': 'hi'}]}).encode())
request.add_header('content-type', 'application/json')
request.add_header('authorization', f'Bearer {client_key}')
with urllib.request.urlopen(request, timeout=30) as response:
    content_type = response.headers.get('content-type', '')
    bridge_stream = response.read().decode()
check('bridged stream keeps SSE content type', 'text/event-stream' in content_type, content_type)
check('bridged stream emits chat chunks', 'chat.completion.chunk' in bridge_stream, bridge_stream[:120])
check('bridged stream forwards text delta', 'from-responses' in bridge_stream, bridge_stream[:400])
check('bridged stream ends with [DONE]', bridge_stream.rstrip().endswith('data: [DONE]'), bridge_stream[-80:])
check('bridged stream carries usage for billing', '"prompt_tokens":7' in bridge_stream, bridge_stream[-300:])

status, payload = call('/usage?limit=200', token=token)
bridge_usage = [r for r in payload.get('data', []) if r.get('model') == 'muse-spark-1.3']
check('bridge calls are usage-recorded', len(bridge_usage) > 0, len(bridge_usage))
check('bridge usage captured tokens', any((r.get('prompt_tokens') or 0) > 0 for r in bridge_usage), bridge_usage)

# Agent-style tool call round trip: client sends tools + a forced (nested)
# tool_choice, the stub replies with a function call, the client must get it
# back as chat tool_calls with finish_reason=tool_calls.
agent_tools = [{'type': 'function', 'function': {
    'name': 'get_weather', 'description': 'd', 'parameters': {'type': 'object'}}}]
reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST', {
    'model': 'muse-spark-1.3', 'prompt_cache_key': 'sess-e2e-bridge',
    'messages': [{'role': 'user', 'content': 'weather?'}],
    'tools': agent_tools,
    'tool_choice': {'type': 'function', 'function': {'name': 'get_weather'}},
}, token=client_key, base=BASE)
choice = (payload.get('choices') or [{}])[0]
tool_calls = (choice.get('message') or {}).get('tool_calls') or []
check('agent tool call round-trip (non-stream)',
      status == 200 and choice.get('finish_reason') == 'tool_calls'
      and tool_calls and tool_calls[0].get('function', {}).get('name') == 'get_weather',
      (status, choice))
check('agent tool call arguments survive the round trip',
      bool(tool_calls) and tool_calls[0].get('function', {}).get('arguments') == '{"city":"SF"}',
      tool_calls)
agent_seen = [r for r in requests_seen(PORT_C) if r.get('model') == 'muse-spark-1.3']
check('agent request reached upstream with tools',
      bool(agent_seen) and agent_seen[-1].get('has_tools') is True,
      agent_seen[-1] if agent_seen else None)
check('nested tool_choice flattened before upstream',
      bool(agent_seen) and agent_seen[-1].get('tool_choice') == {'type': 'function', 'name': 'get_weather'},
      agent_seen[-1].get('tool_choice') if agent_seen else None)

# Same round trip over SSE: announce + arg deltas + tool_calls finish chunk.
reset_upstreams()
request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                 data=json.dumps({'model': 'muse-spark-1.3', 'stream': True,
                                                  'prompt_cache_key': 'sess-e2e-bridge',
                                                  'messages': [{'role': 'user', 'content': 'weather?'}],
                                                  'tools': agent_tools,
                                                  'tool_choice': 'auto'}).encode())
request.add_header('content-type', 'application/json')
request.add_header('authorization', f'Bearer {client_key}')
with urllib.request.urlopen(request, timeout=30) as response:
    agent_stream = response.read().decode()
# Reassemble the tool call the way an agent would: announce + arg fragments.
tool_announced = False
tool_args = ''
finish = None
for line in agent_stream.splitlines():
    if not line.startswith('data: ') or line == 'data: [DONE]':
        continue
    evt = json.loads(line[len('data: '):])
    if evt.get('object') != 'chat.completion.chunk':
        continue
    for chunk_choice in evt.get('choices') or []:
        for tool_call in (chunk_choice.get('delta') or {}).get('tool_calls') or []:
            fn = tool_call.get('function') or {}
            if fn.get('name'):
                tool_announced = True
            tool_args += fn.get('arguments') or ''
        if chunk_choice.get('finish_reason'):
            finish = chunk_choice['finish_reason']
check('agent stream announces the tool call', tool_announced, tool_announced)
check('agent stream tool arguments reconstruct exactly', tool_args == '{"city":"SF"}', tool_args)
check('agent stream finishes with tool_calls', finish == 'tool_calls', finish)
check('agent stream ends with [DONE]', agent_stream.rstrip().endswith('data: [DONE]'), agent_stream[-80:])

# A client that sends no session signal at all (third-party harness: no
# x-opencode-session, no prompt_cache_key) must still get ONE stable session
# per conversation. A per-request random UUID makes every turn look like a new
# conversation, which silently disables upstream prompt caching.
reset_upstreams()
session_seen = []
for opening in ('Fix the failing test', 'Fix the failing test', 'Write a parser'):
    call('/v1/chat/completions', 'POST',
         {'model': 'muse-spark-1.3',
          'messages': [{'role': 'system', 'content': 'You are a helpful agent.'},
                       {'role': 'user', 'content': opening}]},
         token=client_key, base=BASE)
    no_signal = [r for r in requests_seen(PORT_C) if r.get('model') == 'muse-spark-1.3']
    session_seen.append(no_signal[-1]['x_opencode_session'] if no_signal else None)
check('no-signal request still carries a session', all(session_seen), session_seen)
check('same conversation keeps one session across turns',
      session_seen[0] is not None and session_seen[0] == session_seen[1], session_seen)
check('different conversation gets a different session',
      session_seen[0] is not None and session_seen[0] != session_seen[2], session_seen)
check('derived session uses the content-seed prefix',
      (session_seen[0] or '').startswith('compat_cs_'), session_seen)

# The account's upstream catalogue carries each model's native message format,
# and downstream GET /v1/models must then list every cached model — not just
# the configured mappings — with the same format label.
status, payload = call(f'/accounts/{opencode_acct_id}/models', token=token)
catalog_rows = (payload.get('data') or {}).get('models') or []
check('account catalogue fetch succeeds',
      status == 200 and len(catalog_rows) >= 2, (status, payload))
check('catalogue entries carry their message format',
      all(row.get('protocol') for row in catalog_rows), catalog_rows)

status, payload = call('/v1/models', token=client_key, base=BASE)
downstream = {row.get('id'): row for row in payload.get('data') or []}
check('downstream list includes the cached upstream catalogue',
      'stub-model' in downstream and 'stub-model-2' in downstream, list(downstream))
check('downstream catalogue models are format-labelled',
      downstream.get('stub-model', {}).get('protocol') == 'chat_completions',
      downstream.get('stub-model'))
check('downstream list keeps the configured models format-labelled',
      'muse-spark-1.3' in downstream and downstream['muse-spark-1.3'].get('protocol') == 'responses',
      downstream.get('muse-spark-1.3'))

# Chat-native models on the same account must NOT be bridged (glm speaks chat).
call('/models', 'POST', {
    'requested_model': 'glm-5.3', 'provider': 'opencode_go',
    'upstream_model': 'glm-5.3', 'group_id': primary_id,
}, token=token)
reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'glm-5.3', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
glm_seen = [r for r in requests_seen(PORT_C) if r.get('model') == 'glm-5.3']
check('chat-native model keeps the direct chat path',
      status == 200 and bool(glm_seen) and glm_seen[0]['path'].endswith('/chat/completions') and glm_seen[0]['has_messages'],
      (status, glm_seen[0] if glm_seen else None))

# Account-owned rules replace the built-in table wholesale (Go:
# credentials.protocol_rules): pinning glm-* to responses bridges the same
# chat request, and clearing the field puts the defaults back in charge.
status, payload = call(f'/accounts/{opencode_acct_id}', 'PUT',
                       {'protocol_rules': '[{"pattern":"glm-*","protocol":"responses"}]'},
                       token=token)
check('account protocol rules save',
      status == 200 and 'glm-*' in (payload.get('data', {}).get('protocol_rules') or ''),
      (status, payload))

reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'glm-5.3', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
glm_rules_seen = [r for r in requests_seen(PORT_C) if r.get('model') == 'glm-5.3']
check('account rules bridge what the defaults kept direct',
      status == 200 and bool(glm_rules_seen) and glm_rules_seen[-1]['path'].endswith('/v1/responses'),
      glm_rules_seen[-1]['path'] if glm_rules_seen else status)

status, payload = call(f'/accounts/{opencode_acct_id}', 'PUT',
                       {'protocol_rules': ''}, token=token)
check('clearing the rules restores the defaults',
      status == 200 and not payload.get('data', {}).get('protocol_rules'), (status, payload))

reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'glm-5.3', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
glm_cleared = [r for r in requests_seen(PORT_C) if r.get('model') == 'glm-5.3']
check('cleared rules put glm back on the direct chat path',
      status == 200 and bool(glm_cleared) and glm_cleared[-1]['path'].endswith('/chat/completions'),
      glm_cleared[-1]['path'] if glm_cleared else status)

# The connection-test probe must speak each model's native protocol, otherwise
# picking muse-spark in the dialog reports a healthy credential as dead
# (HTTP 400 "Model does not support this protocol").
reset_upstreams()
status, payload = call(f'/accounts/{opencode_acct_id}/test', 'POST',
                       {'model': 'muse-spark-1.3'}, token=token)
check('probe of a responses-native model succeeds', status == 200 and payload.get('success') is True, payload)
muse_probe = [r for r in requests_seen(PORT_C) if r.get('model') == 'muse-spark-1.3']
check('responses-native probe hit /v1/responses',
      bool(muse_probe) and muse_probe[0]['path'].endswith('/v1/responses'),
      muse_probe[0]['path'] if muse_probe else None)

reset_upstreams()
status, payload = call(f'/accounts/{opencode_acct_id}/test', 'POST',
                       {'model': 'minimax-m3'}, token=token)
check('probe of an anthropic-native model succeeds', status == 200 and payload.get('success') is True, payload)
mini_probe = [r for r in requests_seen(PORT_C) if r.get('model') == 'minimax-m3']
check('anthropic-native probe hit /v1/messages',
      bool(mini_probe) and mini_probe[0]['path'].endswith('/v1/messages'),
      mini_probe[0]['path'] if mini_probe else None)

reset_upstreams()
status, payload = call(f'/accounts/{opencode_acct_id}/test', 'POST',
                       {'model': 'deepseek-v4-pro'}, token=token)
check('probe of a chat-native model succeeds', status == 200 and payload.get('success') is True, payload)
ds_probe = [r for r in requests_seen(PORT_C) if r.get('model') == 'deepseek-v4-pro']
check('chat-native probe hit /v1/chat/completions',
      bool(ds_probe) and ds_probe[0]['path'].endswith('/chat/completions'),
      ds_probe[0]['path'] if ds_probe else None)

# ----------------------------------------- Responses 400 field-strip retry --
# A relay that rejects max_output_tokens by name must be served, not handed a
# hard 400: the gateway drops exactly the named field and re-sends once. The
# priority -1 account pins the fixture to PORT_F so "which stub saw what" is
# not left to scheduler tie-breaks.
_, strip_created = call('/accounts', 'POST', {
    'name': 'gw-strip-acct', 'provider': 'openai', 'api_key': 'sk-strip-acct',
    'base_url': f'http://127.0.0.1:{PORT_F}',
    'group_id': primary_id, 'priority': -1,
}, token=token)
check('strip fixture created', bool(strip_created.get('data', {}).get('id')), strip_created)

reset_upstreams()
control(PORT_F, reject_once={'param': 'max_output_tokens'})
status, payload = call('/v1/responses', 'POST',
                       {'model': 'gpt-5', 'input': 'hi', 'max_output_tokens': 64},
                       token=client_key, base=BASE)
check('field-strip retry turns the 400 into a served response',
      status == 200 and payload.get('status') == 'completed', (status, payload))
strip_seen = requests_seen(PORT_F)
check('rejected attempt and rewritten re-send both reached upstream',
      len(strip_seen) == 2, len(strip_seen))
if len(strip_seen) == 2:
    check('first attempt carried the rejected field',
          strip_seen[0].get('max_output_tokens') == 64, strip_seen[0])
    check('re-send dropped the rejected field',
          strip_seen[1].get('max_output_tokens') is None, strip_seen[1])
    check('re-send stayed on the responses endpoint',
          strip_seen[0]['path'].endswith('/v1/responses') and strip_seen[1]['path'].endswith('/v1/responses'),
          (strip_seen[0]['path'], strip_seen[1]['path']))

# An unstrippable 400 must still reach the client as-is: no rewrite, no
# second upstream call. Every stub answers 400 so the assertion does not
# depend on which account the scheduler picks.
reset_upstreams()
for port in (PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, PORT_F):
    control(port, status=400)
status, payload = call('/v1/responses', 'POST',
                       {'model': 'gpt-5', 'input': 'hi'},
                       token=client_key, base=BASE)
check('non-strippable 400 passes through to the client',
      status == 400, (status, payload))
total_hits = sum(len(requests_seen(port)) for port in (PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, PORT_F, PORT_G))
check('non-strippable 400 was sent upstream exactly once',
      total_hits == 1, total_hits)
reset_upstreams()

# ------------------------------------------- OpenAI silent-refusal failover --
# A long request answered with a stream that stops on finish_reason=stop with
# nothing in it must fail over, not be served (Go: openai_silent_refusal.go).
# The priority -2 account pins the fixture to PORT_G; detection only arms at
# 64KB, so the same empty stream under that gate reaches the client untouched.
_, refusal_created = call('/accounts', 'POST', {
    'name': 'gw-refuse-acct', 'provider': 'openai', 'api_key': 'sk-refuse-acct',
    'base_url': f'http://127.0.0.1:{PORT_G}',
    'group_id': primary_id, 'priority': -2,
}, token=token)
check('refusal fixture created', bool(refusal_created.get('data', {}).get('id')), refusal_created)


def stream_chat(body):
    request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                     data=json.dumps(body).encode())
    request.add_header('content-type', 'application/json')
    request.add_header('authorization', f'Bearer {client_key}')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


reset_upstreams()
control(PORT_G, silent_refusal=True)
status, raw = stream_chat({'model': 'gpt-4o', 'stream': True,
                           'messages': [{'role': 'user', 'content': 'hi'}]})
check('a short prompt keeps the empty stream as-is',
      status == 200 and 'finish_reason": "stop"' in raw and '"content"' not in raw,
      (status, raw[:200]))
check('short prompt still reached the refusal upstream',
      len(requests_seen(PORT_G)) == 1, len(requests_seen(PORT_G)))

# The same empty stream above the gate must never reach the client: the
# attempt fails and a healthy account serves the response instead. Run while
# the fixture is still clean, so priority -2 pins the first attempt to PORT_G.
reset_upstreams()
control(PORT_G, silent_refusal=True)
status, raw = stream_chat({
    'model': 'gpt-4o', 'stream': True,
    'messages': [{'role': 'user', 'content': 'x' * 70000}],
})
check('silent refusal fails over to a healthy account',
      status == 200 and '"content"' in raw, (status, raw[:200]))
refusal_hits = requests_seen(PORT_G)
check('refusal upstream was tried exactly once', len(refusal_hits) == 1, len(refusal_hits))
check('refusal upstream saw a streaming request',
      bool(refusal_hits) and refusal_hits[0]['stream'] is True and refusal_hits[0]['has_messages'],
      refusal_hits[0] if refusal_hits else None)
reset_upstreams()

# ------------------------------------------- group model allowlist (admin) ---
# A key's group may pin which models it can list, retrieve and generate
# (Go: group_model_allowlist.go). The suite's own key is deliberately
# unpinned (no group → no allowlist), so this section pins one. Run last: it
# narrows the key it uses, and every case restores the gate before the next.
_, pinned_payload = call('/keys', 'POST',
                         {'name': 'gw-allowlist-key', 'quota_limit': 0, 'group_id': primary_id},
                         token=token)
pinned_key = pinned_payload.get('data', {}).get('key')
check('pinned client api key issued', bool(pinned_key), pinned_payload)

status, payload = call('/v1/models', token=pinned_key, base=BASE)
unfiltered_ids = [m.get('id') for m in payload.get('data', [])]
check('model list starts unfiltered',
      'gpt-4o' in unfiltered_ids and 'claude-3-5-sonnet-20241022' in unfiltered_ids,
      unfiltered_ids)
status, payload = call('/v1/models/claude-3-5-sonnet-20241022', token=pinned_key, base=BASE)
check('a model outside any allowlist retrieves first',
      status == 200 and payload.get('id') == 'claude-3-5-sonnet-20241022', (status, payload))

status, payload = call(f'/groups/{primary_id}', 'PUT',
                       {'model_allowlist_enabled': 1, 'model_allowlist': [' gpt-4o ', 'GPT-4O']},
                       token=token)
check('group allowlist saved normalized',
      status == 200 and payload.get('data', {}).get('model_allowlist') == '["gpt-4o"]',
      (status, payload.get('data', {}).get('model_allowlist')))

status, payload = call('/v1/models', token=pinned_key, base=BASE)
filtered_ids = [m.get('id') for m in payload.get('data', [])]
check('model list shows only allowed models', filtered_ids == ['gpt-4o'], filtered_ids)

status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=pinned_key, base=BASE)
check('allowed model still generates', status == 200, (status, payload))

status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'claude-3-5-sonnet-20241022', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=pinned_key, base=BASE)
check('listed-out model is a 404 model_not_found',
      status == 404 and payload.get('error', {}).get('code') == 'model_not_found'
      and 'not available for this group' in payload.get('error', {}).get('message', ''),
      (status, payload))

status, payload = call('/v1/models/gpt-4o', token=pinned_key, base=BASE)
check('allowed model retrieves', status == 200 and payload.get('id') == 'gpt-4o', (status, payload))
status, payload = call('/v1/models/claude-3-5-sonnet-20241022', token=pinned_key, base=BASE)
check('listed-out model reads as missing',
      status == 404 and payload.get('error', {}).get('code') == 'model_not_found', (status, payload))

status, payload = call(f'/groups/{primary_id}', 'PUT', {'model_allowlist': []}, token=token)
check('enabling with an empty allowlist is rejected', status == 400, (status, payload))
status, payload = call(f'/groups/{primary_id}', 'PUT', {'model_allowlist': ['gpt-*-turbo']}, token=token)
check('mid-string wildcards are rejected', status == 400, (status, payload))

call(f'/groups/{primary_id}', 'PUT', {'model_allowlist': ['gpt-*']}, token=token)
status, payload = call('/v1/models', token=pinned_key, base=BASE)
wildcard_ids = [m.get('id') for m in payload.get('data', [])]
check('trailing wildcards admit every prefixed model',
      'gpt-4o' in wildcard_ids and 'claude-3-5-sonnet-20241022' not in wildcard_ids,
      wildcard_ids)

call(f'/groups/{primary_id}', 'PUT',
     {'model_allowlist_enabled': 0, 'model_allowlist': []}, token=token)
status, payload = call('/v1/models', token=pinned_key, base=BASE)
restored_ids = [m.get('id') for m in payload.get('data', [])]
check('disabling the allowlist restores the full list',
      status == 200 and len(restored_ids) > len(wildcard_ids), (status, restored_ids))

print()
print(f'PASSED {passed} / {passed + len(failures)}')
if failures:
    print('FAILURES:')
    for failure in failures:
        print(' -', failure)
    raise SystemExit(1)
