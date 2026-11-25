// Appearance: a calm gradient background behind Liquid Glass panels. People pick the
// background and how strong the glass is (clear to frosted) in Settings.

const STORE = 'os.appearance';

// Soft colour fields: a base colour with three large, blurred light pools.
export const BACKGROUNDS = [
  { id: 'auto', name: 'Auto', scheme: 'auto' },
  { id: 'dusk', name: 'Dusk', scheme: 'dark', base: '#15152a', pools: ['#4b3f8f', '#1f5f7a', '#6a3b5f'] },
  { id: 'ocean', name: 'Ocean', scheme: 'dark', base: '#0a1826', pools: ['#14607d', '#24407f', '#0f6a66'] },
  { id: 'forest', name: 'Forest', scheme: 'dark', base: '#0e1914', pools: ['#2d5c48', '#46602c', '#1f4a54'] },
  { id: 'ember', name: 'Ember', scheme: 'dark', base: '#1a120e', pools: ['#7c3c1e', '#5a2a3c', '#8a5c26'] },
  { id: 'mist', name: 'Mist', scheme: 'light', base: '#e8edf5', pools: ['#c3d4f2', '#e0d0f3', '#cdeae4'] },
  { id: 'dawn', name: 'Dawn', scheme: 'light', base: '#f6ebe5', pools: ['#f8c9b2', '#f2c4d8', '#e4d7f6'] },
  { id: 'sand', name: 'Sand', scheme: 'light', base: '#f2ede2', pools: ['#ead7b2', '#d9e3c6', '#f1d1bd'] },
];

const DEFAULTS = { background: 'auto', glass: 55 };

export function getAppearance() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const gradientFor = (bg) =>
  `radial-gradient(60% 55% at 12% 18%, ${bg.pools[0]} 0%, transparent 70%),
   radial-gradient(55% 60% at 88% 12%, ${bg.pools[1]} 0%, transparent 70%),
   radial-gradient(70% 60% at 65% 95%, ${bg.pools[2]} 0%, transparent 72%),
   ${bg.base}`;

const systemDark = matchMedia('(prefers-color-scheme: dark)');

function resolve(id) {
  if (id === 'auto') return BACKGROUNDS.find((b) => b.id === (systemDark.matches ? 'dusk' : 'mist'));
  return BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[1];
}

export function applyAppearance(changes = {}) {
  const appearance = { ...getAppearance(), ...changes };
  localStorage.setItem(STORE, JSON.stringify(appearance));
  const bg = resolve(appearance.background);
  const g = Math.min(100, Math.max(0, appearance.glass)) / 100; // 0 clear … 1 frosted
  const dark = bg.scheme === 'dark';
  const root = document.documentElement;
  root.dataset.scheme = bg.scheme;
  root.style.setProperty('--backdrop', gradientFor(bg));
  root.style.setProperty('--glass-blur', `${(6 + g * 34).toFixed(1)}px`);
  root.style.setProperty('--glass-fill', dark ? `rgba(255,255,255,${(0.03 + g * 0.13).toFixed(3)})` : `rgba(255,255,255,${(0.22 + g * 0.43).toFixed(3)})`);
  root.style.setProperty('--glass-fill-strong', dark ? `rgba(30,32,40,${(0.45 + g * 0.3).toFixed(3)})` : `rgba(255,255,255,${(0.55 + g * 0.3).toFixed(3)})`);
  root.style.setProperty('--glass-edge', dark ? `rgba(255,255,255,${(0.10 + g * 0.12).toFixed(3)})` : `rgba(255,255,255,${(0.50 + g * 0.35).toFixed(3)})`);
  root.style.setProperty('--glass-shine', dark ? `rgba(255,255,255,${(0.10 + g * 0.16).toFixed(3)})` : `rgba(255,255,255,${(0.45 + g * 0.4).toFixed(3)})`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg.base);
  return appearance;
}

export function initAppearance() {
  applyAppearance();
  systemDark.addEventListener('change', () => { if (getAppearance().background === 'auto') applyAppearance(); });
}
