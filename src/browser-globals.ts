import { installGlobals } from '@remix-run/node';
installGlobals();

// TODO: Not sure if we still need this
if (typeof globalThis.ReadableStream === 'undefined') {
  const { ReadableStream } = require('@remix-run/web-stream');
  globalThis.ReadableStream = ReadableStream;
}
