const express = require('express');
const cors = require('cors');
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
  try {
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
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.json({
        success: false,
        error: 'Email and password required',
        user: null,
        session: null
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.json({
        success: false,
        error: error.message,
        user: null,
        session: null
      });
    }

    return res.json({
      success: true,
      user: data?.user || null,
      session: data?.session || null
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      user: null,
      session: null
    });
  }
});

/* =========================
   ASK ALLIE
========================= */

app.post('/ask-allie', async (req, res) => {
  try {
    const question = String(req.body.question || '').trim();
    const jobContext = req.body.job_context || {};

    if (!question) {
      return res.json({
        success: false,
        error: 'Question required'
      });
    }

    const sessionPayload = {
      vin: String(jobContext.vin || '').trim() || null,
      year: String(jobContext.year || '').trim() || null,
      make: String(jobContext.make || '').trim() || null,
      model: String(jobContext.model || '').trim() || null,
      engine: String(jobContext.engine || '').trim() || null,
      complaint: String(jobContext.complaint || '').trim() || null,
      dtcs: Array.isArray(jobContext.dtcs) ? jobContext.dtcs : [],
      symptoms: Array.isArray(jobContext.symptoms) ? jobContext.symptoms : [],
      prior_tests: Array.isArray(jobContext.prior_tests || jobContext.priorTests)
        ? (jobContext.prior_tests || jobContext.priorTests)
        : [],
      notes: String(jobContext.notes || '').trim() || null
    };

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('ask_allie_sessions')
      .insert([sessionPayload])
      .select()
      .single();

    if (sessionError) {
      return res.json({
        success: false,
        error: sessionError.message
      });
    }

    await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id: session.id,
          role: 'user',
          content: question,
          metadata: { job_context: jobContext }
        }
      ]);

    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: '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',
        query: [
          jobContext.year,
          jobContext.make,
          jobContext.model,
          jobContext.engine,
          question
        ].filter(Boolean).join(' '),
        search_depth: 'advanced',
        include_images: true,
        max_results: 6
      })
    });

    const tavilyData = await tavilyRes.json();

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
            content: `You are a master automotive diagnostic assistant.

Return ONLY valid JSON in this exact shape:
{
  "answer": "string",
  "pinout_table": [
    {
      "pin_label": "",
      "wire_color": "",
      "circuit_function": "",
      "expected_value": ""
    }
  ],
  "confidence_score": 0
}

Rules:
- Extract usable pinout/spec data if present.
- Do not invent exact pin numbers.
- If exact OEM pinout is uncertain, say so in the answer.
- Use the search results only.`
          },
          {
            role: 'user',
            content: JSON.stringify({
              question,
              job_context: jobContext,
              web_results: tavilyData
            })
          }
        ]
      })
    });

    const aiData = await aiRes.json();
    const aiText = aiData?.choices?.[0]?.message?.content || '';

    let parsed = null;
    try {
      parsed = JSON.parse(aiText);
    } catch {
      const firstBrace = aiText.indexOf('{');
      const lastBrace = aiText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(aiText.slice(firstBrace, lastBrace + 1));
        } catch {
          parsed = null;
        }
      }
    }

    const finalAnswer = parsed?.answer || 'I found data, but could not fully structure the answer.';
    const pinoutTable = Array.isArray(parsed?.pinout_table) ? parsed.pinout_table : [];
    const confidenceScore = Number(parsed?.confidence_score || 25);

    for (const result of (tavilyData.results || [])) {
      await supabaseAdmin.from('ask_allie_sources').insert([
        {
          session_id: session.id,
          source_type: 'web',
          title: result.title || '',
          url: result.url || '',
          domain: (() => {
            try {
              return new URL(result.url).hostname;
            } catch {
              return '';
            }
          })(),
          raw_content: result.content || '',
          extracted_summary: result.content || '',
          status: 'unverified',
          confidence_score: 40
        }
      ]);
    }

    for (const imageUrl of (tavilyData.images || []).slice(0, 5)) {
      await supabaseAdmin.from('ask_allie_sources').insert([
        {
          session_id: session.id,
          source_type: 'image',
          title: 'Image result',
          url: imageUrl,
          domain: (() => {
            try {
              return new URL(imageUrl).hostname;
            } catch {
              return '';
            }
          })(),
          raw_content: '',
          extracted_summary: '',
          status: 'unverified',
          confidence_score: 25
        }
      ]);
    }

    if (pinoutTable.length > 0) {
      for (const row of pinoutTable) {
        await supabaseAdmin.from('ask_allie_facts').insert([
          {
            session_id: session.id,
            source_id: null,
            fact_type: 'pinout',
            component_name: 'Throttle Position Sensor',
            connector_name: '',
            pin_label: String(row.pin_label || '').trim(),
            wire_color: String(row.wire_color || '').trim(),
            circuit_function: String(row.circuit_function || '').trim(),
            expected_value: String(row.expected_value || '').trim(),
            conditions: '',
            application_year: String(jobContext.year || '').trim(),
            application_make: String(jobContext.make || '').trim(),
            application_model: String(jobContext.model || '').trim(),
            application_engine: String(jobContext.engine || '').trim(),
            fact_json: row,
            status: 'unverified',
            confidence_score: confidenceScore
          }
        ]);
      }
    }

    const { data: assistantMessage } = await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id: session.id,
          role: 'assistant',
          content: finalAnswer,
          metadata: {
            confidence_score: confidenceScore,
            pinout_table: pinoutTable,
            used_web: true
          }
        }
      ])
      .select()
      .single();

    const { data: sources } = await supabaseAdmin
      .from('ask_allie_sources')
      .select('id, source_type, title, url, domain, status, confidence_score, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false });

    return res.json({
      success: true,
      session_id: session.id,
      message_id: assistantMessage?.id || null,
      data: {
        answer: finalAnswer,
        confidence_score: confidenceScore,
        pinout_table: pinoutTable,
        used_web: true,
        web_query: [
          jobContext.year,
          jobContext.make,
          jobContext.model,
          jobContext.engine,
          question
        ].filter(Boolean).join(' '),
        sources: sources || []
      }
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
