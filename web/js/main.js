// Online Search, by Percimoney Technologies. Start-up and wiring between modules.

import { auth, desktop, restore, validToken } from './auth.js';
import { catalogWhenStripReady, loadLibrary } from './catalog.js';
import { initDownloads } from './downloads.js';
import { initPlayer } from './player.js';
import { initSearch } from './search.js';
import { initSettings, offerCleanup } from './settings.js';
import { onStripReady } from './strips.js';
import { startServiceWorker } from './sw-client.js';
import { initAppearance } from './theme.js';
import { initUpdates } from './updates.js';
import { initViews, route, setStatus } from './views.js';

initAppearance();
if (desktop) document.body.classList.add('desktop');

// The top bar turns frosted once the page scrolls.
window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', window.scrollY > 4), { passive: true });
initViews();
initSearch();
initSettings();
initPlayer();
initDownloads();
initUpdates();
onStripReady(catalogWhenStripReady);
setTimeout(() => offerCleanup().catch(() => {}), 8000);

// Re-render when signing in or out; a renewed token alone changes nothing on screen.
let signedIn = null;
auth.addEventListener('change', (e) => {
  const now = !!validToken();
  if (now !== signedIn) {
    signedIn = now;
    route();
    // Have the catalogue in memory before the first search (it comes from browser storage
    // and changed files only, so this is cheap).
    if (now) setTimeout(() => loadLibrary().catch(() => {}), 1500);
  }
  if (e.detail?.expired) setStatus('Your Google session has expired. Sign in again from Settings.', true);
});

startServiceWorker()
  .then(restore)
  .then(() => {
    if (signedIn === null) {
      signedIn = !!validToken();
      route();
    }
  })
  .catch((err) => setStatus(`Online Search couldn’t start: ${err.message}`, true));
