import type {
  AppLoadContext,
  RequestHandler,
  ServerBuild
} from '@remix-run/server-runtime';
import './browser-globals';

import { app, protocol, session } from 'electron';
import { stat } from 'node:fs/promises';
import cookieParser from 'set-cookie-parser';

import { Response } from '@remix-run/node';
import { createRequestHandler } from '@remix-run/server-runtime';

import { asAbsolutePath } from './as-absolute-path';
import { collectAssetFiles, serveAsset } from './asset-files';
import { serveRemixResponse } from './serve-remix-response';

import type { AssetFile } from './asset-files';
const defaultMode = app.isPackaged ? 'production' : process.env.NODE_ENV;

export type GetLoadContextFunction = (
  request: Request
) => AppLoadContext | undefined | Promise<AppLoadContext | undefined>;

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

  let assetFiles = await collectAssetFiles(publicFolder);

  let lastBuildTime = 0;
  const buildPath =
    typeof serverBuildOption === 'string'
      ? require.resolve(serverBuildOption)
      : undefined;

  protocol.handle('http', async (request) => {
    try {
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

      let cookie = request.headers.get('cookie');
      for (const sessionCookie of await requestSession.cookies.get({
        url: request.url
      })) {
        if (cookie?.length) {
          cookie += '; ';
        } else {
          cookie = '';
        }
        cookie += `${sessionCookie.name}=${sessionCookie.value}`;
      }
      request.headers.set('cookie', cookie);

      const response = await handleRequest(
        request,
        assetFiles,
        requestHandler,
        context
      );

      const url = new URL(request.url);

      const setCookie = cookieParser.parse(response.headers.get('set-cookie'));
      for (const cookie of setCookie) {
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

      return response;
    } catch (error) {
      console.warn('[remix-electron]', error);
      const { stack, message } = toError(error);
      return new Response(`<pre>${stack || message}</pre>`, {
        status: 500
      });
    }
  });

  // the remix web socket reads the websocket host from the browser url,
  // so this _has_ to be localhost
  return `http://localhost/`;
}

async function handleRequest(
  request: Request,
  assetFiles: AssetFile[],
  requestHandler: RequestHandler,
  context: AppLoadContext | undefined
  // TODO: What is wrong with types?
): Promise<globalThis.Response> {
  return (
    serveAsset(request, assetFiles) ??
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

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
