// Per-request correlation id shared by the client, the gateway and D1.
//
// One id is resolved when the worker dispatches a /v1 request, handed to the
// route so every attempt's usage row and request log carries it, and attached
// to the response as x-request-id. An upstream that sent its own x-request-id
// keeps it under x-upstream-request-id so neither side of the hop is lost.

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/** A caller-supplied x-request-id is honoured when it is well-formed, so client-side logs line up. */
export function resolveRequestId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  if (supplied && CLIENT_ID_PATTERN.test(supplied)) return supplied;
  return crypto.randomUUID();
}

export function withRequestId(response: Response, requestId: string): Response {
  if (!requestId) return response;
  const headers = new Headers(response.headers);
  const upstream = headers.get('x-request-id');
  if (upstream && upstream !== requestId) headers.set('x-upstream-request-id', upstream);
  headers.set('x-request-id', requestId);
  const bodyless = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
