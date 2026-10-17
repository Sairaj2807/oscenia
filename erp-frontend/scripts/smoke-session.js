// Imported first by smoke.jsx: plants an offline CEO session (CEO sees every module) before
// useAuth is created, because the server render only ever sees a store's initial state.
const session = new Map([
  ['oscenia.offlineUser', JSON.stringify({
    id: 'smoke', email: 'smoke@oscenia.local', role: 'ceo', name: 'Smoke', actions: [], offline: true,
  })],
])

globalThis.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k),
}
