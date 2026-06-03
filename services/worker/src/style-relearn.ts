// Scheduled re-learn of the owner's reply style. Calls the API's internal
// /style/relearn endpoint (which re-harvests sent mail + re-distills the
// profile for the default workspace). Wired on a weekly cadence in index.ts.

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

export async function runStyleRelearn(): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/style/relearn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`style relearn ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  console.log(`[style-relearn] done: ${JSON.stringify(data?.email ?? data).slice(0, 200)}`);
}
