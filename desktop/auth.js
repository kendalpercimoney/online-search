// Google sign-in for the Mac app. Google blocks sign-in inside embedded app windows, so
// this uses the flow Google prescribes for installed apps: open the system browser,
// receive the result on a temporary 127.0.0.1 address (with PKCE), and exchange it for
// tokens. The refresh token is stored encrypted with the macOS Keychain (Electron
// safeStorage), so people stay signed in between launches.

const { app, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;

// { clientId, clientSecret } of a "Desktop app" OAuth client. Google documents that an
// installed app's client secret can't be kept secret; PKCE is what protects the flow.
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const sessionFile = () => path.join(app.getPath('userData'), 'google-session.bin');
let session = null; // { access, expiry, refresh }

async function storedRefreshToken() {
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(sessionFile()));
    if (shouldReEncrypt) await saveRefreshToken(result); // the Keychain key was rotated
    return result;
  } catch {
    return null;
  }
}

async function saveRefreshToken(token) {
  fs.writeFileSync(sessionFile(), await safeStorage.encryptStringAsync(token));
}

function forget() {
  session = null;
  fs.rmSync(sessionFile(), { force: true });
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `Google answered ${res.status}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function accept(body, refresh) {
  session = {
    access: body.access_token,
    expiry: Date.now() + (body.expires_in - 60) * 1000,
    refresh: body.refresh_token || refresh,
  };
  if (body.refresh_token) await saveRefreshToken(body.refresh_token);
  return { token: session.access, expiry: session.expiry };
}

// A valid access token, refreshed silently when needed; null when signed out.
async function getToken() {
  if (session && Date.now() < session.expiry) return { token: session.access, expiry: session.expiry };
  const refresh = session?.refresh || (await storedRefreshToken());
  if (!refresh) return null;
  try {
    return await accept(await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }), refresh);
  } catch (err) {
    if (err.code === 'invalid_grant') { // revoked or expired: needs a fresh sign-in
      forget();
      return null;
    }
    throw err;
  }
}

function resultPage(ok, message) {
  return `<!doctype html><meta charset="utf-8"><title>Online Search</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111214;color:#e8e9eb;font:16px system-ui,sans-serif">
<div style="text-align:center;max-width:420px;padding:24px">
<div style="font-weight:700;font-size:20px;margin-bottom:8px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#ff6b1a;margin-right:8px"></span>Online Search</div>
<p style="color:${ok ? '#e8e9eb' : '#ff7b7b'}">${message}</p></div></body>`;
}

function signIn() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  let redirect;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return res.writeHead(404).end();
      const reply = (ok, message) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(ok, message));
        server.close();
      };
      if (url.searchParams.get('state') !== state) {
        reply(false, 'This sign-in link didn’t match. Please start again from Online Search.');
        return reject(new Error('Sign-in did not match; please try again.'));
      }
      const code = url.searchParams.get('code');
      if (!code) {
        reply(false, 'Sign-in was cancelled. You can close this tab.');
        return reject(new Error('Sign-in was cancelled.'));
      }
      try {
        const body = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
        reply(true, 'You’re signed in. You can close this tab and go back to Online Search.');
        resolve(await accept(body));
      } catch (err) {
        reply(false, `Sign-in failed: ${err.message}`);
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: config.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
      });
      shell.openExternal(url.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Sign-in timed out. Please try again.'));
    }, SIGN_IN_TIMEOUT);
  });
}

async function signOut() {
  const token = session?.refresh || (await storedRefreshToken());
  forget();
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
}

module.exports = { getToken, signIn, signOut };
