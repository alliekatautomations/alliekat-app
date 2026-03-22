const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

function safeString(value) {
  return String(value || '').trim();
}

function lower(value) {
  return safeString(value).toLowerCase();
}

function normalizeCode(code) {
  return safeString(code).toUpperCase();
}

function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(v => safeString(v));
  if (!value) return [];
  return [safeString(value)];
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getOnlineCutoffIso(minutes = 15) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function cleanModelJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function buildAskAllieContext(body = {}) {
  const nested = body.job_context || {};
  return {
    vin: safeString(nested.vin || body.vin),
    year: safeString(nested.year || body.year),
    make: safeString(nested.make || body.make),
    model: safeString(nested.model || body.model),
    engine: safeString(nested.engine || body.engine),
    complaint: safeString(nested.complaint || body.complaint),
    dtcs: safeArray(nested.dtcs || body.dtcs),
    symptoms: safeArray(nested.symptoms || body.symptoms),
    prior_tests: safeArray(nested.prior_tests || nested.priorTests || body.prior_tests || body.priorTests),
    notes: safeString(nested.notes || body.notes)
  };
}

function buildAskAllieSearchQuery(question, ctx) {
  return [
    ctx.year,
    ctx.make,
    ctx.model,
    ctx.engine,
    safeArray(ctx.dtcs).join(' '),
    safeArray(ctx.symptoms).join(' '),
    ctx.complaint,
    'pinout connector wire color expected voltage testing procedure oem service manual',
    question
  ].filter(Boolean).join(' ');
}
async function tavilySearch(query) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: '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',
        query,
        search_depth: 'advanced',
        include_answer: false,
        include_images: true,
        max_results: 8
      })
    });

    const data = await response.json();

    return {
      query,
      used_web: true,
      results: data.results || [],
      images: data.images || [],
      warning: ''
    };
  } catch (err) {
    return {
      query,
      used_web: false,
      results: [],
      images: [],
      warning: err.message
    };
  }
}
function isBlockedSearchDomain(hostname) {
  const host = lower(hostname);
  return [
    'instagram.com',
    'www.instagram.com',
    'lookaside.instagram.com',
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'lookaside.fbsbx.com',
    'tiktok.com',
    'www.tiktok.com',
    'pinterest.com',
    'www.pinterest.com',
    'x.com',
    'twitter.com',
    'www.twitter.com'
  ].includes(host);
}

function looksLikeWeakSource(url, title) {
  const u = lower(url);
  const t = lower(title);
  return (
    u.includes('/reels/') ||
    u.includes('/shorts/') ||
    t.includes('instagram') ||
    t.includes('facebook') ||
    t.includes('pinterest')
  );
}

function dedupeByUrl(items) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const key = safeString(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function touchUserLastSeen(userId) {
  const cleanUserId = safeString(userId);
  if (!cleanUserId) return;

  try {
    await supabaseAdmin
      .from('user_profiles')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', cleanUserId);
  } catch (err) {
    console.log('touchUserLastSeen failed:', err.message);
  }
}

async function getLatestAccessRequestByEmail(email) {
  const cleanEmail = safeString(email).toLowerCase();
  if (!cleanEmail) return null;

  const { data, error } = await supabaseAdmin
    .from('access_requests')
    .select('*')
    .eq('email', cleanEmail)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  return data && data.length ? data[0] : null;
}

async function findAuthUserByEmail(email) {
  const cleanEmail = safeString(email).toLowerCase();
  let page = 1;
  let foundUser = null;

  while (!foundUser) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000
    });

    if (error) throw new Error(error.message);

    const users = data?.users || [];
    foundUser = users.find(user => safeString(user.email).toLowerCase() === cleanEmail) || null;

    if (foundUser || users.length < 1000) break;
    page += 1;
  }

  return foundUser;
}

async function decodeVIN(vin) {
  try {
    const cleanVin = safeString(vin);
    if (cleanVin.length < 11) return null;

    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${cleanVin}?format=json`);
    const data = await res.json();
    return data?.Results?.[0] || null;
  } catch {
    return null;
  }
}

function rowLooksUsableForLearning(row) {
  const finalFix = safeString(row.final_fix);
  if (!finalFix) return false;

  const status = lower(row.status);
  if (!status) return true;
  return ['fixed', 'complete', 'completed', 'closed'].includes(status);
}

function scoreLearningRow(row, normalizedCode, make, model, engine) {
  let score = 0;

  if (normalizedCode && lower(row.fault_code).includes(lower(normalizedCode))) score += 10;
  if (make && lower(row.make) === lower(make)) score += 4;
  if (model && lower(row.model) === lower(model)) score += 5;

  const rowEngine = lower(row.engine);
  const targetEngine = lower(engine);
  if (targetEngine && rowEngine) {
    if (rowEngine === targetEngine) score += 5;
    else if (rowEngine.includes(targetEngine) || targetEngine.includes(rowEngine)) score += 3;
  }

  const complaint = lower(row.complaint);
  if (complaint.includes('no throttle')) score += 1;
  if (lower(row.notes).includes('harness')) score += 1;

  return score;
}

function summarizeLearningRows(rows, normalizedCode, make, model, engine) {
  const fixesMap = new Map();

  for (const row of rows) {
    const finalFix = safeString(row.final_fix);
    if (!finalFix) continue;

    const key = finalFix.toLowerCase();
    const rowScore = scoreLearningRow(row, normalizedCode, make, model, engine);

    if (!fixesMap.has(key)) {
      fixesMap.set(key, {
        final_fix: finalFix,
        count: 0,
        weighted_score: 0,
        examples: []
      });
    }

    const item = fixesMap.get(key);
    item.count += 1;
    item.weighted_score += rowScore;

    if (item.examples.length < 3) {
      item.examples.push({
        vin: safeString(row.vin),
        make: safeString(row.make),
        model: safeString(row.model),
        engine: safeString(row.engine),
        fault_code: safeString(row.fault_code),
        complaint: safeString(row.complaint),
        notes: safeString(row.notes)
      });
    }
  }

  return Array.from(fixesMap.values())
    .sort((a, b) => {
      if (b.weighted_score !== a.weighted_score) return b.weighted_score - a.weighted_score;
      return b.count - a.count;
    })
    .slice(0, 5);
}

async function getLearningContext({ code, vehicleInfo }) {
  const normalizedCode = normalizeCode(code);
  const make = safeString(vehicleInfo?.Make);
  const model = safeString(vehicleInfo?.Model);
  const engine = safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL);

  const { data } = await supabaseAdmin
    .from('repair_cases')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(150);

  const usable = (data || []).filter(rowLooksUsableForLearning);

  const scored = usable
    .map(row => ({
      ...row,
      _score: scoreLearningRow(row, normalizedCode, make, model, engine)
    }))
    .filter(row => row._score > 0)
    .sort((a, b) => b._score - a._score);

  const topRows = scored.slice(0, 20);
  const suggestedFixes = summarizeLearningRows(topRows, normalizedCode, make, model, engine);

  return {
    total_matches: topRows.length,
    top_rows: topRows,
    suggested_fixes: suggestedFixes,
    strongest_fix: suggestedFixes[0] || null,
    aggressive_signal: suggestedFixes.length > 0 && suggestedFixes[0].count >= 1,
    aggressive_summary: suggestedFixes.length
      ? `Top learned fix: ${suggestedFixes[0].final_fix} | Seen ${suggestedFixes[0].count} time(s) | Weighted score ${suggestedFixes[0].weighted_score}`
      : 'No aggressive learning signal found.'
  };
}

function learningContextToText(learningContext) {
  if (!learningContext || !learningContext.total_matches) {
    return 'No prior confirmed repair history found in the internal database.';
  }

  const lines = [];
  lines.push(`Aggressive learning matches found: ${learningContext.total_matches}`);
  lines.push(learningContext.aggressive_summary || '');

  if (learningContext.suggested_fixes?.length) {
    lines.push('Prioritized confirmed fixes:');
    for (const fix of learningContext.suggested_fixes) {
      lines.push(`- ${fix.final_fix} | count=${fix.count} | weighted_score=${fix.weighted_score}`);
    }
  }

  if (learningContext.top_rows?.length) {
    lines.push('Highest-scoring historical matches:');
    for (const row of learningContext.top_rows.slice(0, 6)) {
      lines.push(
        `- score=${row._score} | ${safeString(row.make)} ${safeString(row.model)} ${safeString(row.engine)} | code=${safeString(row.fault_code)} | complaint=${safeString(row.complaint)} | fix=${safeString(row.final_fix)} | notes=${safeString(row.notes)}`
      );
    }
  }

  return lines.join('\n');
}

function buildQuickTree(payload) {
  const code = normalizeCode(payload.code);
  const symptom = safeString(payload.symptom);
  const notes = safeString(payload.notes);

  return {
    issue_summary: code
      ? `Rapid-start diagnostic path for DTC ${code}${symptom ? ` with complaint: ${symptom}` : ''}`
      : `Rapid-start diagnostic path${symptom ? ` for complaint: ${symptom}` : ''}`,
    current_position: notes
      ? `Technician notes already entered: ${notes}`
      : code
        ? `Starting rapid tree using entered DTC ${code}`
        : 'Starting rapid tree with no DTC-specific information entered.',
    current_step_id: 'step_1',
    steps: [
      {
        id: 'step_1',
        title: code ? `Verify DTC ${code} and complaint` : 'Verify complaint and active fault',
        instruction: code
          ? `Confirm DTC ${code} is active/current and verify the complaint is present now.`
          : `Confirm the complaint is present now and determine whether the fault is active or intermittent.`,
        where_to_test: 'Scan tool, key on / engine off and key on / engine running as applicable.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: code ? `Live data and fault state should support DTC ${code}` : 'Fault state should match complaint condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Record whether the fault is active, inactive, history-only, or resets immediately after clearing.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_2' },
          { label: 'FAIL', next_step_id: 'step_fail_1' },
          { label: 'NOT TESTED', next_step_id: 'step_2' }
        ]
      }
    ],
    likely_fault_path: code
      ? `Most likely rapid-start path for DTC ${code} is circuit, connector, harness, or signal-path issue first.`
      : 'Most likely path is circuit, connector, harness, or signal-path issue first.',
    final_recommendation: code
      ? `Walk the rapid-start tree for DTC ${code} and save the actual final repair once the unit is fixed.`
      : 'Walk the rapid-start tree and save the actual final repair once the unit is fixed.',
    source: 'fast-detailed-code-aware'
  };
}

function normalizeTree(modelTree, payload, vehicleInfo, sourceLabel = 'openai') {
  const fallback = buildQuickTree(payload);
  if (!modelTree || typeof modelTree !== 'object') return fallback;

  const steps = Array.isArray(modelTree.steps) ? modelTree.steps : fallback.steps;

  return {
    issue_summary: safeString(modelTree.issue_summary) || fallback.issue_summary,
    current_position: safeString(modelTree.current_position) || fallback.current_position,
    current_step_id: safeString(modelTree.current_step_id) || (steps[0]?.id || 'step_1'),
    steps: steps.map((step, index) => ({
      id: safeString(step.id) || `step_${index + 1}`,
      title: safeString(step.title) || `Step ${index + 1}`,
      instruction: safeString(step.instruction) || '',
      where_to_test: safeString(step.where_to_test) || '',
      expected_specs: {
        voltage: safeString(step?.expected_specs?.voltage) || 'Verify exact OEM spec/pinout for this platform',
        ohms: safeString(step?.expected_specs?.ohms) || 'Verify exact OEM spec/pinout for this platform',
        pressure: safeString(step?.expected_specs?.pressure) || 'Verify exact OEM spec/pinout for this platform',
        signal: safeString(step?.expected_specs?.signal) || 'Verify exact OEM spec/pinout for this platform',
        voltage_drop: safeString(step?.expected_specs?.voltage_drop) || 'Verify exact OEM spec/pinout for this platform'
      },
      how_to_test: safeString(step.how_to_test) || '',
      result_buttons: Array.isArray(step.result_buttons)
        ? step.result_buttons.map(btn => ({
            label: safeString(btn.label) || 'NEXT',
            next_step_id: safeString(btn.next_step_id) || ''
          }))
        : []
    })),
    likely_fault_path: safeString(modelTree.likely_fault_path) || fallback.likely_fault_path,
    final_recommendation: safeString(modelTree.final_recommendation) || fallback.final_recommendation,
    source: sourceLabel,
    vehicle_snapshot: {
      vin: safeString(payload.vin),
      year: safeString(vehicleInfo?.ModelYear),
      make: safeString(vehicleInfo?.Make),
      model: safeString(vehicleInfo?.Model),
      engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
      trim: safeString(vehicleInfo?.Trim),
      driveType: safeString(vehicleInfo?.DriveType),
      fuelType: safeString(vehicleInfo?.FuelTypePrimary)
    }
  };
}

async function callOpenAIForTree({ vin, code, symptom, notes, vehicleInfo, learningContext, mode }) {
  const learningText = learningContextToText(learningContext);

  const systemPrompt = mode === 'expert'
    ? `
You are a senior master technician writing an OEM-grade EXPERT diagnostic tree.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Rules:
- This must be excellent, not generic.
- Use DTC, complaint, notes, vehicle, and learned fixes aggressively.
- Move likely fault isolation early.
- Write like an OEM guided diagnostic or senior field tech.
- Include connector drag, spread terminal inspection, loaded voltage drop, low-reference integrity, 5V reference verification, signal sweep, harness wiggle under meter, and compare-at-ECM checks where relevant.
- If notes suggest harness damage, make that early and specific.
- Prefer 5 to 7 high-value steps.
- Explain exactly how to do each test and what PASS/FAIL means.
- If exact OEM pin numbers are not certain, say "Verify exact OEM pinout for this platform".
- Do not invent exact pin numbers.
- Avoid weak filler like "inspect wiring" without specifics.

Return JSON exactly in this shape:
{
  "issue_summary": "string",
  "current_position": "string",
  "current_step_id": "step_1",
  "steps": [
    {
      "id": "step_1",
      "title": "string",
      "instruction": "string",
      "where_to_test": "string",
      "expected_specs": {
        "voltage": "string",
        "ohms": "string",
        "pressure": "string",
        "signal": "string",
        "voltage_drop": "string"
      },
      "how_to_test": "string",
      "result_buttons": [
        { "label": "PASS", "next_step_id": "step_2" },
        { "label": "FAIL", "next_step_id": "step_fail_1" },
        { "label": "NOT TESTED", "next_step_id": "step_2" }
      ]
    }
  ],
  "likely_fault_path": "string",
  "final_recommendation": "string"
}
`
    : `
You are a senior master technician writing a strong NORMAL diagnostic tree.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Rules:
- This must be excellent shop-grade guidance, not generic advice.
- Use the actual DTC, complaint, notes, and vehicle.
- Prefer 6 to 8 steps.
- Include verification, reference voltage, low-reference/ground, signal sweep, wiggle test, connector inspection, continuity while moving harness, loaded voltage drop, and compare-at-module checks where relevant.
- Explain exactly how to perform each test.
- Explain what PASS and FAIL mean.
- If exact OEM pin numbers are not certain, say "Verify exact OEM pinout for this platform".
- Do not invent exact pin numbers.
- Avoid weak filler.

Return JSON exactly in this shape:
{
  "issue_summary": "string",
  "current_position": "string",
  "current_step_id": "step_1",
  "steps": [
    {
      "id": "step_1",
      "title": "string",
      "instruction": "string",
      "where_to_test": "string",
      "expected_specs": {
        "voltage": "string",
        "ohms": "string",
        "pressure": "string",
        "signal": "string",
        "voltage_drop": "string"
      },
      "how_to_test": "string",
      "result_buttons": [
        { "label": "PASS", "next_step_id": "step_2" },
        { "label": "FAIL", "next_step_id": "step_fail_1" },
        { "label": "NOT TESTED", "next_step_id": "step_2" }
      ]
    }
  ],
  "likely_fault_path": "string",
  "final_recommendation": "string"
}
`;

  const userPrompt = `
VIN: ${vin || 'not provided'}
Make: ${vehicleInfo?.Make || 'unknown'}
Model: ${vehicleInfo?.Model || 'unknown'}
Year: ${vehicleInfo?.ModelYear || 'unknown'}
Engine: ${vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL || 'unknown'}
Trim: ${vehicleInfo?.Trim || 'unknown'}
Drive Type: ${vehicleInfo?.DriveType || 'unknown'}
Fuel Type: ${vehicleInfo?.FuelTypePrimary || 'unknown'}

Fault Code: ${code || 'none provided'}
Symptom: ${symptom || 'none provided'}
Completed tests / notes: ${notes || 'none provided'}

AGGRESSIVE LEARNING CONTEXT:
${learningText}

Build the ${mode === 'expert' ? 'expert' : 'normal'} diagnostic tree now.
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': '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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: mode === 'expert' ? 0.05 : 0.08,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    return normalizeTree(
      parsed,
      { vin, code, symptom, notes },
      vehicleInfo,
      mode === 'expert' ? 'openai-expert-aggressive' : 'openai-aggressive'
    );
  } catch {
    return buildQuickTree({ vin, code, symptom, notes });
  }
}

app.post('/diagnose', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const code = safeString(req.body.code);
    const symptom = safeString(req.body.symptom);
    const notes = safeString(req.body.notes);

    const quickTree = buildQuickTree({ vin, code, symptom, notes });

    res.json({
      success: true,
      mode: 'step-tree',
      tree: quickTree
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/diagnose-detailed', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const code = safeString(req.body.code);
    const symptom = safeString(req.body.symptom);
    const notes = safeString(req.body.notes);

    let vehicleInfo = null;
    if (vin && vin.length >= 11) {
      vehicleInfo = await decodeVIN(vin);
    }

    const learningContext = await getLearningContext({ code, vehicleInfo });

    const detailedTree = await callOpenAIForTree({
      vin,
      code,
      symptom,
      notes,
      vehicleInfo,
      learningContext,
      mode: 'standard'
    });

    res.json({
      success: true,
      tree: detailedTree,
      vehicle: {
        vin,
        year: safeString(vehicleInfo?.ModelYear),
        make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model),
        engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim),
        driveType: safeString(vehicleInfo?.DriveType),
        fuelType: safeString(vehicleInfo?.FuelTypePrimary)
      },
      learning_matches: learningContext.total_matches,
      suggested_fixes: learningContext.suggested_fixes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/diagnose-expert', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const code = safeString(req.body.code);
    const symptom = safeString(req.body.symptom);
    const notes = safeString(req.body.notes);

    let vehicleInfo = null;
    if (vin && vin.length >= 11) {
      vehicleInfo = await decodeVIN(vin);
    }

    const learningContext = await getLearningContext({ code, vehicleInfo });

    const expertTree = await callOpenAIForTree({
      vin,
      code,
      symptom,
      notes,
      vehicleInfo,
      learningContext,
      mode: 'expert'
    });

    res.json({
      success: true,
      tree: expertTree,
      vehicle: {
        vin,
        year: safeString(vehicleInfo?.ModelYear),
        make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model),
        engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim),
        driveType: safeString(vehicleInfo?.DriveType),
        fuelType: safeString(vehicleInfo?.FuelTypePrimary)
      },
      learning_matches: learningContext.total_matches,
      suggested_fixes: learningContext.suggested_fixes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/ask-allie', async (req, res) => {
  try {
    const question = safeString(req.body.question);
    const incomingSessionId = safeString(req.body.session_id);
    const jobContext = buildAskAllieContext(req.body);

    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    let session = null;

    if (incomingSessionId) {
      const { data: existingSession } = await supabaseAdmin
        .from('ask_allie_sessions')
        .select('*')
        .eq('id', incomingSessionId)
        .single();

      if (existingSession) session = existingSession;
    }

    if (!session) {
      const { data: insertedSession, error: sessionError } = await supabaseAdmin
        .from('ask_allie_sessions')
        .insert([
          {
            vin: jobContext.vin || null,
            year: jobContext.year || null,
            make: jobContext.make || null,
            model: jobContext.model || null,
            engine: jobContext.engine || null,
            complaint: jobContext.complaint || null,
            dtcs: jobContext.dtcs,
            symptoms: jobContext.symptoms,
            prior_tests: jobContext.prior_tests,
            notes: jobContext.notes || null,
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (sessionError) {
        return res.status(500).json({
          success: false,
          error: `ask_allie_sessions insert failed: ${sessionError.message}`
        });
      }

      session = insertedSession;
    }

    const sessionId = session.id;

    await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id: sessionId,
          role: 'user',
          content: question,
          metadata: { job_context: jobContext }
        }
      ]);

    const internalKnowledge = await searchAskAllieInternalKnowledge(question, jobContext);
    const shouldUseWeb = computeAskAllieNeedWeb(question, internalKnowledge);

    let externalResearch = {
      query: '',
      used_web: false,
      results: [],
      images: [],
      warning: ''
    };

    if (shouldUseWeb) {
      externalResearch = await tavilySearch(buildAskAllieSearchQuery(question, jobContext));
    }

    const savedWebSourceRows = [];
    for (const item of (externalResearch.results || []).slice(0, 5)) {
      const sourceRow = await saveAskAllieSource(sessionId, {
        source_type: 'web',
        title: item.title,
        url: item.url,
        domain: (() => {
          try {
            return new URL(item.url).hostname;
          } catch {
            return '';
          }
        })(),
        raw_content: safeString(item.raw_content || item.content),
        extracted_summary: safeString(item.content || item.raw_content),
        status: 'unverified',
        confidence_score: 40
      });

      savedWebSourceRows.push(sourceRow);
    }

    for (const imageUrl of (externalResearch.images || []).slice(0, 5)) {
      await saveAskAllieSource(sessionId, {
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
      });
    }

    const extractionInputSources = savedWebSourceRows.map(row => ({
      extracted_summary: row.extracted_summary,
      raw_content: row.raw_content
    }));

    const extracted = await extractStructuredDataFromWeb(extractionInputSources, jobContext, question);

    if (extracted && (extracted.pinout_table?.length || extracted.key_specs?.length)) {
      const sourceIdForFacts = savedWebSourceRows[0]?.id || null;
      await saveAskAllieFacts(sessionId, sourceIdForFacts, extracted, jobContext);
    }

    let answerPayload = await synthesizeAskAllieAnswer({
      question,
      jobContext,
      internalKnowledge,
      externalResearch,
      extracted
    });

    if (!answerPayload) {
      answerPayload = buildAskAllieFallbackAnswer(extracted, externalResearch);
    }

    await promoteAskAllieConfidence(sessionId, answerPayload.confidence_score);

    const { data: assistantMessage, error: assistantMessageError } = await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id: sessionId,
          role: 'assistant',
          content: answerPayload.answer,
          metadata: {
            confidence_score: toNumber(answerPayload.confidence_score, 0),
            match_level: safeString(answerPayload.match_level),
            best_image_urls: answerPayload.best_image_urls || [],
            pinout_table: answerPayload.pinout_table || [],
            warnings: answerPayload.warnings || [],
            next_steps: answerPayload.next_steps || [],
            used_web: Boolean(externalResearch.used_web),
            web_query: safeString(externalResearch.query)
          }
        }
      ])
      .select()
      .single();

    if (assistantMessageError) {
      return res.status(500).json({ success: false, error: assistantMessageError.message });
    }

    const sourceList = await buildAskAllieSourceList(sessionId);

    return res.json({
      success: true,
      session_id: sessionId,
      message_id: assistantMessage.id,
      data: {
        answer: answerPayload.answer,
        confidence_score: toNumber(answerPayload.confidence_score, 0),
        match_level: safeString(answerPayload.match_level) || 'low',
        best_image_urls: answerPayload.best_image_urls || [],
        pinout_table: answerPayload.pinout_table || [],
        warnings: answerPayload.warnings || [],
        next_steps: answerPayload.next_steps || [],
        used_web: Boolean(externalResearch.used_web),
        web_query: safeString(externalResearch.query),
        sources: sourceList
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
