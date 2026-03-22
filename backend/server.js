const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* =========================
   SUPABASE CLIENTS
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

function buildAskAllieContext(jobContext = {}) {
  return {
    vin: safeString(jobContext.vin),
    year: safeString(jobContext.year),
    make: safeString(jobContext.make),
    model: safeString(jobContext.model),
    engine: safeString(jobContext.engine),
    complaint: safeString(jobContext.complaint),
    dtcs: safeArray(jobContext.dtcs),
    symptoms: safeArray(jobContext.symptoms),
    prior_tests: safeArray(jobContext.prior_tests || jobContext.priorTests),
    notes: safeString(jobContext.notes)
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
    question
  ].filter(Boolean).join(' ');
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

/* =========================
   DIAG HELPERS
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

/* =========================
   OPENAI CALLS
========================= */

async function callOpenAIForTree({ vin, code, symptom, notes, vehicleInfo, learningContext, mode }) {
  const learningText = learningContextToText(learningContext);

  const standardSystemPrompt = `
You are a master diesel and automotive diagnostic technician.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Build a highly detailed button-driven diagnostic tree that walks a technician through troubleshooting like an OEM service tree.

Requirements:
- Use the actual DTC and complaint throughout the tree when available.
- Make each step read like a real technician instruction.
- Include practical checks:
  - power feed
  - ground
  - reference voltage
  - signal checks
  - connector inspection
  - wiggle harness testing
  - ohms checks while moving harness
  - continuity while moving harness
  - voltage drop
  - module-side verification
  - compare source-side reading to module-side reading
- Explain HOW to perform each check in bay language.
- For wiggle tests, explicitly mention opens/high resistance while moving the harness.
- For wire continuity steps, explain expected ohms and what change during movement means.
- For voltage steps, explain expected ranges and what bad readings mean.
- Include pinout guidance when confidently known.
- If exact OEM pin numbers are not certain, say:
  "Verify exact OEM pinout for this platform"
- Do not invent exact pin numbers if uncertain.
- Prefer 5 to 8 steps.
- Every step must drive to the next logical branch.
- Use aggressive learning context to move high-confidence repeat failure points earlier, but still validate them by testing before concluding the fix.

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

  const expertSystemPrompt = `
You are a master diesel and automotive diagnostic technician in EXPERT MODE with aggressive learning prioritization.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Rules:
- Treat notes as evidence.
- Skip or compress basic checks already strongly supported by notes.
- Use actual DTC, complaint, platform, and aggressive learning context aggressively.
- If a repeat validated failure is strongly indicated by learning context, move that failure point into step 1 or step 2.
- Do not blindly replace a part or assume the fix; validate it with the right test first.
- Focus on direct fault isolation:
  - source-side signal
  - module-side signal
  - loaded voltage drop
  - continuity / ohms while moving harness
  - wiggle test with meter/live data
  - spread pin / corrosion / rub-through / connector drag
  - commanded vs actual
- Explain exactly what the tech should do.
- Include expected voltages, ohms, signal behavior, voltage drop, and what the result means.
- Include pinout guidance when confidently known.
- If exact OEM pin numbers are not certain, say:
  "Verify exact OEM pinout for this platform"
- Do not invent exact pin numbers if uncertain.
- Prefer 4 to 7 high-value steps.
- The tree should behave like a senior tech who knows repeat failure points on this platform.

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

Build the ${mode === 'expert' ? 'expert' : 'detailed'} diagnostic tree now.
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: mode === 'expert' ? 0.05 : 0.08,
        messages: [
          {
            role: 'system',
            content: mode === 'expert' ? expertSystemPrompt : standardSystemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    return normalizeTree(parsed, { vin, code, symptom, notes }, vehicleInfo, mode === 'expert' ? 'openai-expert-aggressive' : 'openai-aggressive');
  } catch {
    return buildQuickTree({ vin, code, symptom, notes });
  }
}

async function callOpenAIForChat(context) {
  const systemPrompt = `
You are Allie-Kat Job Chat, a shop-floor diagnostic assistant for mechanics.

Be practical, direct, and useful.
Base your answer on the current job context first.
Use current step, current mode, notes, known fixes, and prior step history.
If exact OEM pinouts are not certain, say:
"Verify exact OEM pinout for this platform"
Do not invent exact pin numbers if uncertain.
Keep answers concise but strong.
`;

  const trimmedChatHistory = Array.isArray(context.chatHistory) ? context.chatHistory.slice(-8) : [];
  const chatTranscript = trimmedChatHistory
    .map(msg => `${safeString(msg.role).toUpperCase()}: ${safeString(msg.content)}`)
    .join('\n');

  const userPrompt = `
QUESTION:
${context.question}

CURRENT JOB CONTEXT:
VIN: ${context.vin || 'not provided'}
Code: ${context.code || 'not provided'}
Complaint: ${context.symptom || 'not provided'}
Notes: ${context.notes || 'not provided'}

VEHICLE:
Year: ${safeString(context.vehicle?.year)}
Make: ${safeString(context.vehicle?.make)}
Model: ${safeString(context.vehicle?.model)}
Engine: ${safeString(context.vehicle?.engine)}

MODE:
${context.currentMode || 'standard'}

CURRENT STEP:
Title: ${safeString(context.currentStep?.title)}
Instruction: ${safeString(context.currentStep?.instruction)}
Where to test: ${safeString(context.currentStep?.where_to_test)}
Expected voltage: ${safeString(context.currentStep?.expected_specs?.voltage)}
Expected ohms: ${safeString(context.currentStep?.expected_specs?.ohms)}
Expected signal: ${safeString(context.currentStep?.expected_specs?.signal)}
Expected voltage drop: ${safeString(context.currentStep?.expected_specs?.voltage_drop)}
How to test: ${safeString(context.currentStep?.how_to_test)}

CURRENT TREE:
Issue summary: ${context.treeIssueSummary || ''}
Likely fault path: ${context.treeLikelyFaultPath || ''}
Final recommendation: ${context.treeFinalRecommendation || ''}

STEP HISTORY:
${Array.isArray(context.stepHistory) && context.stepHistory.length ? context.stepHistory.join('\n') : 'No step history yet.'}

KNOWN FIXES:
${context.knownFixesText || 'No known fixes shown.'}

CHAT HISTORY:
${chatTranscript || 'No prior chat.'}

Answer the technician now.
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
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
    return safeString(data?.choices?.[0]?.message?.content) || 'No reply returned.';
  } catch (err) {
    return `Chat error: ${err.message}`;
  }
}

async function callOpenAIForNextStep(context) {
  const systemPrompt = `
You are a master diesel diagnostic assistant.

Return ONLY valid JSON.
No markdown.
No code fences.
No commentary.

Convert the technician chat insight into ONE structured next diagnostic step.

Rules:
- This must be a single high-value next step for the current job.
- Use the current job context and current step.
- Make the step practical and specific.
- Include what to test, where to test, expected specs, and how to test.
- If exact OEM pin numbers are not certain, say:
  "Verify exact OEM pinout for this platform"
- Do not invent exact pin numbers if uncertain.

Return JSON exactly like:
{
  "id": "chat_step_1",
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
    { "label": "PASS", "next_step_id": "" },
    { "label": "FAIL", "next_step_id": "" },
    { "label": "NOT TESTED", "next_step_id": "" }
  ]
}
`;

  const userPrompt = `
CHAT INSIGHT TO CONVERT:
${context.question}

CURRENT JOB:
VIN: ${context.vin || 'not provided'}
Code: ${context.code || 'not provided'}
Complaint: ${context.symptom || 'not provided'}
Notes: ${context.notes || 'not provided'}

VEHICLE:
Year: ${safeString(context.vehicle?.year)}
Make: ${safeString(context.vehicle?.make)}
Model: ${safeString(context.vehicle?.model)}
Engine: ${safeString(context.vehicle?.engine)}

MODE:
${context.currentMode || 'standard'}

CURRENT STEP:
Title: ${safeString(context.currentStep?.title)}
Instruction: ${safeString(context.currentStep?.instruction)}
Where to test: ${safeString(context.currentStep?.where_to_test)}
Expected voltage: ${safeString(context.currentStep?.expected_specs?.voltage)}
Expected ohms: ${safeString(context.currentStep?.expected_specs?.ohms)}
Expected signal: ${safeString(context.currentStep?.expected_specs?.signal)}
Expected voltage drop: ${safeString(context.currentStep?.expected_specs?.voltage_drop)}
How to test: ${safeString(context.currentStep?.how_to_test)}

KNOWN FIXES:
${context.knownFixesText || 'No known fixes shown.'}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    if (!parsed || typeof parsed !== 'object') return null;

    return {
      id: safeString(parsed.id) || `chat_step_${Date.now()}`,
      title: safeString(parsed.title) || 'Chat-Suggested Next Step',
      instruction: safeString(parsed.instruction) || '',
      where_to_test: safeString(parsed.where_to_test) || '',
      expected_specs: {
        voltage: safeString(parsed?.expected_specs?.voltage) || 'Verify exact OEM spec/pinout for this platform',
        ohms: safeString(parsed?.expected_specs?.ohms) || 'Verify exact OEM spec/pinout for this platform',
        pressure: safeString(parsed?.expected_specs?.pressure) || 'Verify exact OEM spec/pinout for this platform',
        signal: safeString(parsed?.expected_specs?.signal) || 'Verify exact OEM spec/pinout for this platform',
        voltage_drop: safeString(parsed?.expected_specs?.voltage_drop) || 'Verify exact OEM spec/pinout for this platform'
      },
      how_to_test: safeString(parsed.how_to_test) || '',
      result_buttons: Array.isArray(parsed.result_buttons) && parsed.result_buttons.length
        ? parsed.result_buttons.map(btn => ({
            label: safeString(btn.label) || 'NEXT',
            next_step_id: safeString(btn.next_step_id) || ''
          }))
        : [
            { label: 'PASS', next_step_id: '' },
            { label: 'FAIL', next_step_id: '' },
            { label: 'NOT TESTED', next_step_id: '' }
          ]
    };
  } catch {
    return null;
  }
}

/* =========================
   ASK ALLIE HELPERS
========================= */

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
        include_raw_content: false,
        max_results: 8
      })
    });

    const data = await response.json();

    return {
      query,
      results: Array.isArray(data?.results) ? data.results : [],
      images: Array.isArray(data?.images) ? data.images : [],
      used_web: true,
      warning: ''
    };
  } catch (err) {
    return {
      query,
      results: [],
      images: [],
      used_web: false,
      warning: err.message
    };
  }
}

async function saveAskAllieSource(sessionId, source) {
  const { data, error } = await supabaseAdmin
    .from('ask_allie_sources')
    .insert([
      {
        session_id: sessionId,
        source_type: safeString(source.source_type),
        title: safeString(source.title),
        url: safeString(source.url),
        domain: safeString(source.domain),
        raw_content: safeString(source.raw_content),
        extracted_summary: safeString(source.extracted_summary),
        status: safeString(source.status) || 'unverified',
        confidence_score: toNumber(source.confidence_score, 0)
      }
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function saveAskAllieFacts(sessionId, sourceId, extracted, jobContext) {
  const rows = [];

  const pinoutTable = Array.isArray(extracted?.pinout_table) ? extracted.pinout_table : [];
  for (const pin of pinoutTable) {
    rows.push({
      session_id: sessionId,
      source_id: sourceId || null,
      fact_type: 'pinout',
      component_name: safeString(extracted?.component_name || 'Throttle Position Sensor'),
      connector_name: safeString(extracted?.connector_name),
      pin_label: safeString(pin.pin || pin.pin_label),
      wire_color: safeString(pin.wire_color),
      circuit_function: safeString(pin.function || pin.circuit_function),
      expected_value: safeString(pin.expected_voltage || pin.expected_value),
      conditions: safeString(extracted?.conditions),
      application_year: safeString(jobContext.year),
      application_make: safeString(jobContext.make),
      application_model: safeString(jobContext.model),
      application_engine: safeString(jobContext.engine),
      fact_json: pin,
      status: 'unverified',
      confidence_score: toNumber(extracted?.confidence, 0)
    });
  }

  const keySpecs = Array.isArray(extracted?.key_specs) ? extracted.key_specs : [];
  for (const spec of keySpecs) {
    rows.push({
      session_id: sessionId,
      source_id: sourceId || null,
      fact_type: 'spec',
      component_name: safeString(extracted?.component_name || 'Throttle Position Sensor'),
      connector_name: safeString(extracted?.connector_name),
      pin_label: '',
      wire_color: '',
      circuit_function: 'Spec',
      expected_value: safeString(spec),
      conditions: safeString(extracted?.conditions),
      application_year: safeString(jobContext.year),
      application_make: safeString(jobContext.make),
      application_model: safeString(jobContext.model),
      application_engine: safeString(jobContext.engine),
      fact_json: { spec },
      status: 'unverified',
      confidence_score: toNumber(extracted?.confidence, 0)
    });
  }

  if (!rows.length) return [];

  const { data, error } = await supabaseAdmin
    .from('ask_allie_facts')
    .insert(rows)
    .select();

  if (error) throw new Error(error.message);
  return data || [];
}

async function extractStructuredDataFromWeb(sources, jobContext) {
  const combinedText = (sources || [])
    .map(s => safeString(s.extracted_summary || s.raw_content || s.content))
    .join('\n\n')
    .slice(0, 12000);

  if (!combinedText) return null;

  const prompt = `
You are a master automotive diagnostic data extractor.

Extract only real, usable structured automotive data.

Focus on:
- connector pinouts
- wire functions
- expected voltages
- sensor ranges
- signal correlation
- application-specific throttle/pedal position details

Vehicle:
${jobContext.year} ${jobContext.make} ${jobContext.model} ${jobContext.engine}

Content:
${combinedText}

Return ONLY valid JSON in this exact shape:
{
  "component_name": "",
  "connector_name": "",
  "conditions": "",
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

Rules:
- Do not invent exact pin numbers.
- If pin numbers are unknown, leave them blank.
- If the data is too generic, still extract usable voltage/spec info.
- confidence must be 0 to 100.
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.05,
        messages: [
          { role: 'system', content: 'Return only valid JSON.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    if (!parsed || typeof parsed !== 'object') return null;

    return {
      component_name: safeString(parsed.component_name),
      connector_name: safeString(parsed.connector_name),
      conditions: safeString(parsed.conditions),
      pinout_table: Array.isArray(parsed.pinout_table) ? parsed.pinout_table : [],
      key_specs: Array.isArray(parsed.key_specs) ? parsed.key_specs : [],
      diagnostic_notes: Array.isArray(parsed.diagnostic_notes) ? parsed.diagnostic_notes : [],
      confidence: toNumber(parsed.confidence, 0)
    };
  } catch (err) {
    console.log('extractStructuredDataFromWeb error:', err.message);
    return null;
  }
}

async function searchAskAllieInternalKnowledge(question, ctx) {
  const questionText = lower(question);
  const componentHints = [
    'throttle', 'pedal', 'accelerator', 'map', 'maf', 'cam', 'crank', 'abs',
    'injector', 'fuel', 'egr', 'vgt', 'boost', 'temperature', 'pressure',
    'sensor', 'switch', 'solenoid', 'connector', 'wiring'
  ].filter(term => questionText.includes(term));

  const { data: factsData, error: factsError } = await supabaseAdmin
    .from('ask_allie_facts')
    .select('*')
    .eq('application_make', ctx.make || null)
    .eq('application_model', ctx.model || null)
    .eq('application_engine', ctx.engine || null)
    .order('confidence_score', { ascending: false })
    .limit(50);

  if (factsError && !String(factsError.message).includes('0 rows')) {
    throw new Error(factsError.message);
  }

  const filteredFacts = (factsData || []).filter(row => {
    const haystack = lower([
      row.fact_type,
      row.component_name,
      row.connector_name,
      row.pin_label,
      row.wire_color,
      row.circuit_function,
      row.expected_value,
      JSON.stringify(row.fact_json || {})
    ].join(' '));

    if (componentHints.length === 0) return true;
    return componentHints.some(term => haystack.includes(term));
  });

  const dtcFilters = safeArray(ctx.dtcs).map(lower);

  const { data: fixesData, error: fixesError } = await supabaseAdmin
    .from('ask_allie_known_fixes')
    .select('*')
    .eq('make', ctx.make || null)
    .eq('model', ctx.model || null)
    .eq('engine', ctx.engine || null)
    .order('confidence_score', { ascending: false })
    .limit(25);

  if (fixesError && !String(fixesError.message).includes('0 rows')) {
    throw new Error(fixesError.message);
  }

  const filteredFixes = (fixesData || []).filter(row => {
    const haystack = lower([
      row.symptom_pattern,
      row.root_cause,
      row.repair_performed,
      safeArray(row.dtcs).join(' ')
    ].join(' '));

    if (dtcFilters.length && dtcFilters.some(code => haystack.includes(code))) return true;
    if (componentHints.length && componentHints.some(term => haystack.includes(term))) return true;
    if (!dtcFilters.length && !componentHints.length) return true;
    return false;
  });

  return {
    facts: filteredFacts.slice(0, 20),
    known_fixes: filteredFixes.slice(0, 10)
  };
}

function computeAskAllieNeedWeb(question, internalKnowledge) {
  const asksForWiringData = /pinout|connector|wire|wiring|diagram|image|picture|photo|voltage|ohms|spec|reference/i.test(safeString(question));
  const verifiedFacts = (internalKnowledge.facts || []).filter(
    row => ['cross_checked', 'tech_confirmed', 'repair_confirmed'].includes(lower(row.status))
  );

  if (asksForWiringData && verifiedFacts.length === 0) return true;
  if ((internalKnowledge.facts || []).length === 0 && (internalKnowledge.known_fixes || []).length === 0) return true;

  return false;
}

async function synthesizeAskAllieAnswer({ question, jobContext, internalKnowledge, externalResearch, extracted }) {
  const internalFactSummary = (internalKnowledge.facts || []).slice(0, 8).map(row => ({
    fact_type: row.fact_type,
    component_name: row.component_name,
    connector_name: row.connector_name,
    pin_label: row.pin_label,
    wire_color: row.wire_color,
    circuit_function: row.circuit_function,
    expected_value: row.expected_value,
    status: row.status,
    confidence_score: row.confidence_score
  }));

  const knownFixSummary = (internalKnowledge.known_fixes || []).slice(0, 5).map(row => ({
    dtcs: row.dtcs,
    symptom_pattern: row.symptom_pattern,
    root_cause: row.root_cause,
    repair_performed: row.repair_performed,
    outcome: row.outcome,
    confidence_score: row.confidence_score
  }));

  const prompt = `
You are Allie, an automotive diagnostic assistant inside a mechanic workflow.

Return ONLY valid JSON in this exact shape:
{
  "answer": "plain english answer",
  "confidence_score": 0,
  "match_level": "high | medium | low",
  "best_image_urls": [],
  "pinout_table": [
    {
      "pin_label": "",
      "wire_color": "",
      "circuit_function": "",
      "expected_value": "",
      "notes": ""
    }
  ],
  "warnings": [],
  "next_steps": []
}

Rules:
- Prefer internal verified data first.
- Use extracted web data if internal data is weak.
- Do not invent exact pin numbers.
- If uncertain, say verify exact OEM pinout for this platform.
- Give practical bay-ready next steps.

CURRENT JOB:
${JSON.stringify(jobContext, null, 2)}

QUESTION:
${question}

INTERNAL FACTS:
${JSON.stringify(internalFactSummary, null, 2)}

KNOWN FIXES:
${JSON.stringify(knownFixSummary, null, 2)}

EXTRACTED WEB DATA:
${JSON.stringify(extracted || {}, null, 2)}

IMAGE URLS:
${JSON.stringify((externalResearch.images || []).slice(0, 5), null, 2)}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.08,
        messages: [
          { role: 'system', content: 'Return only valid JSON.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = cleanModelJson(content);

    if (!parsed || typeof parsed !== 'object') return null;

    return {
      answer: safeString(parsed.answer),
      confidence_score: toNumber(parsed.confidence_score, toNumber(extracted?.confidence, 0)),
      match_level: safeString(parsed.match_level) || 'low',
      best_image_urls: Array.isArray(parsed.best_image_urls) ? parsed.best_image_urls : [],
      pinout_table: Array.isArray(parsed.pinout_table) ? parsed.pinout_table : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : []
    };
  } catch (err) {
    console.log('synthesizeAskAllieAnswer error:', err.message);
    return null;
  }
}

function buildAskAllieFallbackAnswer(extracted, externalResearch) {
  const pinoutTable = Array.isArray(extracted?.pinout_table)
    ? extracted.pinout_table.map(pin => ({
        pin_label: safeString(pin.pin || pin.pin_label),
        wire_color: safeString(pin.wire_color),
        circuit_function: safeString(pin.function || pin.circuit_function),
        expected_value: safeString(pin.expected_voltage || pin.expected_value),
        notes: ''
      }))
    : [];

  const answerLines = [];

  if (pinoutTable.length) {
    answerLines.push('Possible pinout/spec data found for this application:');
    for (const pin of pinoutTable) {
      answerLines.push(
        `Pin ${pin.pin_label || '(verify exact cavity)'} | ${pin.wire_color || 'wire color not confirmed'} | ${pin.circuit_function || 'function not confirmed'} | ${pin.expected_value || 'verify exact expected voltage'}`
      );
    }
  }

  const specs = Array.isArray(extracted?.key_specs) ? extracted.key_specs : [];
  if (specs.length) {
    answerLines.push('');
    answerLines.push('Key specs:');
    for (const spec of specs) {
      answerLines.push(`- ${safeString(spec)}`);
    }
  }

  const notes = Array.isArray(extracted?.diagnostic_notes) ? extracted.diagnostic_notes : [];
  if (notes.length) {
    answerLines.push('');
    answerLines.push('Diagnostic notes:');
    for (const note of notes) {
      answerLines.push(`- ${safeString(note)}`);
    }
  }

  if (!answerLines.length) {
    answerLines.push('I found web results, but no application-specific structured pinout could be confirmed yet. Verify exact OEM pinout for this platform.');
  }

  return {
    answer: answerLines.join('\n'),
    confidence_score: toNumber(extracted?.confidence, 20),
    match_level: toNumber(extracted?.confidence, 0) >= 75 ? 'high' : toNumber(extracted?.confidence, 0) >= 45 ? 'medium' : 'low',
    best_image_urls: Array.isArray(externalResearch?.images) ? externalResearch.images.slice(0, 5) : [],
    pinout_table: pinoutTable,
    warnings: pinoutTable.length ? [] : ['Exact application-specific pinout was not confirmed.'],
    next_steps: [
      'Backprobe the suspected TPS signal and verify a smooth change from low voltage at idle toward higher voltage at throttle opening.',
      'Verify 5V reference and low-reference/ground integrity directly at the connector.',
      'Perform a wiggle test on the harness while watching signal and reference stability.'
    ]
  };
}

async function promoteAskAllieConfidence(sessionId, confidenceScore) {
  const score = toNumber(confidenceScore, 0);
  if (score < 75) return;

  await supabaseAdmin
    .from('ask_allie_sources')
    .update({ status: 'cross_checked', confidence_score: score })
    .eq('session_id', sessionId)
    .eq('status', 'unverified');

  await supabaseAdmin
    .from('ask_allie_facts')
    .update({ status: 'cross_checked', confidence_score: score })
    .eq('session_id', sessionId)
    .eq('status', 'unverified');
}

async function buildAskAllieSourceList(sessionId) {
  const { data } = await supabaseAdmin
    .from('ask_allie_sources')
    .select('id, source_type, title, url, domain, status, confidence_score, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);

  return data || [];
}

/* =========================
   CORE ROUTES
========================= */

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
});

app.get('/admin-users', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.json({
        success: false,
        error: error.message,
        users: []
      });
    }

    return res.json({
      success: true,
      users: data || []
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      users: []
    });
  }
});

app.get('/user-profile/:id', async (req, res) => {
  try {
    const userId = safeString(req.params.id);

    if (!userId) {
      return res.json({
        success: false,
        error: 'User id required',
        profile: null
      });
    }

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      return res.json({
        success: false,
        error: error.message,
        profile: null
      });
    }

    return res.json({
      success: true,
      profile: data
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      profile: null
    });
  }
});

app.get('/admin-user-stats', async (req, res) => {
  try {
    const onlineWindowMinutes = 15;
    const cutoffIso = getOnlineCutoffIso(onlineWindowMinutes);

    const { count: totalRegisteredUsers, error: totalError } = await supabaseAdmin
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    if (totalError) {
      return res.json({
        success: false,
        error: totalError.message,
        total_registered_users: 0,
        online_registered_users: 0,
        online_window_minutes: onlineWindowMinutes
      });
    }

    const { count: onlineRegisteredUsers, error: onlineError } = await supabaseAdmin
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('last_seen', cutoffIso);

    if (onlineError) {
      return res.json({
        success: false,
        error: onlineError.message,
        total_registered_users: totalRegisteredUsers || 0,
        online_registered_users: 0,
        online_window_minutes: onlineWindowMinutes
      });
    }

    return res.json({
      success: true,
      total_registered_users: totalRegisteredUsers || 0,
      online_registered_users: onlineRegisteredUsers || 0,
      online_window_minutes: onlineWindowMinutes
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      total_registered_users: 0,
      online_registered_users: 0,
      online_window_minutes: 15
    });
  }
});

app.post('/heartbeat', async (req, res) => {
  try {
    const userId = safeString(req.body.user_id);

    if (!userId) {
      return res.json({
        success: false,
        error: 'user_id is required'
      });
    }

    await touchUserLastSeen(userId);

    return res.json({
      success: true
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

app.get('/access-requests', async (req, res) => {
  try {
    const status = safeString(req.query.status || 'pending').toLowerCase();

    const { data, error } = await supabaseAdmin
      .from('access_requests')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (error) {
      return res.json({
        success: false,
        error: error.message,
        requests: []
      });
    }

    return res.json({
      success: true,
      requests: data || []
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      requests: []
    });
  }
});

app.post('/approve-request', async (req, res) => {
  try {
    const requestId = safeString(req.body.request_id);

    if (!requestId) {
      return res.json({
        success: false,
        error: 'request_id is required'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('access_requests')
      .update({ status: 'approved' })
      .eq('id', requestId)
      .select();

    if (error) {
      return res.json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

app.post('/deny-request', async (req, res) => {
  try {
    const requestId = safeString(req.body.request_id);

    if (!requestId) {
      return res.json({
        success: false,
        error: 'request_id is required'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('access_requests')
      .update({ status: 'denied' })
      .eq('id', requestId)
      .select();

    if (error) {
      return res.json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

app.post('/decode-vin', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const vehicleInfo = await decodeVIN(vin);

    res.json({
      success: true,
      vehicle: {
        vin,
        year: safeString(vehicleInfo?.ModelYear),
        make: safeString(vehicleInfo?.Make),
        model: safeString(vehicleInfo?.Model),
        engine: safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL),
        trim: safeString(vehicleInfo?.Trim),
        driveType: safeString(vehicleInfo?.DriveType),
        fuelType: safeString(vehicleInfo?.FuelTypePrimary)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================
   DIAG ROUTES
========================= */

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

app.post('/chat', async (req, res) => {
  try {
    const context = {
      question: safeString(req.body.question),
      vin: safeString(req.body.vin),
      code: safeString(req.body.code),
      symptom: safeString(req.body.symptom),
      notes: safeString(req.body.notes),
      vehicle: req.body.vehicle || {},
      currentMode: safeString(req.body.current_mode),
      currentStep: req.body.current_step || {},
      treeIssueSummary: safeString(req.body.tree_issue_summary),
      treeLikelyFaultPath: safeString(req.body.tree_likely_fault_path),
      treeFinalRecommendation: safeString(req.body.tree_final_recommendation),
      stepHistory: Array.isArray(req.body.step_history) ? req.body.step_history : [],
      chatHistory: Array.isArray(req.body.chat_history) ? req.body.chat_history : [],
      knownFixesText: safeString(req.body.known_fixes_text)
    };

    const action = safeString(req.body.action) || 'chat';

    if (action === 'make_next_step') {
      const nextStep = await callOpenAIForNextStep(context);
      const reply = nextStep
        ? `Built next step: ${nextStep.title}`
        : 'Could not build a structured next step from chat.';

      return res.json({
        success: true,
        reply,
        next_step: nextStep
      });
    }

    const reply = await callOpenAIForChat(context);

    res.json({
      success: true,
      reply
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      reply: `Chat error: ${err.message}`
    });
  }
});

/* =========================
   ASK ALLIE ROUTES
========================= */

app.get('/ask-allie-health', async (req, res) => {
  try {
    const { count, error } = await supabaseAdmin
      .from('ask_allie_sessions')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      status: 'ok',
      ask_allie_sessions_count: count || 0,
      openai_configured: true,
      tavily_configured: true
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/ask-allie', async (req, res) => {
  try {
    const question = safeString(req.body.question);
    const incomingSessionId = safeString(req.body.session_id);
    const jobContext = buildAskAllieContext(req.body.job_context || {});

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

      if (existingSession) {
        session = existingSession;
      }
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

      if (!insertedSession) {
        return res.status(500).json({
          success: false,
          error: 'ask_allie_sessions insert returned no row'
        });
      }

      session = insertedSession;
    }

    const sessionId = session.id;

    await supabaseAdmin
      .from('ask_allie_sessions')
      .update({
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
      })
      .eq('id', sessionId);

    const { error: userMessageError } = await supabaseAdmin
      .from('ask_allie_messages')
      .insert([
        {
          session_id: sessionId,
          role: 'user',
          content: question,
          metadata: { job_context: jobContext }
        }
      ]);

    if (userMessageError) {
      return res.status(500).json({ success: false, error: userMessageError.message });
    }

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
        raw_content: safeString(item.content),
        extracted_summary: safeString(item.content),
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

    const extracted = await extractStructuredDataFromWeb(extractionInputSources, jobContext);

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

app.post('/ask-allie-feedback', async (req, res) => {
  try {
    const sessionId = safeString(req.body.session_id);
    const messageId = safeString(req.body.message_id);
    const feedbackType = safeString(req.body.feedback_type);
    const notes = safeString(req.body.notes);
    const promoteKnownFix = Boolean(req.body.promote_known_fix);
    const confirmedFix = req.body.confirmed_fix || {};
    const vehicleContext = buildAskAllieContext(req.body.vehicle_context || {});

    if (!sessionId || !feedbackType) {
      return res.status(400).json({
        success: false,
        error: 'session_id and feedback_type are required'
      });
    }

    const { error: feedbackError } = await supabaseAdmin
      .from('ask_allie_feedback')
      .insert([
        {
          session_id: sessionId,
          message_id: messageId || null,
          feedback_type: feedbackType,
          notes: notes || null
        }
      ]);

    if (feedbackError) throw new Error(feedbackError.message);

    if (feedbackType === 'confirm' || feedbackType === 'repair_confirmed') {
      const promotedStatus = feedbackType === 'repair_confirmed' ? 'repair_confirmed' : 'tech_confirmed';

      await supabaseAdmin
        .from('ask_allie_sources')
        .update({ status: promotedStatus, confidence_score: 90 })
        .eq('session_id', sessionId);

      await supabaseAdmin
        .from('ask_allie_facts')
        .update({ status: promotedStatus, confidence_score: 90 })
        .eq('session_id', sessionId);
    }

    if (feedbackType === 'reject') {
      await supabaseAdmin
        .from('ask_allie_sources')
        .update({ status: 'rejected', confidence_score: 10 })
        .eq('session_id', sessionId);

      await supabaseAdmin
        .from('ask_allie_facts')
        .update({ status: 'rejected', confidence_score: 10 })
        .eq('session_id', sessionId);
    }

    if (promoteKnownFix && safeString(confirmedFix.repair_performed)) {
      const { data: existingRows } = await supabaseAdmin
        .from('ask_allie_known_fixes')
        .select('*')
        .eq('make', vehicleContext.make)
        .eq('model', vehicleContext.model)
        .eq('engine', vehicleContext.engine)
        .eq('root_cause', safeString(confirmedFix.root_cause))
        .eq('repair_performed', safeString(confirmedFix.repair_performed))
        .limit(1);

      const existingRow = existingRows?.[0] || null;

      if (existingRow) {
        await supabaseAdmin
          .from('ask_allie_known_fixes')
          .update({
            repeat_count: toNumber(existingRow.repeat_count, 1) + 1,
            confidence_score: 95,
            status: 'repair_confirmed',
            updated_at: new Date().toISOString(),
            outcome: safeString(confirmedFix.outcome) || existingRow.outcome
          })
          .eq('id', existingRow.id);
      } else {
        await supabaseAdmin
          .from('ask_allie_known_fixes')
          .insert([
            {
              vin: vehicleContext.vin,
              year: vehicleContext.year,
              make: vehicleContext.make,
              model: vehicleContext.model,
              engine: vehicleContext.engine,
              dtcs: vehicleContext.dtcs,
              symptom_pattern: safeString(confirmedFix.symptom_pattern),
              root_cause: safeString(confirmedFix.root_cause),
              repair_performed: safeString(confirmedFix.repair_performed),
              outcome: safeString(confirmedFix.outcome) || 'Fixed',
              confidence_score: 95,
              repeat_count: 1,
              status: 'repair_confirmed',
              updated_at: new Date().toISOString()
            }
          ]);
      }
    }

    return res.json({
      success: true,
      message: 'Ask Allie feedback saved'
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/ask-allie-session/:sessionId', async (req, res) => {
  try {
    const sessionId = safeString(req.params.sessionId);

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('ask_allie_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const { data: messages } = await supabaseAdmin
      .from('ask_allie_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    const { data: sources } = await supabaseAdmin
      .from('ask_allie_sources')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    const { data: facts } = await supabaseAdmin
      .from('ask_allie_facts')
      .select('*')
      .eq('session_id', sessionId)
      .order('confidence_score', { ascending: false });

    return res.json({
      success: true,
      session,
      messages: messages || [],
      sources: sources || [],
      facts: facts || []
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   REPAIR CASE ROUTES
========================= */

app.get('/test-db', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('repair_cases')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

app.post('/save-repair', async (req, res) => {
  try {
    const record = {
      vin: safeString(req.body.vin),
      year: safeString(req.body.year),
      make: safeString(req.body.make),
      model: safeString(req.body.model),
      engine: safeString(req.body.engine),
      fault_code: safeString(req.body.fault_code),
      complaint: safeString(req.body.complaint),
      ai_diagnosis: typeof req.body.ai_diagnosis === 'string' ? req.body.ai_diagnosis : JSON.stringify(req.body.ai_diagnosis || ''),
      recommended_tests: typeof req.body.recommended_tests === 'string' ? req.body.recommended_tests : JSON.stringify(req.body.recommended_tests || ''),
      final_fix: safeString(req.body.final_fix),
      tech_name: safeString(req.body.tech_name),
      status: safeString(req.body.status) || 'open',
      notes: safeString(req.body.notes)
    };

    if (record.final_fix) {
      const { data: existingRows } = await supabaseAdmin
        .from('repair_cases')
        .select('*')
        .eq('vin', record.vin)
        .eq('fault_code', record.fault_code)
        .eq('complaint', record.complaint)
        .order('created_at', { ascending: false })
        .limit(1);

      if (existingRows && existingRows.length > 0) {
        const existing = existingRows[0];
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('repair_cases')
          .update({
            year: record.year || existing.year,
            make: record.make || existing.make,
            model: record.model || existing.model,
            engine: record.engine || existing.engine,
            ai_diagnosis: record.ai_diagnosis || existing.ai_diagnosis,
            recommended_tests: record.recommended_tests || existing.recommended_tests,
            final_fix: record.final_fix,
            tech_name: record.tech_name || existing.tech_name,
            status: 'fixed',
            notes: record.notes || existing.notes
          })
          .eq('id', existing.id)
          .select();

        if (updateError) return res.status(500).json({ success: false, error: updateError.message });
        return res.json({ success: true, updated: true, data: updated });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('repair_cases')
      .insert([record])
      .select();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/record-step-result', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const fault_code = safeString(req.body.fault_code);
    const complaint = safeString(req.body.complaint);
    const notes = safeString(req.body.notes);
    const step_title = safeString(req.body.step_title);
    const step_id = safeString(req.body.step_id);
    const button_result = safeString(req.body.button_result);
    const next_step_id = safeString(req.body.next_step_id);

    const timelineLine = `[${new Date().toISOString()}] Step: ${step_title || step_id} | Result: ${button_result} | Next: ${next_step_id || 'end'}`;

    const { data, error } = await supabaseAdmin
      .from('repair_cases')
      .insert([
        {
          vin,
          year: safeString(req.body.year),
          make: safeString(req.body.make),
          model: safeString(req.body.model),
          engine: safeString(req.body.engine),
          fault_code,
          complaint,
          ai_diagnosis: safeString(req.body.ai_diagnosis),
          recommended_tests: step_title,
          final_fix: safeString(req.body.final_fix),
          tech_name: safeString(req.body.tech_name),
          status: safeString(req.body.status) || 'in_progress',
          notes: notes ? `${notes}\n${timelineLine}` : timelineLine
        }
      ])
      .select();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================
   AUTH ROUTES
========================= */

app.post('/signup', async (req, res) => {
  try {
    const name = safeString(req.body.name);
    const email = safeString(req.body.email).toLowerCase();
    const password = safeString(req.body.password);

    if (!email || !password) {
      return res.json({
        success: false,
        error: 'Email and password required'
      });
    }

    const latestRequest = await getLatestAccessRequestByEmail(email);

    if (latestRequest && lower(latestRequest.status) === 'pending') {
      return res.json({
        success: false,
        error: 'An access request for this email is already pending approval.'
      });
    }

    const existingAuthUser = await findAuthUserByEmail(email);

    if (existingAuthUser) {
      return res.json({
        success: false,
        error: 'This email already exists in the login system. Use the original password or reset the password instead of signing up again.'
      });
    }

    const { data: createdUserData, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name
      }
    });

    if (createUserError || !createdUserData?.user) {
      return res.json({
        success: false,
        error: createUserError?.message || 'Failed to create auth user'
      });
    }

    const authUser = createdUserData.user;

    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .upsert([
        {
          id: authUser.id,
          email,
          name,
          role: 'tech',
          last_seen: null
        }
      ], { onConflict: 'id' });

    if (profileError) {
      return res.json({
        success: false,
        error: profileError.message
      });
    }

    const { data: requestRows, error: requestError } = await supabaseAdmin
      .from('access_requests')
      .insert([
        {
          name,
          email,
          company: '',
          reason: 'Requested access from app signup form',
          status: 'pending'
        }
      ])
      .select();

    if (requestError) {
      return res.json({
        success: false,
        error: requestError.message
      });
    }

    return res.json({
      success: true,
      message: 'Account created and access request submitted. An administrator must approve your account before login is allowed.',
      request: requestRows?.[0] || null,
      user_id: authUser.id
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

app.post('/login', async (req, res) => {
  try {
    const email = safeString(req.body.email).toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.json({
        success: false,
        error: 'Email and password required',
        user: null,
        session: null,
        profile: null
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
        session: null,
        profile: null
      });
    }

    if (!data || !data.user || !data.session) {
      return res.json({
        success: false,
        error: 'Login did not return a valid user session',
        user: data?.user || null,
        session: data?.session || null,
        profile: null
      });
    }

    const latestRequest = await getLatestAccessRequestByEmail(email);

    if (latestRequest && lower(latestRequest.status) !== 'approved') {
      return res.json({
        success: false,
        error: 'Your account is not approved yet.',
        user: null,
        session: null,
        profile: null
      });
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    const preservedRole = safeString(existingProfile?.role) || 'tech';
    const preservedName = safeString(existingProfile?.name || data.user.user_metadata?.name || '');

    const { data: updatedProfile, error: profileUpsertError } = await supabaseAdmin
      .from('user_profiles')
      .upsert([
        {
          id: data.user.id,
          email,
          name: preservedName,
          role: preservedRole,
          last_seen: new Date().toISOString()
        }
      ], { onConflict: 'id' })
      .select()
      .single();

    if (profileUpsertError) {
      return res.json({
        success: false,
        error: profileUpsertError.message,
        user: null,
        session: null,
        profile: null
      });
    }

    await touchUserLastSeen(data.user.id);

    return res.json({
      success: true,
      user: data.user,
      session: data.session,
      profile: updatedProfile
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      user: null,
      session: null,
      profile: null
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
