import type { RequestHandler } from '@remix-run/server-runtime';
import './browser-globals';

import { session } from 'electron';

function isRawData(data: Electron.UploadData) {
  return 'type' in data && data.type === 'rawData';
}

function isBlobData(data: Electron.UploadData) {
  return 'type' in data && data.type === 'blob';
}

export async function serveRemixResponse(
  request: Electron.ProtocolRequest,
  handleRequest: RequestHandler,
  context: unknown
): Promise<Electron.ProtocolResponse> {
  let body: Buffer | undefined = undefined;

  if (request.uploadData) {
    const init = await Promise.all(
      request.uploadData
        .filter(isBlobData)
        .map(
          async ({ blobUUID }): Promise<[string, Buffer]> => [
            blobUUID,
            await session.defaultSession.getBlobData(blobUUID)
          ]
        )
    );

    const blobs = new Map(init);

    body = Buffer.concat(
      request.uploadData.map((data) =>
        isRawData(data) ? data.bytes : blobs.get(data.blobUUID)
      )
    );
  }

  const remixHeaders = new Headers(request.headers);
  remixHeaders.append('Referer', request.referrer);

  const remixRequest = new Request(request.url, {
    method: request.method,
    headers: remixHeaders,
    body
  });

  const response = await handleRequest(remixRequest, context);

  const headers: Record<string, string[]> = {};
  response.headers.forEach((value, key) => {
    const values = (headers[key] ??= []);
    values.push(value);
  });

  return {
    data: Buffer.from(await response.arrayBuffer()),
    headers,
    statusCode: response.status
  };
}
