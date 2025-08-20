import process from 'node:process';

const BASE = process.env.BASE || 'http://localhost:5001';

async function run() {
  try {
    const res = await fetch(`${BASE}/healthz`);
    const json = await res.json();
    console.log('Health:', res.status, json);
  } catch (e) {
    console.error('Health check failed:', e);
    process.exitCode = 1;
  }

  try {
    const res = await fetch(`${BASE}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json();
    console.log('Token:', res.status, json.error ? `error=${json.error}` : 'ok');
    if (!res.ok) process.exitCode = 1;
  } catch (e) {
    console.error('Token check failed:', e);
    process.exitCode = 1;
  }
}

run(); 