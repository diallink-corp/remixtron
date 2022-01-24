import type { RequestHandler, ServerBuild } from '@remix-run/server-runtime';
import './browser-globals';

import { app, protocol, session } from 'electron';
import { stat } from 'node:fs/promises';
import cookieParser from 'set-cookie-parser';

import { createRequestHandler } from '@remix-run/server-runtime';

import { asAbsolutePath } from './as-absolute-path';
import { collectAssetFiles, serveAsset } from './asset-files';
import { serveRemixResponse } from './serve-remix-response';

import type { AssetFile } from './asset-files';
const defaultMode = app.isPackaged ? 'production' : process.env.NODE_ENV;

export type GetLoadContextFunction = (
  request: Electron.ProtocolRequest
) => unknown;

export type InitRemixOptions = {
  /**
   * The path to the server build, or the server build itself.
   */
  serverBuild: ServerBuild | string;

  /**
   * The mode to run the app in, either development or production
   * @default app.isPackaged ? "production" : process.env.NODE_ENV
   */
  mode?: string;

  /**
   * The path where static assets are served from.
   * @default "public"
   */
  publicFolder?: string;

  /**
   * A function to provide a `context` object to your loaders.
   */
  getLoadContext?: GetLoadContextFunction;
};

export async function initRemix({
  serverBuild: serverBuildOption,
  mode = defaultMode,
  publicFolder: publicFolderOption = 'public',
  getLoadContext
}: InitRemixOptions) {
  const appRoot = app.getAppPath();
  const publicFolder = asAbsolutePath(publicFolderOption, appRoot);

  let serverBuild: ServerBuild =
    typeof serverBuildOption === 'string'
      ? require(serverBuildOption)
      : serverBuildOption;

  let [assetFiles] = await Promise.all([
    collectAssetFiles(publicFolder),
    app.whenReady()
  ]);

  let lastBuildTime = 0;
  const buildPath =
    typeof serverBuildOption === 'string'
      ? require.resolve(serverBuildOption)
      : undefined;

  protocol.interceptBufferProtocol('http', async (request, callback) => {
    try {
      if (mode === 'development') {
        assetFiles = await collectAssetFiles(publicFolder);
      }

      let buildTime = 0;
      if (mode === 'development' && buildPath !== undefined) {
        const buildStat = await stat(buildPath);
        buildTime = buildStat.mtimeMs;
      }

      if (
        mode === 'development' &&
        buildPath !== undefined &&
        lastBuildTime !== buildTime
      ) {
        purgeRequireCache(buildPath);
        serverBuild = require(buildPath);
        lastBuildTime = buildTime;
      }

      const context = await getLoadContext?.(request);
      const requestHandler = createRequestHandler(serverBuild, mode);

      const requestSession = session.fromPartition('persist:set-cookies', {
        cache: true
      });

      for (const cookie of await requestSession.cookies.get({
        url: request.url
      })) {
        if (request.headers['Cookie']?.length) {
          request.headers['Cookie'] += '; ';
        } else {
          request.headers['Cookie'] = '';
        }
        request.headers['Cookie'] += `${cookie.name}=${cookie.value}`;
      }

      const response = await handleRequest(
        request,
        assetFiles,
        requestHandler,
        context
      );

      const url = new URL(request.url);

      for (const cookieHeader of response.headers?.['set-cookie'] || []) {
        const cookies = cookieParser.parse(cookieHeader);

        for (const cookie of cookies) {
          let sameSite = cookie.sameSite?.toLowerCase();
          if (sameSite === 'none') {
            sameSite = 'no_restriction';
          }

          const cookieObj = {
            ...cookie,
            domain: cookie.domain ?? url.host,
            url: url.href,
            sameSite: sameSite
          };

          if (cookieObj.expires && cookieObj.expires.valueOf() < Date.now()) {
            await requestSession.cookies.remove(cookieObj.url, cookieObj.name);
          } else {
            await requestSession.cookies.set(cookieObj);
          }
        }
      }

      callback(response);
    } catch (error) {
      console.warn('[remixtron]', error);
      callback({
        statusCode: 500,
        data: `<pre>${error?.stack || error?.message || String(error)}</pre>`
      });
    }
  });

  // the remix web socket reads the websocket host from the browser url,
  // so this _has_ to be localhost
  return `http://localhost/`;
}

async function handleRequest(
  request: Electron.ProtocolRequest,
  assetFiles: AssetFile[],
  requestHandler: RequestHandler,
  context: unknown
): Promise<Electron.ProtocolResponse> {
  return (
    (await serveAsset(request, assetFiles)) ??
    (await serveRemixResponse(request, requestHandler, context))
  );
}

function purgeRequireCache(prefix: string) {
  for (const key in require.cache) {
    if (key.startsWith(prefix)) {
      delete require.cache[key];
    }
  }
}
