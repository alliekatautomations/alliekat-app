const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

function safeString(value) {
  return String(value || '').trim();
}

function normalizeCode(code) {
  return safeString(code).toUpperCase();
}

function lower(value) {
  return safeString(value).toLowerCase();
}

function getOnlineCutoffIso(minutes = 15) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function touchUserLastSeen(userId) {
  const cleanUserId = safeString(userId);
  if (!cleanUserId) return;

  try {
    await supabase
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

  const { data, error } = await supabase
    .from('access_requests')
    .select('*')
    .eq('email', cleanEmail)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  return data && data.length ? data[0] : null;
}

async function findAuthUserByEmail(email) {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in Render environment variables.');
  }

  const cleanEmail = safeString(email).toLowerCase();

  let page = 1;
  let foundUser = null;

  while (!foundUser) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000
    });

    if (error) {
      throw new Error(error.message);
    }

    const users = data?.users || [];
    foundUser = users.find(user => safeString(user.email).toLowerCase() === cleanEmail) || null;

    if (foundUser || users.length < 1000) {
      break;
    }

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
        ? step.result_buttons.map((btn) => ({
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

  const { data } = await supabase
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

async function callOpenAIForTree({ vin, code, symptom, notes, vehicleInfo, learningContext, mode }) {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) return buildQuickTree({ vin, code, symptom, notes });

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
        'Authorization': `Bearer ${openAiKey}`,
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
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) {
    return 'Chat is not available because the OpenAI API key is missing.';
  }

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
        'Authorization': `Bearer ${openAiKey}`,
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
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) return null;

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
        'Authorization': `Bearer ${openAiKey}`,
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

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
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

    const { data, error } = await supabase
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

    const { count: totalRegisteredUsers, error: totalError } = await supabase
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

    const { count: onlineRegisteredUsers, error: onlineError } = await supabase
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

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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

app.get('/test-db', async (req, res) => {
  const { data, error } = await supabase
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
      const { data: existingRows } = await supabase
        .from('repair_cases')
        .select('*')
        .eq('vin', record.vin)
        .eq('fault_code', record.fault_code)
        .eq('complaint', record.complaint)
        .order('created_at', { ascending: false })
        .limit(1);

      if (existingRows && existingRows.length > 0) {
        const existing = existingRows[0];
        const { data: updated, error: updateError } = await supabase
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

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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

app.post('/signup', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.json({
        success: false,
        error: 'SUPABASE_SERVICE_ROLE_KEY is missing in Render environment variables.'
      });
    }

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

    const { data: requestRows, error: requestError } = await supabase
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
        error: 'Email and password required'
      });
    }

    const latestRequest = await getLatestAccessRequestByEmail(email);

    if (!latestRequest) {
      return res.json({
        success: false,
        error: 'No access request found for this email. Create an account first.'
      });
    }

    if (lower(latestRequest.status) !== 'approved') {
      return res.json({
        success: false,
        error: 'Your account is not approved yet.'
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

    if (!data || !data.user || !data.session) {
      return res.json({
        success: false,
        error: 'Login did not return a valid user session',
        user: data?.user || null,
        session: data?.session || null
      });
    }

    const { error: profileUpsertError } = await supabaseAdmin
      .from('user_profiles')
      .upsert([
        {
          id: data.user.id,
          email,
          name: safeString(data.user.user_metadata?.name),
          role: 'tech',
          last_seen: new Date().toISOString()
        }
      ], { onConflict: 'id' });

    if (profileUpsertError) {
      console.log('profile upsert during login failed:', profileUpsertError.message);
    }

    await touchUserLastSeen(data.user.id);

    return res.json({
      success: true,
      user: data.user,
      session: data.session
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
