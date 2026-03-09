// BON V2 — API-klient
const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(`API fejl: ${res.status} ${res.statusText}`);
  return res.json();
}

// TODO: Tilføj API-funktioner her
