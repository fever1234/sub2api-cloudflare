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
    return {'status': 200, 'requests': [], 'stream': False}


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

    def _send(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        port = self._port()
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
            })
            status = state['status']
            want_stream = state['stream']

        if status >= 400:
            return self._send(status, {'error': {'message': f'stub failure {status}', 'type': 'stub'}})

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


if __name__ == '__main__':
    ports = [int(value) for value in sys.argv[1:]] or [9101]
    for port in ports:
        serve(port)
    print(f'stub upstreams on {ports}', flush=True)
    threading.Event().wait()
