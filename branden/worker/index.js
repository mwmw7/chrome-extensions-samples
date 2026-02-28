// Cloudflare Worker proxy for Claude API
// Secrets (set via `wrangler secret put`):
//   CLAUDE_API_KEY  — your Anthropic API key
//   ACCESS_CODES    — comma-separated valid access codes (e.g. "abc123,def456")

const RATE_LIMIT = 30; // requests per hour per access code
const rateBuckets = new Map(); // code -> { count, resetAt }

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // Validate access code
    const accessCode = request.headers.get('x-access-code');
    if (!accessCode) {
      return json({ error: 'NO_ACCESS_CODE' }, 401);
    }

    const validCodes = (env.ACCESS_CODES || '').split(',').map((c) => c.trim());
    if (!validCodes.includes(accessCode)) {
      return json({ error: 'INVALID_ACCESS_CODE' }, 403);
    }

    // Rate limit (in-memory, resets on worker restart)
    const now = Date.now();
    let bucket = rateBuckets.get(accessCode);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 3600_000 };
      rateBuckets.set(accessCode, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT) {
      return json({ error: 'RATE_LIMITED' }, 429);
    }

    // Forward to Claude API
    try {
      const body = await request.json();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: body.model || 'claude-haiku-4-5-20251001',
          max_tokens: body.max_tokens || 1024,
          messages: body.messages
        })
      });

      const data = await response.text();
      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-access-code'
  };
}
