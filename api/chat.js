// Vercel Serverless Function: 代理 DMXAPI 请求，隐藏 API Key
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.DMXAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { messages, temperature = 0.3, max_tokens = 4096 } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages is required' });
  }

  try {
    const response = await fetch('https://www.dmxapi.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages,
        temperature,
        max_tokens
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.error?.message || `Upstream API error (${response.status})`
      });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach upstream API' });
  }
}
