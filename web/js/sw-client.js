// The page's side of the streaming service worker (sw.js).

import { auth, validToken } from './auth.js';

export async function startServiceWorker() {
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'get-token') e.ports[0].postMessage({ token: validToken() });
  });
  const sendToken = () => navigator.serviceWorker.controller?.postMessage({ type: 'token', token: validToken() });
  auth.addEventListener('change', sendToken);
  sendToken();
}

const post = (msg, transfer) => navigator.serviceWorker.controller?.postMessage(msg, transfer);

// Tells the worker these bytes are on their way, so the player waits for them rather than
// starting its own download.
export const expectRange = (fileId, start, end, mime) => post({ type: 'expect-range', fileId, start, end, mime });
export const rangeFailed = (fileId, start) => post({ type: 'range-failed', fileId, start });

// Hands bytes the page already has to the worker, so the player gets them instantly.
export function shareRange(fileId, start, bytes, mime) {
  const copy = bytes.slice(); // the original may be a view into a larger buffer
  navigator.serviceWorker.controller?.postMessage({ type: 'cache-range', fileId, start, bytes: copy.buffer, mime }, [copy.buffer]);
}
