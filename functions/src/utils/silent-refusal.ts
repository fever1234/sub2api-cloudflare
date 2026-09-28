// OpenAI silent-refusal detection, ported from Go openai_silent_refusal.go.
//
// An OpenAI upstream can answer a long request with a stream that terminates
// on finish_reason=stop while carrying no content, no tool calls, no reasoning
// and no usage: an empty completion that looks like success. The gateway must
// treat it as an upstream anomaly and fail over instead of serving it.
//
// Detection is gated on request size (>= 64KB, matching Go): small requests
// are exactly the ones that legitimately answer with nothing. While the stream
// has not yet shown a positive signal, output is buffered, so a refusal can
// still be failed over — the client has not received a byte yet. The buffer
// fails open once a positive signal arrives, once a non-stop finish reason is
// seen, or once the buffer cap is reached; after that the stream is committed.

export const SILENT_REFUSAL_MIN_BODY_BYTES = 64 * 1024;
/** Buffered upstream output above this cap is released rather than held. */
export const SILENT_REFUSAL_BUFFER_CAP = 1024 * 1024;
export const SILENT_REFUSAL_UPSTREAM_MESSAGE =
  'OpenAI upstream returned an empty completion stream with finish_reason=stop and no usage';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class SilentRefusalDetector {
  readonly enabled: boolean;
  private sawContent = false;
  private sawToolCall = false;
  private sawFunctionCall = false;
  private sawUsage = false;
  private sawError = false;
  private sawReasoning = false;
  private sawFinish = false;
  private finishReason = '';

  constructor(requestBodyLen: number, allowed = true) {
    this.enabled = allowed && requestBodyLen >= SILENT_REFUSAL_MIN_BODY_BYTES;
  }

  observeEventType(eventType: string): void {
    if (!this.enabled) return;
    const type = eventType.trim();
    if (!type) return;
    if (type === 'error' || type === 'response.failed') this.sawError = true;
    if (type.includes('reasoning')) this.sawReasoning = true;
  }

  observePayload(payload: string): void {
    if (!this.enabled) return;
    const text = payload.trim();
    if (!text || text === '[DONE]') return;
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(data)) return;

    if (typeof data.type === 'string') this.observeEventType(data.type);
    if (data.error != null) this.sawError = true;
    if (isObject(data.usage)) this.sawUsage = true;
    if (isObject(data.response) && isObject(data.response.usage)) this.sawUsage = true;

    this.observeChatChoices(data);
    this.observeResponses(data, typeof data.type === 'string' ? data.type : '');
  }

  shouldReleaseClientOutput(): boolean {
    if (!this.enabled) return true;
    if (this.sawContent || this.sawToolCall || this.sawFunctionCall
      || this.sawUsage || this.sawError || this.sawReasoning) return true;
    return this.sawFinish && this.finishReason !== '' && this.finishReason !== 'stop';
  }

  isSilentRefusal(): boolean {
    return this.enabled
      && !this.sawContent && !this.sawToolCall && !this.sawFunctionCall
      && !this.sawUsage && !this.sawError && !this.sawReasoning
      && this.sawFinish && this.finishReason === 'stop';
  }

  private observeFinishReason(reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.sawFinish = true;
    this.finishReason = trimmed;
  }

  private observeChatChoices(data: Record<string, unknown>): void {
    if (!Array.isArray(data.choices)) return;
    for (const raw of data.choices) {
      if (!isObject(raw)) continue;
      if (typeof raw.finish_reason === 'string') this.observeFinishReason(raw.finish_reason);
      const delta = raw.delta;
      if (!isObject(delta)) continue;
      if (typeof delta.content === 'string' && delta.content !== '') this.sawContent = true;
      if (delta.tool_calls != null) this.sawToolCall = true;
      if (delta.function_call != null) this.sawFunctionCall = true;
      if (delta.reasoning != null || delta.reasoning_content != null
        || delta.reasoning_summary != null) this.sawReasoning = true;
    }
  }

  private observeResponses(data: Record<string, unknown>, eventType: string): void {
    switch (eventType.trim()) {
      case 'response.output_text.delta':
        if (typeof data.delta === 'string' && data.delta !== '') this.sawContent = true;
        break;
      case 'response.output_item.added': {
        const item = isObject(data.item) && typeof data.item.type === 'string'
          ? data.item.type.trim() : '';
        if (item === 'function_call') this.sawToolCall = true;
        else if (item === 'reasoning') this.sawReasoning = true;
        break;
      }
      case 'response.function_call_arguments.delta':
        this.sawToolCall = true;
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
        this.sawReasoning = true;
        break;
      case 'response.completed':
      case 'response.done':
        this.observeFinishReason('stop');
        break;
      case 'response.incomplete':
        this.observeFinishReason('length');
        break;
      case 'response.failed':
        this.sawError = true;
        break;
      default:
        break;
    }

    const response = data.response;
    if (!isObject(response) || !Array.isArray(response.output)) return;
    for (const raw of response.output) {
      if (!isObject(raw)) continue;
      const itemType = typeof raw.type === 'string' ? raw.type.trim() : '';
      if (itemType === 'function_call') this.sawToolCall = true;
      else if (itemType === 'reasoning') this.sawReasoning = true;
      else if (itemType === 'message' && Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (isObject(part) && typeof part.text === 'string' && part.text !== '') {
            this.sawContent = true;
            break;
          }
        }
      }
    }
  }
}

interface FrameSink {
  (frame: string): void;
}

function makeFrameSink(detector: SilentRefusalDetector): { push: (text: string) => void; flush: () => void } {
  let pending = '';
  const observeFrame: FrameSink = frame => {
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        detector.observeEventType(line.slice('event:'.length));
      } else if (line.startsWith('data:')) {
        const payload = line.slice('data:'.length);
        detector.observePayload(payload.startsWith(' ') ? payload.slice(1) : payload);
      }
    }
  };
  return {
    push(text: string) {
      pending += text;
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending);
        if (!match) break;
        observeFrame(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
    },
    flush() {
      if (pending.trim()) observeFrame(pending);
      pending = '';
    }
  };
}

/**
 * Hold upstream stream output back from the client until the detector can tell
 * a silent refusal from a real answer. A refusal errors the stream with the Go
 * failover message, which the route converts into an attempt failure (no byte
 * ever reached the client, so failover still applies). Any positive signal,
 * non-stop finish reason or buffer overflow releases the stream untouched.
 */
export function guardSilentRefusalStream(
  stream: ReadableStream<Uint8Array>,
  detector: SilentRefusalDetector
): ReadableStream<Uint8Array> {
  if (!detector.enabled) return stream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sink = makeFrameSink(detector);
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let released = false;

  const flushBuffered = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const chunk of buffered) controller.enqueue(chunk);
    buffered = [];
    bufferedBytes = 0;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (chunk.done) {
          sink.push(decoder.decode());
          sink.flush();
          if (!released && detector.isSilentRefusal()) {
            await reader.cancel().catch(() => {});
            controller.error(new Error(SILENT_REFUSAL_UPSTREAM_MESSAGE));
            return;
          }
          flushBuffered(controller);
          controller.close();
          return;
        }
        sink.push(decoder.decode(chunk.value, { stream: true }));
        if (released) {
          controller.enqueue(chunk.value);
          return;
        }
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        if (detector.shouldReleaseClientOutput() || bufferedBytes >= SILENT_REFUSAL_BUFFER_CAP) {
          released = true;
          flushBuffered(controller);
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    }
  });
}
