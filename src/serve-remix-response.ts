import type { AppLoadContext, RequestHandler } from '@remix-run/server-runtime';
import './browser-globals';

import { Readable } from 'node:stream';

import { ReadableStream } from '@remix-run/web-stream';

export async function serveRemixResponse(
  request: Request,
  handleRequest: RequestHandler,
  context: AppLoadContext | undefined
): Promise<Response> {
  request.headers.append('referer', request.referrer);
  const response = await handleRequest(request, context);
  if (response.body instanceof ReadableStream) {
    // @ts-expect-error
    return new Response(Readable.from(response.body), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  return response;
}
