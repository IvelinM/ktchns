function corsHeaders(origin) {
  const isAllowed = origin === 'https://imstudio.design'
    || origin.startsWith('http://localhost')
    || origin.startsWith('https://localhost');
  const allowed = isAllowed ? origin : 'https://imstudio.design';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function getAccessToken(env) {
  const res = await fetch('https://accounts.zoho.eu/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id:     env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token');
  return data.access_token.trim();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers });
    }

    const { from_name, from_email, phone, message } = body;
    if (!from_name || !from_email || !phone || !message) {
      return new Response('Missing fields', { status: 400, headers });
    }

    // Sanitise inputs to prevent header injection
    const safe = str => str.replace(/[\r\n]/g, ' ').trim();

    try {
      const token = await getAccessToken(env);

      const res = await fetch(
        `https://mail.zoho.eu/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fromAddress: 'info@viaminima.design',
            toAddress:   'info@viaminima.design',
            replyTo:     safe(from_email),
            subject:     'CONTACTS FORM REQUEST',
            content:     `Name:  ${safe(from_name)}\nEmail: ${safe(from_email)}\nPhone: ${safe(phone)}\n\n${message}`,
            mailFormat:  'plaintext',
          }),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        console.error('Zoho error', res.status, err);
        return new Response('Failed to send', { status: 502, headers });
      }

      return new Response('OK', { status: 200, headers });
    } catch (err) {
      console.error('Worker error', err);
      return new Response('Internal error', { status: 500, headers });
    }
  },
};
