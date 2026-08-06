// Run: node netlify/functions/_groq-client.selfcheck.js
// Mocks global.fetch to verify callGroq's failover branching without hitting the real API.
const assert = require('assert');

function mockFetch(sequence){
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { ok: step.ok, status: step.status, json: async () => step.body };
  };
}

async function run(){
  // 1. First key succeeds — no failover needed.
  {
    global.fetch = mockFetch([{ ok: true, status: 200, body: { choices: [{ message: { content: 'hi' } }] } }]);
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    process.env.GROQ_API_KEY = 'k1'; process.env.GROQ_API_KEY_2 = 'k2'; process.env.GROQ_API_KEY_3 = 'k3';
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, true);
  }

  // 2. Key 1 rate-limited (429), key 2 succeeds — failover happens.
  {
    global.fetch = mockFetch([
      { ok: false, status: 429, body: { error: { message: 'rate limit exceeded' } } },
      { ok: true, status: 200, body: { choices: [{ message: { content: 'hi' } }] } }
    ]);
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, true);
  }

  // 3. Key 1 returns a real error (400) — must NOT try key 2, returns immediately.
  {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) }; };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(calls, 1, 'must not retry on a non-rate-limit error');
  }

  // 4. All 3 keys rate-limited — returns key 3's error, tried exactly 3 times.
  {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) }; };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, 3);
  }

  // 5. No keys configured — clear error, no fetch call.
  {
    delete process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY_2; delete process.env.GROQ_API_KEY_3;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('should not be called'); };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, 0);
    assert.ok(/no groq api key/i.test(result.data.error.message));
  }

  console.log('All _groq-client self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
