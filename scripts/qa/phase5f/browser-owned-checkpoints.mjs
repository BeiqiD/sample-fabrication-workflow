import assert from 'node:assert/strict';

/** Observe the real authenticated browser identity before inspecting current
 * checkpoint storage. Never relabel or adopt an older unowned checkpoint. */
export async function ownedCheckpointKey(page, key) {
  const identity = await page.evaluate(async () => {
    const response = await fetch('/api/identity', { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('The actual browser identity could not be read.');
    return response.json();
  });
  assert.deepEqual(Object.keys(identity).sort(), ['schema', 'subject']);
  assert.equal(identity.schema, 'application-identity/1');
  assert.equal(typeof identity.subject, 'string');
  assert.match(identity.subject, /^[a-f0-9]{64}$/);
  return `application-checkpoint-v1:${encodeURIComponent(`access:${identity.subject}`)}:${key}`;
}

export async function readOwnedCheckpoint(page, key) {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), await ownedCheckpointKey(page, key));
}

export async function waitForOwnedCheckpointCleared(page, key) {
  await page.waitForFunction(key => sessionStorage.getItem(key) === null, await ownedCheckpointKey(page, key));
}
