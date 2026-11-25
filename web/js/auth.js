// Google sign-in. Inside the Mac app, sign-in goes through the system browser
// (desktop/auth.js) and stays signed in between launches; in a browser it uses Google's
// sign-in popup and lasts an hour. Listen for 'change' on `auth` to react to sign-in state.

// Read everything; write only files this app creates (the search catalogue index files).
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';

export const desktop = window.desktopApp || null;
export const auth = new EventTarget();

let token = null, expiry = 0, account = null, expiryTimer, tokenClient;

export const validToken = () => (token && Date.now() < expiry ? token : null);
export const hadSession = () => !!token;
export const accountEmail = () => account;
export const clientId = () => localStorage.getItem('scrub.clientId') || '';

const changed = (detail = {}) => auth.dispatchEvent(new CustomEvent('change', { detail }));

function use(newToken, newExpiry) {
  token = newToken;
  expiry = newExpiry;
  if (!desktop) sessionStorage.setItem('scrub.token', JSON.stringify({ token, expiry }));
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(async () => {
    // The Mac app renews the token silently; a browser session simply ends.
    const renewed = desktop && await desktop.getToken().catch(() => null);
    if (renewed) use(renewed.token, renewed.expiry);
    else changed({ expired: true });
  }, expiry - Date.now());
  if (!account) {
    fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((r) => { account = r.user?.emailAddress || null; changed(); })
      .catch(() => {});
  }
  changed();
}

export async function restore() {
  if (desktop) {
    const t = await desktop.getToken().catch(() => null);
    if (t) use(t.token, t.expiry);
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem('scrub.token'));
    if (saved && Date.now() < saved.expiry) use(saved.token, saved.expiry);
  } catch {}
}

// Resolves once signed in; rejects with a readable message.
export function signIn() {
  if (desktop) {
    return desktop.signIn()
      .then((t) => use(t.token, t.expiry))
      .catch((err) => { throw new Error(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
  }
  return new Promise((resolve, reject) => {
    if (!clientId()) return reject(new Error('Add your OAuth Client ID in Settings first.'));
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in is still loading. Try again in a moment.'));
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(`Sign-in failed: ${resp.error}`));
        use(resp.access_token, Date.now() + (resp.expires_in - 60) * 1000);
        resolve();
      },
      error_callback: (err) => reject(new Error(err.message || 'Sign-in was cancelled.')),
    });
    tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
  });
}

export async function signOut() {
  if (desktop) await desktop.signOut();
  else if (token) window.google?.accounts?.oauth2?.revoke(token, () => {});
  token = null;
  expiry = 0;
  account = null;
  clearTimeout(expiryTimer);
  sessionStorage.removeItem('scrub.token');
  changed();
}

export function setClientId(id) {
  localStorage.setItem('scrub.clientId', id);
  tokenClient = null;
}
