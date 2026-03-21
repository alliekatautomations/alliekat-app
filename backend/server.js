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

function buildQuickTree(payload) {
  const vin = safeString(payload.vin);
  const code = safeString(payload.code).toUpperCase();
  const symptom = safeString(payload.symptom);
  const notes = safeString(payload.notes);

  const issueSummary = code
    ? `Rapid-start diagnostic path for DTC ${code}${symptom ? ` with complaint: ${symptom}` : ''}`
    : `Rapid-start diagnostic path${symptom ? ` for complaint: ${symptom}` : ''}`;

  const currentPosition = notes
    ? `Technician notes already entered: ${notes}`
    : code
      ? `Starting rapid tree using entered DTC ${code}`
      : 'Starting rapid tree with no DTC-specific information entered.';

  const dtcLabel = code || 'reported fault';
  const complaintLabel = symptom || 'reported complaint';

  return {
    issue_summary: issueSummary,
    current_position: currentPosition,
    current_step_id: 'step_1',
    steps: [
      {
        id: 'step_1',
        title: code ? `Verify DTC ${code} and complaint` : 'Verify complaint and active fault',
        instruction: code
          ? `Confirm DTC ${code} is active/current and verify complaint: ${complaintLabel}. Determine whether the fault is present now or intermittent.`
          : `Confirm the complaint is present now and determine whether the fault is active or intermittent.`,
        where_to_test: 'Scan tool, key on / engine off and key on / engine running as applicable.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: code ? `Live data and fault state should support DTC ${code}` : 'Fault state should match complaint condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: code
          ? `Record whether DTC ${code} is active, inactive, history-only, or resets immediately after clearing. Compare complaint with live data and freeze-frame.`
          : 'Record whether the fault is active, inactive, history-only, or resets immediately after clearing.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_2' },
          { label: 'FAIL', next_step_id: 'step_fail_1' },
          { label: 'NOT TESTED', next_step_id: 'step_2' }
        ]
      },
      {
        id: 'step_2',
        title: code ? `Check primary power, ground, and reference circuits for ${code}` : 'Check primary power, ground, and reference circuits',
        instruction: code
          ? `Before replacing parts for DTC ${code}, verify the main power feed, ground path, 5V reference if used, and signal return at the affected circuit.`
          : 'Before replacing parts, verify main power feed, ground path, reference circuit, and signal return at the affected circuit.',
        where_to_test: 'At the affected sensor, actuator, or module connector.',
        expected_specs: {
          voltage: 'Typical 5V reference or battery voltage depending on circuit; verify exact OEM spec/pinout for this platform',
          ohms: 'Low resistance on good ground path; verify exact OEM spec/pinout for this platform',
          pressure: 'N/A unless pressure-based fault',
          signal: code ? `Signal should behave normally for the circuit tied to DTC ${code}` : 'Signal should change logically with operating condition',
          voltage_drop: 'Typically low on good feeds and grounds; verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Backprobe the connector. Check supply voltage, reference voltage, ground integrity, and signal return under load instead of open-circuit only.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_3' },
          { label: 'FAIL', next_step_id: 'step_fail_2' },
          { label: 'NOT TESTED', next_step_id: 'step_3' }
        ]
      },
      {
        id: 'step_3',
        title: code ? `Check signal sweep and compare actual behavior for ${code}` : 'Check signal sweep and compare actual behavior',
        instruction: code
          ? `Verify the signal circuit tied to DTC ${code} changes correctly through its full operating range without dropouts, spikes, or dead spots.`
          : 'Verify the signal changes correctly through its operating range without dropouts, spikes, or dead spots.',
        where_to_test: 'Signal wire at component connector, scan data, and related module input where applicable.',
        expected_specs: {
          voltage: 'Typical sensor signal may sweep through a range such as about 0.5V to 4.5V depending on circuit; verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Per OEM spec if pressure-based sensor is involved',
          signal: 'Signal should move smoothly and logically with no sudden jumps or loss',
          voltage_drop: 'Signal path should not collapse under movement/load'
        },
        how_to_test: 'Monitor live data and meter/graphing meter if possible. Move the component through range and watch for glitches, flat spots, or mismatch.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_4' },
          { label: 'FAIL', next_step_id: 'step_fail_3' },
          { label: 'NOT TESTED', next_step_id: 'step_4' }
        ]
      },
      {
        id: 'step_4',
        title: code ? `Inspect harness and connectors related to ${code}` : 'Inspect harness and connectors',
        instruction: code
          ? `Inspect for rub-through, poor pin drag, corrosion, water intrusion, stretched wiring, and prior repair issues on the circuits related to DTC ${code}.`
          : 'Inspect for rub-through, poor pin drag, corrosion, water intrusion, stretched wiring, and prior repair issues.',
        where_to_test: 'Harness routing, connector bodies, bends near brackets, engine movement points, frame rails, and module entry points.',
        expected_specs: {
          voltage: 'No abnormal change during harness movement',
          ohms: 'No opens or unstable resistance during harness movement',
          pressure: 'N/A unless pressure-based fault',
          signal: 'Signal should remain stable during wiggle test',
          voltage_drop: 'No excessive voltage drop change during wiggle test'
        },
        how_to_test: 'Perform a wiggle harness test while monitoring live data or meter readings. Move the harness by hand near bends, mounts, hot spots, and connectors to catch intermittent opens or shorts.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_5' },
          { label: 'FAIL', next_step_id: 'step_fail_4' },
          { label: 'NOT TESTED', next_step_id: 'step_5' }
        ]
      },
      {
        id: 'step_5',
        title: code ? `Check module input / output response for ${code}` : 'Check module input / output response',
        instruction: code
          ? `After circuit and harness checks pass, verify the receiving module is seeing the correct signal for DTC ${code} and responding correctly.`
          : 'After circuit and harness checks pass, verify the receiving module is seeing the correct signal and responding correctly.',
        where_to_test: 'Module connector pins, scan data PIDs, and commanded vs actual values.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Per OEM spec if pressure-related',
          signal: 'Module input should match component output / expected PID behavior',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Compare commanded value versus actual value, compare component-side reading to module-side reading, and verify the module is interpreting the signal correctly.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_pass_final' },
          { label: 'FAIL', next_step_id: 'step_fail_final' },
          { label: 'NOT TESTED', next_step_id: 'step_fail_final' }
        ]
      },
      {
        id: 'step_fail_1',
        title: code ? `${code} did not verify normally` : 'Fault did not verify normally',
        instruction: code
          ? `Treat DTC ${code} as intermittent or event-based. Review freeze-frame, duplication conditions, and recent repairs before condemning a part.`
          : 'Treat fault as intermittent or event-based. Review freeze-frame, duplication conditions, and recent repairs before condemning a part.',
        where_to_test: 'Scan tool history, freeze-frame, duplication conditions, and operator description.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Complaint should be reproducible before final part replacement',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Road test or reproduce the event under the same condition, then restart the tree once the fault becomes active.',
        result_buttons: [
          { label: 'CONTINUE', next_step_id: 'step_2' }
        ]
      },
      {
        id: 'step_fail_2',
        title: 'Primary circuit failure found',
        instruction: code
          ? `Repair the feed, ground, reference, or return issue associated with DTC ${code} before replacing the component.`
          : 'Repair the feed, ground, reference, or return issue before replacing the component.',
        where_to_test: 'Affected circuit path between source, component, and module.',
        expected_specs: {
          voltage: 'Restore proper supply/reference',
          ohms: 'Restore proper continuity / low resistance ground path',
          pressure: 'N/A',
          signal: 'Signal should normalize after circuit repair',
          voltage_drop: 'Return to acceptable range'
        },
        how_to_test: 'Repair open, short, corrosion, high resistance, loose terminal, or pin drag issue. Recheck circuit under load.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_1' }
        ]
      },
      {
        id: 'step_fail_3',
        title: 'Signal failure found',
        instruction: code
          ? `Signal behavior tied to DTC ${code} is not normal. Confirm whether the issue is component-generated or caused by the circuit path.`
          : 'Signal behavior is not normal. Confirm whether the issue is component-generated or caused by the circuit path.',
        where_to_test: 'Signal circuit at source and receiving end.',
        expected_specs: {
          voltage: 'Signal should remain in expected range for application',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Per OEM spec if pressure-related',
          signal: 'Smooth and logical signal with no spikes, flat spots, or dropouts',
          voltage_drop: 'No abnormal loss through signal path'
        },
        how_to_test: 'Compare signal at the component to signal at the receiving module. If source is good and received signal is bad, suspect wiring/connectors. If source is bad, suspect component.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_4' }
        ]
      },
      {
        id: 'step_fail_4',
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
        how_to_test: 'Repair harness or connector, clear the code, duplicate the complaint, and repeat wiggle harness verification.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_1' }
        ]
      },
      {
        id: 'step_pass_final',
        title: 'Circuit and component both tested good',
        instruction: code
          ? `If DTC ${code} still returns, suspect intermittent wiring, environmental trigger, related subsystem fault, mechanical issue, or software/calibration problem.`
          : 'If the fault still returns, suspect intermittent wiring, environmental trigger, related subsystem fault, mechanical issue, or software/calibration problem.',
        where_to_test: 'System-level review, related systems, freeze-frame, and update history.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'No abnormal dropout under actual operating condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Review related sensors/modules, software updates, mechanical binding, and conditions required to duplicate the fault.',
        result_buttons: []
      },
      {
        id: 'step_fail_final',
        title: 'Component or module fault path likely',
        instruction: code
          ? `If all feeds, grounds, reference circuits, signal paths, and harness integrity tied to DTC ${code} are verified good, component or receiving module fault path is likely.`
          : 'If all feeds, grounds, reference circuits, signal paths, and harness integrity are verified good, component or module fault path is likely.',
        where_to_test: 'Affected sensor / actuator / receiving module.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Abnormal only after all supporting circuits are proven good',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Use known-good substitution or OEM final verification before replacement.',
        result_buttons: []
      }
    ],
    likely_fault_path: code
      ? `Most likely rapid-start path for DTC ${code} is circuit, connector, harness, or signal-path issue first. Confirm circuit integrity before replacing parts.`
      : 'Most likely path is circuit, connector, harness, or signal-path issue first. Confirm circuit integrity before replacing parts.',
    final_recommendation: code
      ? `Walk the rapid-start tree for DTC ${code}, confirm the failed branch, and save the actual final repair once the unit is fixed.`
      : 'Walk the rapid-start tree, confirm the failed branch, and save the actual final repair once the unit is fixed.',
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
    const possibleJson = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  return null;
}

function normalizeTree(modelTree, payload, vehicleInfo) {
  const fallback = buildQuickTree(payload);

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
    return buildQuickTree({ vin, code, symptom, notes });
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
- Use the actual DTC and complaint throughout the tree when available.
- Include practical checks like feed, ground, reference, signal, wiggle harness testing, connector inspection, and module-side verification where relevant.
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
    return buildQuickTree({ vin, code, symptom, notes });
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

// FAST + DETAILED DIAGNOSE ROUTE
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
