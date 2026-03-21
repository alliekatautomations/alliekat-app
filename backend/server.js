const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// =========================
// SUPABASE
// =========================
const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// =========================
// HELPERS
// =========================
function safeString(value) {
  return String(value || '').trim();
}

async function decodeVIN(vin) {
  try {
    const cleanVin = String(vin || '').trim();
    if (cleanVin.length < 11) return null;

    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${cleanVin}?format=json`);
    const data = await res.json();

    return data?.Results?.[0] || null;
  } catch {
    return null;
  }
}

function defaultTree(payload) {
  const code = safeString(payload.code);
  const symptom = safeString(payload.symptom);
  const notes = safeString(payload.notes);

  return {
    issue_summary: code
      ? `Diagnostic path for fault code ${code}${symptom ? ` with symptom: ${symptom}` : ''}`
      : `Diagnostic path${symptom ? ` for symptom: ${symptom}` : ''}`,
    current_position: notes
      ? `Tech notes already entered: ${notes}`
      : 'Starting at the first decision point with no completed test notes entered.',
    current_step_id: 'step_1',
    steps: [
      {
        id: 'step_1',
        title: 'Verify complaint and active code condition',
        instruction: 'Confirm the complaint, verify the DTC is active or current, and identify whether the fault is present now or intermittent.',
        where_to_test: 'Scan tool, key on / engine off and key on / engine running as applicable.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Fault status should match actual complaint condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Record whether the code is active, inactive, history-only, or resets immediately after clearing.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_2' },
          { label: 'FAIL', next_step_id: 'step_fail_1' },
          { label: 'NOT TESTED', next_step_id: 'step_2' }
        ]
      },
      {
        id: 'step_2',
        title: 'Check power, ground, and reference circuits before replacing parts',
        instruction: 'Verify power feeds, grounds, and reference circuits at the affected component or control circuit.',
        where_to_test: 'At the suspected sensor, actuator, or module connector.',
        expected_specs: {
          voltage: 'Typical 5V reference or battery voltage depending on circuit; verify exact OEM spec/pinout for this platform',
          ohms: 'Low resistance to ground on ground circuits; verify exact OEM spec/pinout for this platform',
          pressure: 'N/A unless pressure-based fault',
          signal: 'Signal should change logically with component movement or operating condition',
          voltage_drop: 'Typically low on good power and ground circuits; verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Backprobe the connector, check power feed, ground integrity, and signal behavior under load.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_3' },
          { label: 'FAIL', next_step_id: 'step_fail_2' },
          { label: 'NOT TESTED', next_step_id: 'step_3' }
        ]
      },
      {
        id: 'step_3',
        title: 'Inspect harness, connector fit, and known failure points',
        instruction: 'Inspect for rub-through, poor pin drag, water intrusion, spread terminals, corrosion, and repair history.',
        where_to_test: 'Harness routing, connector bodies, bends near engine brackets, frame rails, and component entry points.',
        expected_specs: {
          voltage: 'No abnormal drop from movement or wiggle test',
          ohms: 'No opens or unstable readings during harness movement',
          pressure: 'N/A unless pressure-based fault',
          signal: 'Signal should remain stable during wiggle test',
          voltage_drop: 'No excessive change during movement test'
        },
        how_to_test: 'Wiggle test the circuit while monitoring live data or meter readings.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_4' },
          { label: 'FAIL', next_step_id: 'step_fail_3' },
          { label: 'NOT TESTED', next_step_id: 'step_4' }
        ]
      },
      {
        id: 'step_4',
        title: 'Component functional verification',
        instruction: 'Verify whether the affected component responds correctly once circuit integrity is confirmed.',
        where_to_test: 'At the component and with scan data if available.',
        expected_specs: {
          voltage: 'Per OEM spec for the affected component',
          ohms: 'Per OEM spec for the affected component',
          pressure: 'Per OEM spec if pressure-related',
          signal: 'Signal should track input or command smoothly with no dropouts',
          voltage_drop: 'Minimal on good circuits'
        },
        how_to_test: 'Compare commanded value versus actual value, or manually stimulate the component where applicable.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_pass_final' },
          { label: 'FAIL', next_step_id: 'step_fail_final' },
          { label: 'NOT TESTED', next_step_id: 'step_fail_final' }
        ]
      },
      {
        id: 'step_fail_1',
        title: 'Code / complaint did not verify normally',
        instruction: 'Treat as intermittent or event-based fault. Check freeze-frame, duplication conditions, and recent repairs.',
        where_to_test: 'Scan tool history, freeze-frame, and operating conditions.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Complaint should be reproducible before part replacement',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Road test or duplicate condition, then restart tree once fault is active.',
        result_buttons: [
          { label: 'CONTINUE', next_step_id: 'step_2' }
        ]
      },
      {
        id: 'step_fail_2',
        title: 'Circuit failure found',
        instruction: 'Repair power, ground, reference, or return circuit issue before condemning component.',
        where_to_test: 'Affected circuit path between source, component, and module.',
        expected_specs: {
          voltage: 'Restore proper supply/reference',
          ohms: 'Restore proper continuity / ground path',
          pressure: 'N/A',
          signal: 'Signal should normalize after circuit repair',
          voltage_drop: 'Return to acceptable range'
        },
        how_to_test: 'Repair open, short, high resistance, pin drag, or corrosion. Recheck before moving forward.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_1' }
        ]
      },
      {
        id: 'step_fail_3',
        title: 'Harness / connector defect found',
        instruction: 'Repair the physical wiring or connector defect and verify the fault does not return.',
        where_to_test: 'The exact damaged section or connector location.',
        expected_specs: {
          voltage: 'Stable after repair',
          ohms: 'Stable after repair',
          pressure: 'N/A',
          signal: 'Stable after repair',
          voltage_drop: 'Stable after repair'
        },
        how_to_test: 'Repair harness or connector, clear codes, duplicate complaint, and retest.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_1' }
        ]
      },
      {
        id: 'step_pass_final',
        title: 'Circuit and component both tested good',
        instruction: 'Suspect intermittent wiring issue, environmental trigger, mechanical issue, or calibration/software issue.',
        where_to_test: 'System-level review, freeze-frame, and related systems.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'No abnormal dropouts under operating condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Check related circuits, module updates, mechanical binding, and intermittents.',
        result_buttons: []
      },
      {
        id: 'step_fail_final',
        title: 'Component likely failed after circuit verification',
        instruction: 'If all feeds, grounds, references, and harness integrity are verified, component fault path is likely.',
        where_to_test: 'Affected sensor / actuator / module.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Should be abnormal only after circuit integrity is confirmed good',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Substitute known-good component or perform OEM final verification before replacement.',
        result_buttons: []
      }
    ],
    likely_fault_path: 'Most likely path is circuit, connector, or harness issue first. Confirm circuit integrity before replacing components.',
    final_recommendation: 'Use button flow to walk through each step. Save confirmed final fix after repair.',
    source: 'fallback'
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
    const possibleJson = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  return null;
}

function normalizeTree(modelTree, payload, vehicleInfo) {
  const fallback = defaultTree(payload);

  if (!modelTree || typeof modelTree !== 'object') {
    return fallback;
  }

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
    source: 'openai',
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

async function createStructuredTroubleTree({ vin, code, symptom, notes, vehicleInfo }) {
  const openAiKey = process.env.OPENAI_API_KEY;

  if (!openAiKey) {
    return defaultTree({ vin, code, symptom, notes });
  }

  const systemPrompt = `
You are a master diesel and automotive diagnostic technician.

You must return ONLY valid JSON.
No markdown.
No code fences.
No extra commentary.

Your job is to convert the current case into a button-driven diagnostic tree.

Rules:
- Build a clean troubleshooting tree for a technician.
- One step should lead to the next step based on button result.
- Each step must have button choices that map to next_step_id values.
- Prefer button labels like PASS, FAIL, NOT TESTED, CONTINUE, RETEST.
- Use the notes already provided so you do not restart from the beginning if previous checks were already completed.
- If exact OEM specs are not certain, say: "Verify exact OEM spec/pinout for this platform"
- Never invent exact pin numbers if uncertain.
- Keep wording practical and bay-friendly.

Return JSON in this exact shape:
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

DECODED VEHICLE:
Make: ${vehicleInfo?.Make || 'unknown'}
Model: ${vehicleInfo?.Model || 'unknown'}
Year: ${vehicleInfo?.ModelYear || 'unknown'}
Engine: ${vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL || 'unknown'}
Trim: ${vehicleInfo?.Trim || 'unknown'}
Drive Type: ${vehicleInfo?.DriveType || 'unknown'}
Fuel Type: ${vehicleInfo?.FuelTypePrimary || 'unknown'}

FAULT CODE:
${code || 'none provided'}

SYMPTOM:
${symptom || 'none provided'}

COMPLETED TESTS / NOTES:
${notes || 'none provided'}

Build the diagnostic tree now.
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

    return normalizeTree(parsed, { vin, code, symptom, notes }, vehicleInfo);
  } catch {
    return defaultTree({ vin, code, symptom, notes });
  }
}

// =========================
// ROUTES
// =========================
app.get('/', (req, res) => {
  res.send('Allie-kat backend live with structured step tree');
});

app.get('/test-db', async (req, res) => {
  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/search-by-code/:code', async (req, res) => {
  const code = safeString(req.params.code);

  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .ilike('fault_code', `%${code}%`)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/search-by-vin/:vin', async (req, res) => {
  const vin = safeString(req.params.vin);

  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .ilike('vin', `%${vin}%`)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

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
      ai_diagnosis: typeof req.body.ai_diagnosis === 'string'
        ? req.body.ai_diagnosis
        : JSON.stringify(req.body.ai_diagnosis || ''),
      recommended_tests: typeof req.body.recommended_tests === 'string'
        ? req.body.recommended_tests
        : JSON.stringify(req.body.recommended_tests || ''),
      final_fix: safeString(req.body.final_fix),
      tech_name: safeString(req.body.tech_name),
      status: safeString(req.body.status) || 'open',
      notes: safeString(req.body.notes)
    };

    if (record.final_fix) {
      const { data: existingRows, error: findError } = await supabase
        .from('repair_cases')
        .select('*')
        .eq('vin', record.vin)
        .eq('fault_code', record.fault_code)
        .eq('complaint', record.complaint)
        .order('created_at', { ascending: false })
        .limit(1);

      if (findError) {
        return res.status(500).json({ success: false, error: findError.message });
      }

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
            status: record.status || 'fixed',
            notes: record.notes || existing.notes
          })
          .eq('id', existing.id)
          .select();

        if (updateError) {
          return res.status(500).json({ success: false, error: updateError.message });
        }

        return res.json({
          success: true,
          updated: true,
          data: updated
        });
      }

      const { data: insertedFinal, error: insertFinalError } = await supabase
        .from('repair_cases')
        .insert([record])
        .select();

      if (insertFinalError) {
        return res.status(500).json({ success: false, error: insertFinalError.message });
      }

      return res.json({
        success: true,
        updated: false,
        data: insertedFinal
      });
    }

    const { data: existing, error: findError } = await supabase
      .from('repair_cases')
      .select('*')
      .eq('vin', record.vin)
      .eq('fault_code', record.fault_code)
      .eq('complaint', record.complaint)
      .eq('notes', record.notes)
      .order('created_at', { ascending: false })
      .limit(1);

    if (findError) {
      return res.status(500).json({ success: false, error: findError.message });
    }

    if (existing && existing.length > 0) {
      return res.json({
        success: true,
        duplicate: true,
        data: existing
      });
    }

    const { data, error } = await supabase
      .from('repair_cases')
      .insert([record])
      .select();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      duplicate: false,
      data
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FAST DIAGNOSE ROUTE
app.post('/diagnose', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const code = safeString(req.body.code);
    const symptom = safeString(req.body.symptom);
    const notes = safeString(req.body.notes);

    const quickTree = defaultTree({ vin, code, symptom, notes });

    res.json({
      success: true,
      mode: 'step-tree',
      vehicle: {
        vin,
        year: '',
        make: '',
        model: '',
        engine: '',
        trim: '',
        driveType: '',
        fuelType: ''
      },
      tree: quickTree
    });

    (async () => {
      try {
        let vehicleInfo = null;

        if (vin && vin.length >= 11) {
          vehicleInfo = await decodeVIN(vin);
        }

        await createStructuredTroubleTree({
          vin,
          code,
          symptom,
          notes,
          vehicleInfo
        });

        console.log('Enhanced tree built in background');
      } catch (e) {
        console.log('Background enhancement failed');
      }
    })();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
});

app.post('/record-step-result', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);
    const fault_code = safeString(req.body.fault_code);
    const tech_name = safeString(req.body.tech_name);
    const status = safeString(req.body.status) || 'in_progress';
    const final_fix = safeString(req.body.final_fix);
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
          final_fix,
          tech_name,
          status,
          notes: notes ? `${notes}\n${timelineLine}` : timelineLine
        }
      ])
      .select();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
