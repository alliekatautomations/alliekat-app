const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

/* =========================
   SUPABASE (INLINE KEYS)
========================= */

const supabase = createClient(
  'https://julpheuumolnwkthazdj.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM'
);

const supabaseAdmin = createClient(
  'https://julpheuumolnwkthazdj.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDAzNzk4NiwiZXhwIjoyMDg5NjEzOTg2fQ.eCDb9XAD02Pi8Ejl3vIz9ROJC80zBpAOW4svI7M9GR4',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* =========================
   HEALTH CHECK
========================= */

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
});

app.get('/ask-allie-health', async (req, res) => {
  const { count } = await supabase
    .from('ask_allie_sessions')
    .select('*', { count: 'exact', head: true });

  res.json({
    success: true,
    status: 'ok',
    ask_allie_sessions_count: count || 0,
    openai_configured: true,
    tavily_configured: true
  });
});

/* =========================
   LOGIN (FIXED)
========================= */

app.post('/login', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase();
    const password = req.body.password || '';

    if (!email || !password) {
      return res.json({
        success: false,
        error: 'Email and password required'
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data?.user) {
      return res.json({
        success: false,
        error: error?.message || 'Invalid login'
      });
    }

    return res.json({
      success: true,
      user: data.user,
      session: data.session
    });

  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   ASK ALLIE (WEB + AI)
========================= */

app.post('/ask-allie', async (req, res) => {
  try {
    const { question, context } = req.body;

    if (!question) {
      return res.json({ success: false, error: 'Question required' });
    }

    /* ========= TAVILY SEARCH ========= */
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: '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',
        query: question,
        search_depth: 'advanced',
        include_images: true,
        max_results: 6
      })
    });

    const tavilyData = await tavilyRes.json();

    /* ========= OPENAI ========= */
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `
You are a master automotive diagnostic assistant.

You MUST:
- Extract pinouts
- Extract wire colors
- Extract connector views
- Verify data across multiple sources
- Reject weak sources
- Only return structured JSON
`
          },
          {
            role: 'user',
            content: `
QUESTION:
${question}

WEB DATA:
${JSON.stringify(tavilyData)}
`
          }
        ]
      })
    });

    const aiData = await aiRes.json();
    const answer = aiData?.choices?.[0]?.message?.content || '';

    /* ========= SAVE SESSION ========= */
    const { data: session } = await supabase
      .from('ask_allie_sessions')
      .insert([{ question }])
      .select()
      .single();

    await supabase.from('ask_allie_messages').insert([
      {
        session_id: session?.id || null,
        role: 'assistant',
        content: answer
      }
    ]);

    return res.json({
      success: true,
      answer,
      sources: tavilyData?.results || []
    });

  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
