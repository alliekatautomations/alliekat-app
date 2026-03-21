const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

function safeString(value) {
  return String(value || '').trim();
}

function normalizeCode(code) {
  return safeString(code).toUpperCase();
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

function summarizeLearningRows(rows) {
  const fixesMap = new Map();

  for (const row of rows) {
    const finalFix = safeString(row.final_fix);
    if (!finalFix) continue;

    const key = finalFix.toLowerCase();

    if (!fixesMap.has(key)) {
      fixesMap.set(key, {
        final_fix: finalFix,
        count: 0,
        examples: []
      });
    }

    const item = fixesMap.get(key);
    item.count += 1;

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
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function rowLooksUsableForLearning(row) {
  const finalFix = safeString(row.final_fix);
  if (!finalFix) return false;

  const status = safeString(row.status).toLowerCase();

  if (!status) return true;
  if (status === 'fixed') return true;
  if (status === 'complete') return true;
  if (status === 'completed') return true;
  if (status === 'closed') return true;

  return false;
}

async function getLearningContext({ code, vehicleInfo }) {
  const normalizedCode = normalizeCode(code);
  const make = safeString(vehicleInfo?.Make);
  const model = safeString(vehicleInfo?.Model);
  const engine = safeString(vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL);

  let codeRows = [];
  let vehicleRows = [];

  if (normalizedCode) {
    const { data } = await supabase
      .from('repair_cases')
      .select('*')
      .ilike('fault_code', `%${normalizedCode}%`)
      .order('created_at', { ascending: false })
      .limit(50);

    codeRows = (data || []).filter(rowLooksUsableForLearning);
  }

  if (make || model) {
    let query = supabase
      .from('repair_cases')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (make) query = query.ilike('make', make);
    if (model) query = query.ilike('model', model);

    const { data } = await query;
    vehicleRows = (data || [])
      .filter(rowLooksUsableForLearning)
      .filter(row => {
        if (!engine) return true;
        const rowEngine = safeString(row.engine).toLowerCase();
        return rowEngine.includes(engine.toLowerCase()) || engine.toLowerCase().includes(rowEngine);
      });
  }

  const combined = [];

  for (const row of codeRows) {
    if (!combined.find(x => x.id === row.id)) combined.push(row);
  }

  for (const row of vehicleRows) {
    if (!combined.find(x => x.id === row.id)) combined.push(row);
  }

  const suggestedFixes = summarizeLearningRows(combined);

  return {
    total_matches: combined.length,
    code_matches: codeRows.slice(0, 10),
    vehicle_matches: vehicleRows.slice(0, 10),
    suggested_fixes: suggestedFixes
  };
}

function learningContextToText(learningContext) {
  if (!learningContext || !learningContext.total_matches) {
    return 'No prior confirmed repair history found in the internal database.';
  }

  const lines = [];
  lines.push(`Internal confirmed repair matches found: ${learningContext.total_matches}`);

  if (learningContext.suggested_fixes?.length) {
    lines.push('Most common confirmed fixes:');
    for (const fix of learningContext.suggested_fixes) {
      lines.push(`- ${fix.final_fix} (count: ${fix.count})`);
    }
  }

  if (learningContext.code_matches?.length) {
    lines.push('Recent confirmed code matches:');
    for (const row of learningContext.code_matches.slice(0, 5)) {
      lines.push(`- Code: ${safeString(row.fault_code)} | Complaint: ${safeString(row.complaint)} | Fix: ${safeString(row.final_fix)} | Notes: ${safeString(row.notes)}`);
    }
  }

  if (learningContext.vehicle_matches?.length) {
    lines.push('Recent confirmed same-platform matches:');
    for (const row of learningContext.vehicle_matches.slice(0, 5)) {
      lines.push(`- ${safeString(row.make)} ${safeString(row.model)} ${safeString(row.engine)} | Code: ${safeString(row.fault_code)} | Fix: ${safeString(row.final_fix)}`);
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

Hard requirements:
- Use the actual DTC and complaint throughout the tree when available.
- Make each step read like a real technician instruction, not a summary.
- Include practical checks like:
  - power feed checks
  - ground checks
  - reference voltage checks
  - signal checks
  - connector inspection
  - wiggle harness testing
  - ohms checks while moving harness
  - continuity checks while moving harness
  - voltage drop checks
  - module-side verification
  - compare source-side reading to module-side reading
- Explain HOW to perform each check in bay language.
- For wiggle test steps, explicitly mention checking for opens/high resistance while moving the harness by hand.
- For wire continuity steps, explain expected ohms and what change during movement means.
- For voltage steps, explain expected ranges and what a bad reading means.
- Include pinout guidance when confidently known.
- If exact OEM pin numbers are not certain, say:
  "Verify exact OEM pinout for this platform"
- Do not invent exact pin numbers if uncertain.
- Prefer 5 to 8 steps total.
- Every step must drive to the next logical branch.
- Use internal confirmed repair history if it is relevant, but do not blindly jump to the prior fix without proving it by testing.
- If internal history strongly suggests a common failure point, direct the tech to test that failure point early.

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
You are a master diesel and automotive diagnostic technician in EXPERT MODE.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Build a highly detailed button-driven diagnostic tree that reasons like a seasoned diagnostic tech.

Expert mode requirements:
- Treat the technician notes as real evidence, not background filler.
- Skip or compress basic checks if the notes already strongly prove they were done.
- Do NOT restart from beginner steps unless the evidence is weak or conflicting.
- Use actual DTC, complaint, vehicle platform, and internal confirmed repair history aggressively.
- Prioritize the most likely failure path sooner.
- If internal repair history points to a repeat failure point, move that branch early in the tree.
- Focus on direct fault isolation:
  - source-side signal checks
  - module-side signal checks
  - voltage drop under load
  - continuity / ohms while moving harness
  - wiggle test with meter/live data
  - connector drag / spread pin / corrosion / rub-through
  - compare commanded vs actual
- Explain exactly what the tech should do with the meter or scan tool.
- Include expected voltages, ohms, signal behavior, voltage drop, and what the result means.
- Include pinout guidance when confidently known.
- If exact OEM pin numbers are not certain, say:
  "Verify exact OEM pinout for this platform"
- Do not invent exact pin numbers if uncertain.
- Prefer 4 to 7 high-value steps.
- Every branch should move the tech closer to isolating the failure, not just verifying basics again.

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

Internal learning context:
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
        temperature: mode === 'expert' ? 0.05 : 0.1,
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

    return normalizeTree(parsed, { vin, code, symptom, notes }, vehicleInfo, mode === 'expert' ? 'openai-expert' : 'openai');
  } catch {
    return buildQuickTree({ vin, code, symptom, notes });
  }
}

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
