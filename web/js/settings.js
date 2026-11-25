// Settings sheet: account, appearance, saved previews, and (browser version only) the
// Google OAuth Client ID. Also the monthly offer to clear previews that haven't been used.

import { accountEmail, auth, clientId, desktop, hadSession, setClientId, signIn, signOut, validToken } from './auth.js';
import { clearOldStrips, clearStrips, stripCacheStats } from './idb.js';
import { forgetAllStrips, prepareInBackground } from './strips.js';
import { BACKGROUNDS, applyAppearance, getAppearance, gradientFor } from './theme.js';
import { $, bytes, el, plural } from './util.js';

const MONTH = 30 * 86_400_000;
const ASKED_KEY = 'os.cleanupAskedAt';

export const APP_VERSION = desktop?.version || '0.4.2';

function renderAccount() {
  const signedIn = !!validToken();
  const email = accountEmail();
  $('accountName').textContent = signedIn ? (email || 'Signed in') : hadSession() ? 'Session expired' : 'Not signed in';
  $('accountDetail').textContent = signedIn
    ? (desktop ? 'Online Search keeps you signed in on this Mac.' : 'Signed in for this browser tab.')
    : 'Sign in with the Google account that has your footage.';
  $('accountAvatar').textContent = (email || '?').slice(0, 1).toUpperCase();
  $('signIn').hidden = signedIn;
  $('signIn').textContent = hadSession() ? 'Sign in again' : 'Sign in with Google';
  $('signOut').hidden = !hadSession();
}

function renderBackgrounds() {
  const current = getAppearance().background;
  $('backgrounds').replaceChildren(...BACKGROUNDS.map((bg) => {
    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = bg.id === 'auto'
      ? `linear-gradient(135deg, ${BACKGROUNDS.find((b) => b.id === 'mist').base} 50%, ${BACKGROUNDS.find((b) => b.id === 'dusk').base} 50%)`
      : gradientFor(bg);
    return el('button', {
      className: `bg-option ${bg.id === current ? 'on' : ''}`, 'aria-pressed': String(bg.id === current),
      onclick: () => { applyAppearance({ background: bg.id }); renderBackgrounds(); },
    }, swatch, el('span', { textContent: bg.name }));
  }));
}

async function renderCache() {
  const { all } = await stripCacheStats();
  $('cacheDetail').textContent = all.count
    ? `${plural(all.count, 'clip')} · ${bytes(all.bytes)} on this computer, so folders scrub instantly.`
    : 'Kept on this computer so folders scrub instantly.';
}

// Once a month at most: offers to clear previews nobody has hovered for a month.
export async function offerCleanup() {
  const asked = Number(localStorage.getItem(ASKED_KEY) || 0);
  if (Date.now() - asked < MONTH) return;
  const { old } = await stripCacheStats(MONTH);
  if (!old.count) return;
  localStorage.setItem(ASKED_KEY, String(Date.now()));
  const node = el('div', { className: 'toast glass done' },
    el('div', { className: 'toast-title', textContent: 'Clear old hover previews?' }),
    el('div', { className: 'toast-sub', textContent: `${plural(old.count, 'clip')} (${bytes(old.bytes)}) haven’t been previewed for over a month.` }),
    el('div', { className: 'toast-actions' },
      el('button', { className: 'pill small', textContent: 'Keep', onclick: () => node.remove() }),
      el('button', {
        className: 'pill small primary', textContent: 'Clear',
        onclick: async () => {
          await clearOldStrips(MONTH);
          forgetAllStrips();
          node.remove();
        },
      })));
  $('toasts').append(node);
}

export function openSettings() {
  renderCache();
  renderAccount();
  renderBackgrounds();
  $('glass').value = getAppearance().glass;
  $('prepareInBackground').checked = prepareInBackground.on;
  $('clientId').value = clientId();
  $('settingsMessage').textContent = '';
  $('settings').showModal();
}

export function initSettings() {
  $('clientIdSection').hidden = !!desktop;
  $('aboutVersion').textContent = `Online Search ${APP_VERSION}`;
  $('updateVersion').textContent = `Online Search ${APP_VERSION}`;
  $('openSettings').onclick = openSettings;
  $('closeSettings').onclick = () => $('settings').close();
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').close(); });
  $('glass').addEventListener('input', (e) => applyAppearance({ glass: Number(e.target.value) }));
  $('prepareInBackground').addEventListener('change', (e) => { prepareInBackground.on = e.target.checked; });
  $('signIn').onclick = async () => {
    $('settingsMessage').textContent = desktop ? 'Finish signing in in your web browser…' : '';
    try {
      await signIn();
      $('settings').close();
    } catch (err) {
      $('settingsMessage').textContent = err.message;
    }
  };
  $('signOut').onclick = () => signOut();
  $('saveClientId').onclick = () => {
    const v = $('clientId').value.trim();
    if (!v) return;
    setClientId(v);
    $('settingsMessage').textContent = 'Client ID saved.';
  };
  $('clearCache').onclick = async () => {
    await clearStrips();
    forgetAllStrips();
    renderCache();
    $('clearCache').textContent = 'Cleared';
    setTimeout(() => { $('clearCache').textContent = 'Clear'; }, 2000);
  };
  auth.addEventListener('change', () => { if ($('settings').open) renderAccount(); });
}
