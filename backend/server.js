const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =======================
// 🔑 KEYS (TEMP HARDCODED)
// =======================
const OPENAI_API_KEY = "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";
const TAVILY_API_KEY = "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";

const SUPABASE_URL = "https://julpheuumolnwkthazdj.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."; // keep yours
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// =======================
// 🔧 HEALTH CHECK
// =======================
app.get('/ask-allie-health', async (req, res) => {
  const { count } = await supabase
    .from('ask_allie_sessions')
    .select('*', { count: 'exact', head: true });

  res.json({
    success: true,
    status: 'ok',
    ask_allie_sessions_count: count || 0,
    openai_configured: !!OPENAI_API_KEY,
    tavily_configured: !!TAVILY_API_KEY
  });
});

// =======================
// 🔎 TAVILY SEARCH
// =======================
async function tavilySearch(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      include_images: true,
      max_results: 8
    })
  });

  const data = await res.json();
  return data;
}

// =======================
// 🧠 EXTRACTION ENGINE
// =======================
async function extractStructuredDataFromWeb(sources, jobContext) {
  const combinedText = sources
    .map(s => s.content || '')
    .join('\n\n')
    .slice(0, 12000);

  const prompt = `
Extract real automotive diagnostic data.

Vehicle:
${jobContext.year} ${jobContext.make} ${jobContext.model} ${jobContext.engine}

Content:
${combinedText}

Return JSON:
{
  "pinout_table": [
    {
      "pin": "",
      "wire_color": "",
      "function": "",
      "expected_voltage": ""
    }
  ],
  "key_specs": [],
  "diagnostic_notes": [],
  "confidence": 0
}
`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Extract structured automotive data.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// =======================
// 🤖 ASK ALLIE ROUTE
// =======================
app.post('/ask-allie', async (req, res) => {
  try {
    const { question, job_context } = req.body;

    // create session
    const { data: session } = await supabaseAdmin
      .from('ask_allie_sessions')
      .insert([job_context])
      .select()
      .single();

    const session_id = session.id;

    // save user message
    await supabaseAdmin.from('ask_allie_messages').insert([
      {
        session_id,
        role: 'user',
        content: question,
        metadata: { job_context }
      }
    ]);

    // search
    const query = `${job_context.year} ${job_context.make} ${job_context.model} ${question}`;
    const search = await tavilySearch(query);

    const sources = (search.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.content
    }));

    // extract
    const extracted = await extractStructuredDataFromWeb(sources, job_context);

    // save facts
    if (extracted && extracted.pinout_table.length > 0) {
      await supabaseAdmin.from('ask_allie_facts').insert([
        {
          session_id,
          fact_type: 'pinout',
          content: extracted,
          confidence_score: extracted.confidence || 50
        }
      ]);
    }

    // build answer
    let answer = "No structured data found.";

    if (extracted) {
      answer = `
PINOUT:
${JSON.stringify(extracted.pinout_table, null, 2)}

SPECS:
${extracted.key_specs.join('\n')}

NOTES:
${extracted.diagnostic_notes.join('\n')}
`;
    }

    // save assistant message
    const { data: message } = await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id,
          role: 'assistant',
          content: answer,
          metadata: {
            confidence: extracted?.confidence || 0
          }
        }
      ])
      .select()
      .single();

    res.json({
      success: true,
      session_id,
      message_id: message.id,
      data: {
        answer,
        confidence_score: extracted?.confidence || 0,
        pinout_table: extracted?.pinout_table || []
      }
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =======================
app.listen(3001, () => {
  console.log('Server running');
});
