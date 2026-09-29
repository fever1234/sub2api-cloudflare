"""Fake upstream provider used by tests/gateway.test.py.

Each instance listens on its own port so a test can tell which account the
gateway actually selected. `POST /__control` sets the next response status or
toggles streaming; `GET /__control` returns the requests that arrived, so a test
can assert on the forwarded model name, auth header and path.

The gateway forwards bodies as a ReadableStream, which reaches us as
`Transfer-Encoding: chunked` with no Content-Length. The body reader below
handles both framings; reading the chunked body fully also drains the socket,
which otherwise shows up in the worker as "Network connection lost".
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {}


def _blank():
    return {'status': 200, 'requests': [], 'stream': False, 'retry_after': None, 'reject_once': None,
            'silent_refusal': False}


def _count_cache_control(node, depth=0):
    """Count cache_control markers in a parsed request body."""
    if depth > 6:
        return 0
    if isinstance(node, dict):
        total = 1 if node.get('cache_control') else 0
        return total + sum(_count_cache_control(value, depth + 1) for value in node.values())
    if isinstance(node, list):
        return sum(_count_cache_control(item, depth + 1) for item in node)
    return 0


class Handler(BaseHTTPRequestHandler):
    # Chunked request bodies require HTTP/1.1.
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _port(self):
        return self.server.server_address[1]

    def _read_body(self):
        encoding = (self.headers.get('transfer-encoding') or '').lower()
        if 'chunked' in encoding:
            chunks = []
            while True:
                line = self.rfile.readline().strip()
                if not line:
                    break
                try:
                    size = int(line.split(b';')[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()  # trailing CRLF
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()  # CRLF after each chunk
            return b''.join(chunks)

        length = int(self.headers.get('content-length') or 0)
        return self.rfile.read(length) if length else b''

    def _send(self, status, payload, retry_after=None):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        if retry_after is not None:
            self.send_header('Retry-After', str(retry_after))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        port = self._port()
        # OpenCode Go usage endpoint. Bound via OPENCODE_USAGE_URL (port 9108)
        # so the auto-refresh hits this stub instead of opencode.ai; recorded
        # separately so model-list request assertions are not disturbed.
        if self.path.split('?')[0].endswith('/usage'):
            with LOCK:
                state = STATE.setdefault(port, _blank())
                state.setdefault('usage', []).append({'authorization': self.headers.get('authorization')})
            raw = json.dumps({'usage': {
                'rolling': {'status': 'ok', 'percent': 12.5, 'resetsAt': '2026-09-28T16:00:00Z'},
                'weekly': {'status': 'ok', 'percent': 34.0, 'resetsAt': '2026-10-01T00:00:00Z'},
                'monthly': {'status': 'ok', 'percent': 56.0, 'resetsAt': '2026-10-15T00:00:00Z'},
            }}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        with LOCK:
            state = STATE.setdefault(port, _blank())
            if self.path.startswith('/__control'):
                return self._send(200, {'requests': list(state['requests'])})
            # Recorded like a POST so a test can prove the model list was served
            # from the cached copy rather than re-fetched on every dialog open.
            state['requests'].append({
                'path': self.path,
                'method': 'GET',
                'model': None,
                'stream': False,
                'authorization': self.headers.get('authorization'),
                'x_api_key': self.headers.get('x-api-key'),
            })
            status = state['status']
        # Provider "list models" probe used by the account connection test.
        return self._send(status if status >= 400 else 200,
                          {'object': 'list', 'data': [{'id': 'stub-model'}, {'id': 'stub-model-2'}]})

    def do_POST(self):
        port = self._port()
        raw = self._read_body()

        if self.path.startswith('/__control'):
            config = json.loads(raw or b'{}')
            with LOCK:
                state = STATE.setdefault(port, _blank())
                if config.get('reset'):
                    state['requests'] = []
                if 'status' in config:
                    state['status'] = int(config['status'])
                if 'stream' in config:
                    state['stream'] = bool(config['stream'])
                if 'retry_after' in config:
                    state['retry_after'] = config['retry_after']
                if 'reject_once' in config:
                    # One-shot 400 naming a field the request carries: exercises
                    # the gateway's Responses field-strip-and-retry.
                    state['reject_once'] = config['reject_once']
                if 'silent_refusal' in config:
                    # Stream that ends on finish_reason=stop with nothing in it:
                    # exercises the OpenAI silent-refusal failover.
                    state['silent_refusal'] = bool(config['silent_refusal'])
            return self._send(200, {'ok': True})

        try:
            body = json.loads(raw or b'{}')
        except Exception:
            body = {}

        with LOCK:
            state = STATE.setdefault(port, _blank())
            state['requests'].append({
                'path': self.path,
                'model': body.get('model'),
                'stream': bool(body.get('stream')),
                # When the gateway forces usage reporting it must set this even
                # though the client did not: real providers omit usage frames
                # otherwise and streamed calls would bill at zero tokens.
                'stream_options': body.get('stream_options'),
                'authorization': self.headers.get('authorization'),
                'x_api_key': self.headers.get('x-api-key'),
                'user_agent': self.headers.get('user-agent'),
                'anthropic_version': self.headers.get('anthropic-version'),
                # opencode_go requires this header on every inference call.
                'x_opencode_session': self.headers.get('x-opencode-session'),
                # Proves the chat→responses conversion actually happened.
                'has_messages': 'messages' in body,
                'has_input': 'input' in body,
                'has_tools': 'tools' in body,
                'tool_choice': body.get('tool_choice'),
                # Anthropic prompt-cache breakpoints, when the gateway injects them.
                'cache_control_count': _count_cache_control(body),
                # Field-strip-and-retry visibility: the rejected request carries
                # the field, the rewritten re-send must not.
                'max_output_tokens': body.get('max_output_tokens'),
            })
            status = state['status']
            want_stream = state['stream']
            retry_after = state['retry_after']
            reject_once = state.get('reject_once')
            if reject_once and reject_once.get('param') in body:
                state['reject_once'] = None
            else:
                reject_once = None
            silent_refusal = state.get('silent_refusal')

        if reject_once:
            return self._send(400, {
                'error': {
                    'message': reject_once.get('message') or f"Unknown parameter: '{reject_once['param']}'.",
                    'code': reject_once.get('code', 'unknown_parameter'),
                    'param': reject_once['param'],
                }
            })

        if status >= 400:
            return self._send(status, {'error': {'message': f'stub failure {status}', 'type': 'stub'}},
                              retry_after=retry_after)

        # Token-count preflight: reply in the count shape (not the message
        # shape below), and keep the recorded path so a test can prove the
        # gateway forwarded /count_tokens instead of rewriting it to
        # /v1/messages — a rewrite turns a free count into a generation.
        # The relay may append its own query (?beta=true), so route on the
        # path alone, the way the assertions read the recorded hit.
        if self.path.split('?')[0].endswith('/count_tokens'):
            return self._send(200, {'input_tokens': 42})

        # Responses-native models (muse-spark/grok/gpt) arrive on /v1/responses
        # via the chat bridge; reply in the Responses shape so the test can
        # assert the gateway converted it back for the client.
        if self.path.endswith('/responses'):
            # Agent-style requests carry tools: answer with a function call so
            # the round-trip (tool_calls streaming + finish_reason) is exercised.
            wants_tool_call = bool(body.get('tools'))
            tool_output = ([{
                'type': 'function_call', 'call_id': 'call_stub_1', 'name': 'get_weather',
                'arguments': '{"city":"SF"}',
            }] if wants_tool_call else [])
            final_output = tool_output or [{
                'type': 'message', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': 'from-responses'}],
            }]
            if want_stream or body.get('stream'):
                if silent_refusal:
                    # Empty completed stream: no output, no usage — the Responses
                    # shape of a silent upstream refusal.
                    frames = [
                        'data: ' + json.dumps({'type': 'response.created',
                                               'response': {'id': f'resp-{port}', 'model': body.get('model'),
                                                            'status': 'in_progress'}}),
                        'data: ' + json.dumps({'type': 'response.completed',
                                               'response': {'id': f'resp-{port}', 'model': body.get('model'),
                                                            'status': 'completed', 'output': []}}),
                    ]
                    payload = ('\n\n'.join(frames) + '\n\n').encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                frames = [
                    'data: ' + json.dumps({'type': 'response.created',
                                           'response': {'id': f'resp-{port}', 'model': body.get('model'),
                                                        'status': 'in_progress'}}),
                    'data: ' + json.dumps({'type': 'response.output_text.delta', 'delta': 'from-responses'}),
                ]
                if wants_tool_call:
                    frames += [
                        'data: ' + json.dumps({'type': 'response.output_item.added', 'output_index': 1,
                                               'item': {'type': 'function_call', 'call_id': 'call_stub_1',
                                                        'name': 'get_weather'}}),
                        'data: ' + json.dumps({'type': 'response.function_call_arguments.delta',
                                               'output_index': 1, 'delta': '{"city":'}),
                        'data: ' + json.dumps({'type': 'response.function_call_arguments.delta',
                                               'output_index': 1, 'delta': '"SF"}'}),
                        'data: ' + json.dumps({'type': 'response.function_call_arguments.done',
                                               'output_index': 1, 'arguments': '{"city":"SF"}'}),
                    ]
                frames.append(
                    'data: ' + json.dumps({'type': 'response.completed',
                                           'response': {
                                               'id': f'resp-{port}', 'model': body.get('model'),
                                               'status': 'completed',
                                               'output': final_output,
                                               'usage': {'input_tokens': 7, 'output_tokens': 3, 'total_tokens': 10},
                                           }}),
                )
                payload = ('\n\n'.join(frames) + '\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            return self._send(200, {
                'id': f'resp-{port}', 'model': body.get('model'), 'status': 'completed',
                'output': final_output,
                'usage': {'input_tokens': 7, 'output_tokens': 3, 'total_tokens': 10},
            })

        if want_stream or body.get('stream'):
            if silent_refusal:
                # finish_reason=stop with no content, no usage: the chat shape
                # of a silent upstream refusal.
                frames = [
                    'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                           'choices': [{'index': 0, 'delta': {'role': 'assistant'},
                                                        'finish_reason': None}]}),
                    'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                           'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}),
                    'data: [DONE]',
                ]
                payload = ('\n\n'.join(frames) + '\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            # Real providers report usage in a late frame: OpenAI sends a final
            # chunk carrying `usage`, Anthropic a `message_delta`. The gateway
            # parses that frame to record streamed usage, so the stub must send
            # one or the test would assert against data no provider omitted.
            frames = [
                'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                       'choices': [{'index': 0, 'delta': {'content': 'hi'}}]}),
                'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                       'choices': [],
                                       'usage': {'prompt_tokens': 11, 'completion_tokens': 5,
                                                 'total_tokens': 16}}),
                'data: [DONE]',
            ]
            payload = ('\n\n'.join(frames) + '\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # Anthropic-shaped response when the caller used the messages endpoint.
        if 'messages' in self.path:
            return self._send(200, {
                'id': f'msg-{port}', 'type': 'message', 'role': 'assistant',
                'model': body.get('model'),
                'content': [{'type': 'text', 'text': f'from-{port}'}],
                'usage': {'input_tokens': 9, 'output_tokens': 4},
            })

        return self._send(200, {
            'id': f'chatcmpl-{port}', 'object': 'chat.completion',
            'model': body.get('model'),
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': f'from-{port}'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 11, 'completion_tokens': 5, 'total_tokens': 16},
        })


def serve(port):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def usage_hits(port):
    """How many official-usage fetches this instance served, with auth."""
    with LOCK:
        return list(STATE.get(port, {}).get('usage', []))


if __name__ == '__main__':
    ports = [int(value) for value in sys.argv[1:]] or [9101]
    for port in ports:
        serve(port)
    print(f'stub upstreams on {ports}', flush=True)
    threading.Event().wait()
