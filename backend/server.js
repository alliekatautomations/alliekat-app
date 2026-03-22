const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================
// READ KEYS FROM ENVIRONMENT
// =========================
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

const supabase = createClient(
  'https://julpheuumolnwkthazdj.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM'
);

const supabaseAdmin = createClient(
  'https://julpheuumolnwkthazdj.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* =========================
   HELPERS
========================= */

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
    ctx.year, ctx.make, ctx.model, ctx.engine,
    safeArray(ctx.dtcs).join(' '),
    safeArray(ctx.symptoms).join(' '),
    ctx.complaint,
    'pinout connector wire color expected voltage testing procedure oem service manual',
    question
  ].filter(Boolean).join(' ');
}

function isBlockedSearchDomain(hostname) {
  const host = lower(hostname);
  return [
    'instagram.com', 'www.instagram.com', 'lookaside.instagram.com',
    'facebook.com', 'www.facebook.com', 'm.facebook.com', 'lookaside.fbsbx.com',
    'tiktok.com', 'www.tiktok.com', 'pinterest.com', 'www.pinterest.com',
    'x.com', 'twitter.com', 'www.twitter.com'
  ].includes(host);
}

function looksLikeWeakSource(url, title) {
  const u = lower(url);
  const t = lower(title);
  return (
    u.includes('/reels/') || u.includes('/shorts/') ||
    t.includes('instagram') || t.includes('facebook') || t.includes('pinterest')
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

async function findAuthUserByEmail(email) {
  const cleanEmail = safeString(email).toLowerCase();
  let page = 1;
  let foundUser = null;
  while (!foundUser) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
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

/* =========================
   LEARNING HELPERS
========================= */

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
      fixesMap.set(key, { final_fix: finalFix, count: 0, weighted_score: 0, examples: [] });
    }
    const item = fixesMap.get(key);
    item.count += 1;
    item.weighted_score += rowScore;
    if (item.examples.length < 3) {
      item.examples.push({
        vin: safeString(row.vin), make: safeString(row.make), model: safeString(row.model),
        engine: safeString(row.engine), fault_code: safeString(row.fault_code),
        complaint: safeString(row.complaint), notes: safeString(row.notes)
      });
    }
  }
  return Array.from(fixesMap.values())
    .sort((a, b) => b.weighted_score !== a.weighted_score ? b.weighted_score - a.weighted_score : b.count - a.count)
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
    .map(row => ({ ...row, _score: scoreLearningRow(row, normalizedCode, make, model, engine) }))
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
      lines.push(`- score=${row._score} | ${safeString(row.make)} ${safeString(row.model)} ${safeString(row.engine)} | code=${safeString(row.fault_code)} | complaint=${safeString(row.complaint)} | fix=${safeString(row.final_fix)} | notes=${safeString(row.notes)}`);
    }
  }
  return lines.join('\n');
}

/* =========================
   TREE ENGINE
========================= */

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
      : code ? `Starting rapid tree using entered DTC ${code}` : 'Starting rapid tree with no DTC-specific information entered.',
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
    ? `You are a senior master technician writing an OEM-grade EXPERT diagnostic tree. You must return ONLY valid JSON. No markdown. No code fences. No extra commentary.
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
{"issue_summary":"","current_position":"","current_step_id":"step_1","steps":[{"id":"step_1","title":"","instruction":"","where_to_test":"","expected_specs":{"voltage":"","ohms":"","pressure":"","signal":"","voltage_drop":""},"how_to_test":"","result_buttons":[{"label":"PASS","next_step_id":"step_2"},{"label":"FAIL","next_step_id":"step_fail_1"},{"label":"NOT TESTED","next_step_id":"step_2"}]}],"likely_fault_path":"","final_recommendation":""}`
    : `You are a senior master technician writing a strong NORMAL diagnostic tree. You must return ONLY valid JSON. No markdown. No code fences. No extra commentary.
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
{"issue_summary":"","current_position":"","current_step_id":"step_1","steps":[{"id":"step_1","title":"","instruction":"","where_to_test":"","expected_specs":{"voltage":"","ohms":"","pressure":"","signal":"","voltage_drop":""},"how_to_test":"","result_buttons":[{"label":"PASS","next_step_id":"step_2"},{"label":"FAIL","next_step_id":"step_fail_1"},{"label":"NOT TESTED","next_step_id":"step_2"}]}],"likely_fault_path":"","final_recommendation":""}`;

  const userPrompt = `VIN: ${vin || 'not provided'}
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
Build the ${mode === 'expert' ? 'expert' : 'normal'} diagnostic tree now.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: mode === 'expert' ? 0.05 : 0.08,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();

  if (data.error) {
    console.error('OpenAI tree error:', data.error);
    throw new Error(`OpenAI error: ${data.error.message}`);
  }

  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = cleanModelJson(content);

  return normalizeTree(
    parsed,
    { vin, code, symptom, notes },
    vehicleInfo,
    mode === 'expert' ? 'openai-expert-aggressive' : 'openai-aggressive'
  );
}

async function tavilySearch(query) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'advanced',
        include_answer: false,
        include_images: true,
        include_raw_content: true,
        max_results: 10
      })
    });

    const data = await response.json();

    const filteredResults = dedupeByUrl(
      (Array.isArray(data?.results) ? data.results : []).filter(item => {
        const url = safeString(item.url);
        const title = safeString(item.title);
        let host = '';
        try { host = new URL(url).hostname; } catch { host = ''; }
        if (!url || !title) return false;
        if (isBlockedSearchDomain(host)) return false;
        if (looksLikeWeakSource(url, title)) return false;
        return true;
      })
    ).slice(0, 6);

    const filteredImages = dedupeByUrl(
      (Array.isArray(data?.images) ? data.images : [])
        .filter(url => {
          let host = '';
          try { host = new URL(url).hostname; } catch { host = ''; }
          return !isBlockedSearchDomain(host);
        })
        .map(url => ({ url }))
    ).map(x => x.url).slice(0, 5);

    return { query, results: filteredResults, images: filteredImages, used_web: true, warning: '' };
  } catch (err) {
    console.error('Tavily search error:', err.message);
    return { query, results: [], images: [], used_web: false, warning: `Tavily error: ${err.message}` };
  }
}

async function saveAskAllieSource(sessionId, source) {
  try {
    const { data, error } = await supabaseAdmin
      .from('ask_allie_sources')
      .insert([{
        session_id: sessionId,
        source_type: safeString(source.source_type),
        title: safeString(source.title),
        url: safeString(source.url),
        domain: safeString(source.domain),
        raw_content: safeString(source.raw_content),
        extracted_summary: safeString(source.extracted_summary),
        status: safeString(source.status) || 'unverified',
        confidence_score: toNumber(source.confidence_score, 0)
      }])
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  } catch (err) {
    console.log('saveAskAllieSource failed (table may not exist):', err.message);
    return null;
  }
}

async function saveAskAllieFacts(sessionId, sourceId, extracted, jobContext) {
  try {
    const rows = [];
    const pinoutTable = Array.isArray(extracted?.pinout_table) ? extracted.pinout_table : [];
    for (const pin of pinoutTable) {
      rows.push({
        session_id: sessionId, source_id: sourceId || null, fact_type: 'pinout',
        component_name: safeString(extracted?.component_name || ''),
        connector_name: safeString(extracted?.connector_name),
        pin_label: safeString(pin.pin || pin.pin_label), wire_color: safeString(pin.wire_color),
        circuit_function: safeString(pin.function || pin.circuit_function),
        expected_value: safeString(pin.expected_voltage || pin.expected_value),
        conditions: safeString(extracted?.conditions),
        application_year: safeString(jobContext.year), application_make: safeString(jobContext.make),
        application_model: safeString(jobContext.model), application_engine: safeString(jobContext.engine),
        fact_json: pin, status: 'unverified', confidence_score: toNumber(extracted?.confidence, 0)
      });
    }
    const keySpecs = Array.isArray(extracted?.key_specs) ? extracted.key_specs : [];
    for (const spec of keySpecs) {
      rows.push({
        session_id: sessionId, source_id: sourceId || null, fact_type: 'spec',
        component_name: safeString(extracted?.component_name || ''),
        connector_name: safeString(extracted?.connector_name), pin_label: '', wire_color: '',
        circuit_function: 'Spec', expected_value: safeString(spec),
        conditions: safeString(extracted?.conditions),
        application_year: safeString(jobContext.year), application_make: safeString(jobContext.make),
        application_model: safeString(jobContext.model), application_engine: safeString(jobContext.engine),
        fact_json: { spec }, status: 'unverified', confidence_score: toNumber(extracted?.confidence, 0)
      });
    }
    if (!rows.length) return [];
    const { data, error } = await supabaseAdmin.from('ask_allie_facts').insert(rows).select();
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.log('saveAskAllieFacts failed (table may not exist):', err.message);
    return [];
  }
}

async function extractStructuredDataFromWeb(sources, jobContext, question) {
  try {
    const combinedText = (sources || [])
      .map(s => safeString(s.extracted_summary || s.raw_content || s.content))
      .join('\n\n').slice(0, 15000);

    if (!combinedText) return null;

    const prompt = `You are a master automotive diagnostic data extractor.
Extract only usable structured data from the source text below for this exact application.
Question: ${question}
Vehicle: ${jobContext.year} ${jobContext.make} ${jobContext.model} ${jobContext.engine}
Complaint: ${jobContext.complaint}
DTCs: ${safeArray(jobContext.dtcs).join(', ')}
Notes: ${jobContext.notes}
Content: ${combinedText}
Return ONLY valid JSON:
{"component_name":"","connector_name":"","conditions":"","pinout_table":[{"pin":"","wire_color":"","function":"","expected_voltage":""}],"key_specs":[],"diagnostic_notes":[],"confidence":0}
Rules: Prefer application-specific facts. Do not invent exact pin numbers. confidence must be 0 to 100.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.05,
        messages: [{ role: 'system', content: 'Return only valid JSON.' }, { role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return null;

    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      component_name: safeString(parsed.component_name), connector_name: safeString(parsed.connector_name),
      conditions: safeString(parsed.conditions),
      pinout_table: Array.isArray(parsed.pinout_table) ? parsed.pinout_table : [],
      key_specs: Array.isArray(parsed.key_specs) ? parsed.key_specs : [],
      diagnostic_notes: Array.isArray(parsed.diagnostic_notes) ? parsed.diagnostic_notes : [],
      confidence: toNumber(parsed.confidence, 0)
    };
  } catch (err) {
    console.log('extractStructuredDataFromWeb failed:', err.message);
    return null;
  }
}

async function searchAskAllieInternalKnowledge(question, ctx) {
  try {
    const questionText = lower(question);
    const componentHints = [
      'throttle', 'pedal', 'accelerator', 'map', 'maf', 'cam', 'crank', 'abs',
      'injector', 'fuel', 'egr', 'vgt', 'boost', 'temperature', 'pressure',
      'sensor', 'switch', 'solenoid', 'connector', 'wiring'
    ].filter(term => questionText.includes(term));

    const { data: factsData } = await supabaseAdmin
      .from('ask_allie_facts').select('*')
      .eq('application_make', ctx.make || null).eq('application_model', ctx.model || null)
      .eq('application_engine', ctx.engine || null)
      .order('confidence_score', { ascending: false }).limit(50);

    const filteredFacts = (factsData || []).filter(row => {
      const haystack = lower([
        row.fact_type, row.component_name, row.connector_name, row.pin_label,
        row.wire_color, row.circuit_function, row.expected_value, JSON.stringify(row.fact_json || {})
      ].join(' '));
      if (componentHints.length === 0) return true;
      return componentHints.some(term => haystack.includes(term));
    });

    const dtcFilters = safeArray(ctx.dtcs).map(lower);

    const { data: fixesData } = await supabaseAdmin
      .from('ask_allie_known_fixes').select('*')
      .eq('make', ctx.make || null).eq('model', ctx.model || null).eq('engine', ctx.engine || null)
      .order('confidence_score', { ascending: false }).limit(25);

    const filteredFixes = (fixesData || []).filter(row => {
      const haystack = lower([row.symptom_pattern, row.root_cause, row.repair_performed, safeArray(row.dtcs).join(' ')].join(' '));
      if (dtcFilters.length && dtcFilters.some(code => haystack.includes(code))) return true;
      if (componentHints.length && componentHints.some(term => haystack.includes(term))) return true;
      if (!dtcFilters.length && !componentHints.length) return true;
      return false;
    });

    return { facts: filteredFacts.slice(0, 20), known_fixes: filteredFixes.slice(0, 10) };
  } catch (err) {
    console.log('searchAskAllieInternalKnowledge failed:', err.message);
    return { facts: [], known_fixes: [] };
  }
}

function computeAskAllieNeedWeb(question, internalKnowledge) {
  const asksForWiringData = /pinout|connector|wire|wiring|diagram|image|picture|photo|voltage|ohms|spec|reference|testing procedure/i.test(safeString(question));
  const verifiedFacts = (internalKnowledge.facts || []).filter(
    row => ['cross_checked', 'tech_confirmed', 'repair_confirmed'].includes(lower(row.status))
  );
  if (asksForWiringData && verifiedFacts.length === 0) return true;
  if ((internalKnowledge.facts || []).length === 0 && (internalKnowledge.known_fixes || []).length === 0) return true;
  return false;
}

// ==============================================
// CORE ASK ALLIE AI — this is the main brain.
// Responds like a real senior mechanic using
// all available context + web data.
// ==============================================
async function synthesizeAskAllieAnswer({ question, jobContext, internalKnowledge, externalResearch, extracted }) {
  try {
    const internalFactSummary = (internalKnowledge.facts || []).slice(0, 8).map(row => ({
      fact_type: row.fact_type, component_name: row.component_name, connector_name: row.connector_name,
      pin_label: row.pin_label, wire_color: row.wire_color, circuit_function: row.circuit_function,
      expected_value: row.expected_value, status: row.status, confidence_score: row.confidence_score
    }));

    const knownFixSummary = (internalKnowledge.known_fixes || []).slice(0, 5).map(row => ({
      dtcs: row.dtcs, symptom_pattern: row.symptom_pattern, root_cause: row.root_cause,
      repair_performed: row.repair_performed, outcome: row.outcome, confidence_score: row.confidence_score
    }));

    const webSummary = (externalResearch.results || []).slice(0, 4).map(r => ({
      title: safeString(r.title),
      content: safeString(r.content || r.raw_content).slice(0, 800)
    }));

    const systemPrompt = `You are Allie, a senior master automotive diagnostic technician and AI assistant built into a shop diagnostic tool called Allie-Kat Diagnostics.

Your job is to help mechanics diagnose and fix vehicles. You think like a 20+ year master tech. You are direct, practical, and specific to the vehicle and fault code in front of you.

Rules:
- Always respond directly to the mechanic's question
- Use the vehicle info, DTC, complaint, and notes to give specific advice — not generic answers
- If web data was found, use it to give better specs, pinouts, or procedures
- If internal known fixes exist, lead with those
- Give actionable next steps a mechanic can do right now in the shop
- Be conversational but professional — like a senior tech helping a junior
- CRITICAL: If the question asks for a pinout or connector data, put ALL pin data in the pinout_table array — do NOT put pipe-separated tables or pin data inside the answer text field. The answer field should be clean readable prose only — introduce what you found, then the UI will render the table automatically.
- Always give next_steps a mechanic can act on
- Do not make up exact pin numbers if you are not sure — say "verify exact OEM pinout"
- confidence_score is 0-100 based on how specific and verified your answer is
- next_steps must be short actionable shop tests, not paragraphs

Return ONLY valid JSON in exactly this shape:
{"answer":"","confidence_score":0,"match_level":"high | medium | low","best_image_urls":[],"pinout_table":[{"pin_label":"","wire_color":"","circuit_function":"","expected_value":"","notes":""}],"warnings":[],"next_steps":[]}`;

    const userPrompt = `CURRENT JOB:
VIN: ${jobContext.vin || 'not provided'}
Year: ${jobContext.year || 'unknown'}
Make: ${jobContext.make || 'unknown'}
Model: ${jobContext.model || 'unknown'}
Engine: ${jobContext.engine || 'unknown'}
DTC(s): ${safeArray(jobContext.dtcs).join(', ') || 'none'}
Complaint: ${jobContext.complaint || 'none'}
Tech Notes: ${jobContext.notes || 'none'}

MECHANIC'S QUESTION: ${question}

INTERNAL KNOWN FIXES FROM DATABASE:
${JSON.stringify(knownFixSummary, null, 2)}

INTERNAL PINOUT/SPEC FACTS FROM DATABASE:
${JSON.stringify(internalFactSummary, null, 2)}

WEB RESEARCH RESULTS:
${JSON.stringify(webSummary, null, 2)}

EXTRACTED STRUCTURED DATA FROM WEB:
${JSON.stringify(extracted || {}, null, 2)}

IMAGE URLS FOUND:
${JSON.stringify((externalResearch.images || []).slice(0, 5), null, 2)}

Answer the mechanic's question now. Be specific to this vehicle and fault. Give real shop guidance.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.15,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('OpenAI synthesize error:', data.error);
      return null;
    }

    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    if (!parsed || typeof parsed !== 'object') return null;

    return {
      answer: safeString(parsed.answer),
      confidence_score: toNumber(parsed.confidence_score, toNumber(extracted?.confidence, 0)),
      match_level: safeString(parsed.match_level) || 'medium',
      best_image_urls: Array.isArray(parsed.best_image_urls) ? parsed.best_image_urls : [],
      pinout_table: Array.isArray(parsed.pinout_table) ? parsed.pinout_table : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : []
    };
  } catch (err) {
    console.error('synthesizeAskAllieAnswer failed:', err.message);
    return null;
  }
}

function buildAskAllieFallbackAnswer(extracted, externalResearch) {
  const pinoutTable = Array.isArray(extracted?.pinout_table)
    ? extracted.pinout_table.map(pin => ({
        pin_label: safeString(pin.pin || pin.pin_label), wire_color: safeString(pin.wire_color),
        circuit_function: safeString(pin.function || pin.circuit_function),
        expected_value: safeString(pin.expected_voltage || pin.expected_value), notes: ''
      }))
    : [];

  const answerLines = [];
  if (pinoutTable.length) {
    answerLines.push('Possible application-related pinout/spec data found:');
    for (const pin of pinoutTable) {
      answerLines.push(`Pin ${pin.pin_label || '(verify exact cavity)'} | ${pin.wire_color || 'wire color not confirmed'} | ${pin.circuit_function || 'function not confirmed'} | ${pin.expected_value || 'verify exact expected voltage'}`);
    }
  }

  const specs = Array.isArray(extracted?.key_specs) ? extracted.key_specs : [];
  if (specs.length) {
    answerLines.push('');
    answerLines.push('Key specs:');
    for (const spec of specs) { answerLines.push(`- ${safeString(spec)}`); }
  }

  if (!answerLines.length) {
    answerLines.push('I was unable to reach the AI service right now. Please check your connection and try again. If the issue continues, verify the OpenAI API key in your Render environment variables.');
  }

  return {
    answer: answerLines.join('\n'),
    confidence_score: toNumber(extracted?.confidence, 20),
    match_level: 'low',
    best_image_urls: Array.isArray(externalResearch?.images) ? externalResearch.images.slice(0, 5) : [],
    pinout_table: pinoutTable,
    warnings: ['AI service may be unavailable. Check OpenAI API key in Render environment variables.'],
    next_steps: []
  };
}

async function promoteAskAllieConfidence(sessionId, confidenceScore) {
  try {
    const score = toNumber(confidenceScore, 0);
    if (score < 75) return;
    await supabaseAdmin.from('ask_allie_sources').update({ status: 'cross_checked', confidence_score: score }).eq('session_id', sessionId).eq('status', 'unverified');
    await supabaseAdmin.from('ask_allie_facts').update({ status: 'cross_checked', confidence_score: score }).eq('session_id', sessionId).eq('status', 'unverified');
  } catch (err) {
    console.log('promoteAskAllieConfidence failed:', err.message);
  }
}

async function buildAskAllieSourceList(sessionId) {
  try {
    const { data } = await supabaseAdmin
      .from('ask_allie_sources')
      .select('id, source_type, title, url, domain, status, confidence_score, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(20);
    return data || [];
  } catch (err) {
    return [];
  }
}

/* =========================
   ROUTES
========================= */

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
});

// --- AUTH ---

app.post('/login', async (req, res) => {
  try {
    const email = safeString(req.body.email).toLowerCase();
    const password = safeString(req.body.password);
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ success: false, error: error.message });
    return res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/signup', async (req, res) => {
  try {
    const name = safeString(req.body.name);
    const email = safeString(req.body.email).toLowerCase();
    const password = safeString(req.body.password);
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ success: false, error: error.message });
    await supabaseAdmin.from('user_profiles').insert([{
      id: data.user.id, email, name: name || email,
      role: 'tech', last_seen: new Date().toISOString()
    }]);
    return res.json({ success: true, user: data.user });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- USER PROFILE ---

app.get('/user-profile/:userId', async (req, res) => {
  try {
    const userId = safeString(req.params.userId);
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
    const { data, error } = await supabaseAdmin.from('user_profiles').select('*').eq('id', userId).single();
    if (error) return res.status(404).json({ success: false, error: error.message });
    return res.json({ success: true, profile: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- HEARTBEAT ---

app.post('/heartbeat', async (req, res) => {
  try {
    const userId = safeString(req.body.user_id);
    await touchUserLastSeen(userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- VIN DECODE ---

app.post('/decode-vin', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const vehicleInfo = await decodeVIN(vin);
    return res.json({
      success: true,
      vehicle: {
        vin, year: safeString(vehicleInfo?.ModelYear), make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model), engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim), driveType: safeString(vehicleInfo?.DriveType), fuelType: safeString(vehicleInfo?.FuelTypePrimary)
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- DIAGNOSE ---

app.post('/diagnose', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const code = safeString(req.body.code);
    const symptom = safeString(req.body.symptom);
    const notes = safeString(req.body.notes);
    const quickTree = buildQuickTree({ vin, code, symptom, notes });
    res.json({ success: true, mode: 'step-tree', tree: quickTree });
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
    if (vin && vin.length >= 11) vehicleInfo = await decodeVIN(vin);
    const learningContext = await getLearningContext({ code, vehicleInfo });
    const detailedTree = await callOpenAIForTree({ vin, code, symptom, notes, vehicleInfo, learningContext, mode: 'standard' });
    res.json({
      success: true, tree: detailedTree,
      vehicle: {
        vin, year: safeString(vehicleInfo?.ModelYear), make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model), engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim), driveType: safeString(vehicleInfo?.DriveType), fuelType: safeString(vehicleInfo?.FuelTypePrimary)
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
    if (vin && vin.length >= 11) vehicleInfo = await decodeVIN(vin);
    const learningContext = await getLearningContext({ code, vehicleInfo });
    const expertTree = await callOpenAIForTree({ vin, code, symptom, notes, vehicleInfo, learningContext, mode: 'expert' });
    res.json({
      success: true, tree: expertTree,
      vehicle: {
        vin, year: safeString(vehicleInfo?.ModelYear), make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model), engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim), driveType: safeString(vehicleInfo?.DriveType), fuelType: safeString(vehicleInfo?.FuelTypePrimary)
      },
      learning_matches: learningContext.total_matches,
      suggested_fixes: learningContext.suggested_fixes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- CHAT (legacy - kept for makeNextStep) ---

app.post('/chat', async (req, res) => {
  try {
    const question = safeString(req.body.question);
    const action = safeString(req.body.action) || 'chat';
    const currentStep = req.body.current_step || null;
    const stepHistory = req.body.step_history || [];
    const chatHistory = (req.body.chat_history || []).slice(-6);
    const vehicleData = req.body.vehicle || {};
    if (!question) return res.status(400).json({ success: false, error: 'question required' });

    const systemPrompt = action === 'make_next_step'
      ? `You are Allie, a senior automotive diagnostic assistant. Convert the given guidance into a structured next diagnostic step. Return ONLY valid JSON in this exact shape: {"id":"chat_step_1","title":"string","instruction":"string","where_to_test":"string","expected_specs":{"voltage":"string","ohms":"string","pressure":"string","signal":"string","voltage_drop":"string"},"how_to_test":"string","result_buttons":[{"label":"PASS","next_step_id":""},{"label":"FAIL","next_step_id":""},{"label":"NOT TESTED","next_step_id":""}]}`
      : `You are Allie, a senior automotive diagnostic assistant embedded in a shop diagnostic tool. Be concise, practical, and specific to the job context provided. Give actionable shop-floor guidance.`;

    const userPrompt = `Vehicle: ${JSON.stringify(vehicleData)}
VIN: ${req.body.vin || 'unknown'}
DTC: ${req.body.code || 'none'}
Complaint: ${req.body.symptom || 'none'}
Notes: ${req.body.notes || 'none'}
Current Step: ${currentStep ? JSON.stringify(currentStep) : 'none'}
Step History: ${stepHistory.join(', ') || 'none'}
Question: ${question}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userPrompt }
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.1, messages })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ success: false, error: data.error.message });

    const content = data?.choices?.[0]?.message?.content || '';
    if (action === 'make_next_step') {
      const parsed = cleanModelJson(content);
      return res.json({ success: true, next_step: parsed });
    }
    return res.json({ success: true, reply: content });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- RECORD STEP RESULT ---

app.post('/record-step-result', async (req, res) => {
  try {
    await supabaseAdmin.from('step_results').insert([{
      vin: safeString(req.body.vin), year: safeString(req.body.year),
      make: safeString(req.body.make), model: safeString(req.body.model),
      engine: safeString(req.body.engine), fault_code: safeString(req.body.fault_code),
      complaint: safeString(req.body.complaint), notes: safeString(req.body.notes),
      step_title: safeString(req.body.step_title), step_id: safeString(req.body.step_id),
      button_result: safeString(req.body.button_result), next_step_id: safeString(req.body.next_step_id),
      ai_diagnosis: safeString(req.body.ai_diagnosis), status: safeString(req.body.status) || 'in_progress'
    }]);
  } catch (err) {
    console.log('record-step-result insert failed (table may not exist):', err.message);
  }
  return res.json({ success: true });
});

// --- SAVE REPAIR ---

app.post('/save-repair', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('repair_cases').insert([{
      vin: safeString(req.body.vin), year: safeString(req.body.year),
      make: safeString(req.body.make), model: safeString(req.body.model),
      engine: safeString(req.body.engine), fault_code: safeString(req.body.fault_code),
      complaint: safeString(req.body.complaint), ai_diagnosis: safeString(req.body.ai_diagnosis),
      recommended_tests: safeString(req.body.recommended_tests), final_fix: safeString(req.body.final_fix),
      tech_name: safeString(req.body.tech_name), status: safeString(req.body.status) || 'fixed',
      notes: safeString(req.body.notes)
    }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, record: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADMIN: USER STATS ---

app.get('/admin-user-stats', async (req, res) => {
  try {
    const { data: profiles, error } = await supabaseAdmin.from('user_profiles').select('id, last_seen');
    if (error) return res.status(500).json({ success: false, error: error.message });
    const cutoff = getOnlineCutoffIso(15);
    const total = (profiles || []).length;
    const online = (profiles || []).filter(p => p.last_seen && p.last_seen >= cutoff).length;
    return res.json({ success: true, total_registered_users: total, online_registered_users: online, online_window_minutes: 15 });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADMIN: USERS LIST ---

app.get('/admin-users', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles').select('id, email, name, role, created_at, last_seen')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, users: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADMIN: ACCESS REQUESTS ---

app.get('/access-requests', async (req, res) => {
  try {
    const status = safeString(req.query.status) || 'pending';
    const { data, error } = await supabaseAdmin
      .from('access_requests').select('*').eq('status', status).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, requests: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/approve-request', async (req, res) => {
  try {
    const requestId = safeString(req.body.request_id);
    if (!requestId) return res.status(400).json({ success: false, error: 'request_id required' });
    const { data: request, error: fetchError } = await supabaseAdmin.from('access_requests').select('*').eq('id', requestId).single();
    if (fetchError) return res.status(404).json({ success: false, error: fetchError.message });
    const { error: updateError } = await supabaseAdmin.from('access_requests').update({ status: 'approved' }).eq('id', requestId);
    if (updateError) return res.status(500).json({ success: false, error: updateError.message });
    return res.json({ success: true, message: 'Request approved' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/deny-request', async (req, res) => {
  try {
    const requestId = safeString(req.body.request_id);
    if (!requestId) return res.status(400).json({ success: false, error: 'request_id required' });
    const { error } = await supabaseAdmin.from('access_requests').update({ status: 'denied' }).eq('id', requestId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, message: 'Request denied' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- ASK ALLIE HEALTH CHECK ---

app.get('/ask-allie-health', async (req, res) => {
  try {
    const { count, error } = await supabaseAdmin.from('ask_allie_sessions').select('*', { count: 'exact', head: true });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({
      success: true, status: 'ok',
      ask_allie_sessions_count: count || 0,
      openai_configured: !!OPENAI_KEY,
      tavily_configured: !!TAVILY_KEY
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- ASK ALLIE (MAIN) ---

app.post('/ask-allie', async (req, res) => {
  try {
    const question = safeString(req.body.question);
    const incomingSessionId = safeString(req.body.session_id);
    const jobContext = buildAskAllieContext(req.body);

    if (!question) return res.status(400).json({ success: false, error: 'question is required' });

    if (!OPENAI_KEY) {
      return res.status(500).json({ success: false, error: 'OpenAI API key not configured. Add OPENAI_API_KEY to Render environment variables.' });
    }

    // Session management
    let session = null;
    if (incomingSessionId) {
      try {
        const { data: existingSession } = await supabaseAdmin.from('ask_allie_sessions').select('*').eq('id', incomingSessionId).single();
        if (existingSession) session = existingSession;
      } catch (err) {
        console.log('Session lookup failed:', err.message);
      }
    }

    if (!session) {
      try {
        const { data: insertedSession, error: sessionError } = await supabaseAdmin
          .from('ask_allie_sessions')
          .insert([{
            vin: jobContext.vin || null, year: jobContext.year || null,
            make: jobContext.make || null, model: jobContext.model || null,
            engine: jobContext.engine || null, complaint: jobContext.complaint || null,
            dtcs: jobContext.dtcs, symptoms: jobContext.symptoms,
            prior_tests: jobContext.prior_tests, notes: jobContext.notes || null,
            updated_at: new Date().toISOString()
          }])
          .select().single();

        if (sessionError) {
          console.log('Session insert failed:', sessionError.message);
          // Continue without session — don't block the answer
        } else {
          session = insertedSession;
        }
      } catch (err) {
        console.log('Session creation failed:', err.message);
      }
    }

    const sessionId = session?.id || 'no-session';

    // Save user message
    try {
      await supabaseAdmin.from('ask_allie_messages').insert([{
        session_id: sessionId === 'no-session' ? null : sessionId,
        role: 'user', content: question,
        metadata: { job_context: jobContext }
      }]);
    } catch (err) {
      console.log('User message save failed:', err.message);
    }

    // Search internal knowledge
    const internalKnowledge = await searchAskAllieInternalKnowledge(question, jobContext);

    // Decide if web search needed
    const shouldUseWeb = computeAskAllieNeedWeb(question, internalKnowledge);

    let externalResearch = { query: '', used_web: false, results: [], images: [], warning: '' };
    if (shouldUseWeb && TAVILY_KEY) {
      externalResearch = await tavilySearch(buildAskAllieSearchQuery(question, jobContext));
    }

    // Save web sources
    const savedWebSourceRows = [];
    if (sessionId !== 'no-session') {
      for (const item of (externalResearch.results || []).slice(0, 5)) {
        const sourceRow = await saveAskAllieSource(sessionId, {
          source_type: 'web', title: item.title, url: item.url,
          domain: (() => { try { return new URL(item.url).hostname; } catch { return ''; } })(),
          raw_content: safeString(item.raw_content || item.content),
          extracted_summary: safeString(item.content || item.raw_content),
          status: 'unverified', confidence_score: 40
        });
        if (sourceRow) savedWebSourceRows.push(sourceRow);
      }

      for (const imageUrl of (externalResearch.images || []).slice(0, 5)) {
        await saveAskAllieSource(sessionId, {
          source_type: 'image', title: 'Image result', url: imageUrl,
          domain: (() => { try { return new URL(imageUrl).hostname; } catch { return ''; } })(),
          raw_content: '', extracted_summary: '', status: 'unverified', confidence_score: 25
        });
      }
    }

    // Extract structured data from web results
    const extractionInputSources = savedWebSourceRows.length
      ? savedWebSourceRows.map(row => ({ extracted_summary: row.extracted_summary, raw_content: row.raw_content }))
      : (externalResearch.results || []).slice(0, 5).map(r => ({ extracted_summary: safeString(r.content), raw_content: safeString(r.raw_content) }));

    const extracted = await extractStructuredDataFromWeb(extractionInputSources, jobContext, question);

    // Save extracted facts
    if (extracted && (extracted.pinout_table?.length || extracted.key_specs?.length) && sessionId !== 'no-session') {
      await saveAskAllieFacts(sessionId, savedWebSourceRows[0]?.id || null, extracted, jobContext);
    }

    // Synthesize the answer using AI
    let answerPayload = await synthesizeAskAllieAnswer({ question, jobContext, internalKnowledge, externalResearch, extracted });

    // Only use fallback if AI completely failed
    if (!answerPayload || !answerPayload.answer) {
      answerPayload = buildAskAllieFallbackAnswer(extracted, externalResearch);
    }

    // Promote confidence for verified data
    if (sessionId !== 'no-session') {
      await promoteAskAllieConfidence(sessionId, answerPayload.confidence_score);
    }

    // Save assistant message
    let assistantMessageId = null;
    try {
      const { data: assistantMessage, error: assistantMessageError } = await supabaseAdmin
        .from('ask_allie_messages')
        .insert([{
          session_id: sessionId === 'no-session' ? null : sessionId,
          role: 'assistant', content: answerPayload.answer,
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
        }])
        .select().single();

      if (!assistantMessageError) assistantMessageId = assistantMessage?.id;
    } catch (err) {
      console.log('Assistant message save failed:', err.message);
    }

    const sourceList = sessionId !== 'no-session' ? await buildAskAllieSourceList(sessionId) : [];

    return res.json({
      success: true,
      session_id: sessionId !== 'no-session' ? sessionId : null,
      message_id: assistantMessageId,
      data: {
        answer: answerPayload.answer,
        confidence_score: toNumber(answerPayload.confidence_score, 0),
        match_level: safeString(answerPayload.match_level) || 'medium',
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
    console.error('/ask-allie route error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- JOB HISTORY ---

app.get('/job-history', async (req, res) => {
  try {
    const shopId = safeString(req.query.shop_id);
    const userId = safeString(req.query.user_id);
    const role = safeString(req.query.role);
    const fleetId = safeString(req.query.fleet_id);
    const unitId = safeString(req.query.unit_id);
    const limit = Math.min(toNumber(req.query.limit, 50), 200);

    let query = supabaseAdmin
      .from('repair_cases')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    // fleet_manager only sees their fleet's jobs
    if (role === 'fleet_manager' && fleetId) {
      query = query.eq('fleet_id', fleetId);
    } else if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    if (unitId) query = query.eq('unit_id', unitId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, jobs: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- YARDS ---

app.post('/create-yard', async (req, res) => {
  try {
    const shopId = safeString(req.body.shop_id);
    const yardName = safeString(req.body.yard_name);
    const address = safeString(req.body.address);
    const contactName = safeString(req.body.contact_name);
    const contactEmail = safeString(req.body.contact_email);
    const contactPhone = safeString(req.body.contact_phone);
    if (!shopId || !yardName) return res.status(400).json({ success: false, error: 'shop_id and yard_name required' });
    const { data, error } = await supabaseAdmin.from('yards').insert([{
      shop_id: shopId, yard_name: yardName, address, contact_name: contactName,
      contact_email: contactEmail, contact_phone: contactPhone
    }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, yard: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/yards', async (req, res) => {
  try {
    const shopId = safeString(req.query.shop_id);
    if (!shopId) return res.status(400).json({ success: false, error: 'shop_id required' });
    const { data, error } = await supabaseAdmin.from('yards').select('*').eq('shop_id', shopId).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, yards: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- FLEETS ---

app.post('/create-fleet', async (req, res) => {
  try {
    const shopId = safeString(req.body.shop_id);
    const yardId = safeString(req.body.yard_id);
    const fleetName = safeString(req.body.fleet_name);
    const companyName = safeString(req.body.company_name);
    const contactName = safeString(req.body.contact_name);
    const contactEmail = safeString(req.body.contact_email);
    const contactPhone = safeString(req.body.contact_phone);
    if (!shopId || !fleetName) return res.status(400).json({ success: false, error: 'shop_id and fleet_name required' });
    const { data, error } = await supabaseAdmin.from('fleets').insert([{
      shop_id: shopId, yard_id: yardId || null, fleet_name: fleetName,
      company_name: companyName, contact_name: contactName,
      contact_email: contactEmail, contact_phone: contactPhone
    }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, fleet: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/fleets', async (req, res) => {
  try {
    const shopId = safeString(req.query.shop_id);
    const yardId = safeString(req.query.yard_id);
    if (!shopId) return res.status(400).json({ success: false, error: 'shop_id required' });
    let query = supabaseAdmin.from('fleets').select('*').eq('shop_id', shopId);
    if (yardId) query = query.eq('yard_id', yardId);
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, fleets: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- UNITS ---

app.post('/create-unit', async (req, res) => {
  try {
    const shopId = safeString(req.body.shop_id);
    const yardId = safeString(req.body.yard_id);
    const fleetId = safeString(req.body.fleet_id);
    const vin = safeString(req.body.vin);
    const year = safeString(req.body.year);
    const make = safeString(req.body.make);
    const model = safeString(req.body.model);
    const engine = safeString(req.body.engine);
    const unitNumber = safeString(req.body.unit_number);
    const mileage = safeString(req.body.mileage);
    const notes = safeString(req.body.notes);
    if (!shopId || !fleetId) return res.status(400).json({ success: false, error: 'shop_id and fleet_id required' });

    // Auto-decode VIN if provided
    let vehicleInfo = null;
    if (vin && vin.length >= 11) vehicleInfo = await decodeVIN(vin);

    const { data, error } = await supabaseAdmin.from('units').insert([{
      shop_id: shopId, yard_id: yardId || null, fleet_id: fleetId, vin,
      year: year || safeString(vehicleInfo?.ModelYear),
      make: make || safeString(vehicleInfo?.Make),
      model: model || safeString(vehicleInfo?.Model),
      engine: engine || safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
      unit_number: unitNumber, mileage, notes
    }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, unit: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/units', async (req, res) => {
  try {
    const shopId = safeString(req.query.shop_id);
    const fleetId = safeString(req.query.fleet_id);
    const yardId = safeString(req.query.yard_id);
    if (!shopId) return res.status(400).json({ success: false, error: 'shop_id required' });
    let query = supabaseAdmin.from('units').select('*').eq('shop_id', shopId);
    if (fleetId) query = query.eq('fleet_id', fleetId);
    if (yardId) query = query.eq('yard_id', yardId);
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, units: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/unit-history/:unitId', async (req, res) => {
  try {
    const unitId = safeString(req.params.unitId);
    if (!unitId) return res.status(400).json({ success: false, error: 'unitId required' });
    const { data, error } = await supabaseAdmin
      .from('repair_cases').select('*')
      .eq('unit_id', unitId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, jobs: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- UPDATE SIGNUP TO SAVE COMPANY ---

app.post('/signup-v2', async (req, res) => {
  try {
    const name = safeString(req.body.name);
    const email = safeString(req.body.email).toLowerCase();
    const password = safeString(req.body.password);
    const company = safeString(req.body.company);
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ success: false, error: error.message });
    await supabaseAdmin.from('user_profiles').insert([{
      id: data.user.id, email, name: name || email,
      role: 'tech', last_seen: new Date().toISOString()
    }]);
    try {
      await supabaseAdmin.from('access_requests').insert([{
        email, name: name || email, company: company || 'Not provided', status: 'pending'
      }]);
    } catch (err) {
      console.log('Access request insert failed:', err.message);
    }
    return res.json({ success: true, user: data.user });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Allie-kat backend running on port ' + PORT);
  console.log('OpenAI key configured:', !!OPENAI_KEY);
  console.log('Tavily key configured:', !!TAVILY_KEY);
});
