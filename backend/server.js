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
  const code = safeString(payload.code).toUpperCase();
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
          ? `Confirm DTC ${code} is active/current and verify the complaint.`
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
      },
      {
        id: 'step_2',
        title: 'Check primary power, ground, and reference circuits',
        instruction: 'Verify main power feed, ground path, reference circuit, and signal return at the affected circuit.',
        where_to_test: 'At the affected sensor, actuator, or module connector.',
        expected_specs: {
          voltage: 'Typical 5V reference or battery voltage depending on circuit; verify exact OEM spec/pinout for this platform',
          ohms: 'Low resistance on good ground path; verify exact OEM spec/pinout for this platform',
          pressure: 'N/A unless pressure-based fault',
          signal: 'Signal should change logically with operating condition',
          voltage_drop: 'Typically low on good feeds and grounds; verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Backprobe the connector. Check supply voltage, reference voltage, ground integrity, and signal return under load.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_3' },
          { label: 'FAIL', next_step_id: 'step_fail_2' },
          { label: 'NOT TESTED', next_step_id: 'step_3' }
        ]
      },
      {
        id: 'step_3',
        title: 'Inspect harness and connectors',
        instruction: 'Inspect for rub-through, poor pin drag, corrosion, water intrusion, stretched wiring, and prior repair issues.',
        where_to_test: 'Harness routing, connector bodies, bends near brackets, engine movement points, frame rails, and module entry points.',
        expected_specs: {
          voltage: 'No abnormal change during harness movement',
          ohms: 'No opens or unstable resistance during harness movement',
          pressure: 'N/A unless pressure-based fault',
          signal: 'Signal should remain stable during wiggle test',
          voltage_drop: 'No excessive voltage drop change during wiggle test'
        },
        how_to_test: 'Perform a wiggle harness test while monitoring live data or meter readings.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_4' },
          { label: 'FAIL', next_step_id: 'step_fail_3' },
          { label: 'NOT TESTED', next_step_id: 'step_4' }
        ]
      },
      {
        id: 'step_4',
        title: 'Verify component and module response',
        instruction: 'After circuit and harness checks pass, verify component response and module-side input.',
        where_to_test: 'Component connector, module input, scan data, and commanded vs actual values.',
        expected_specs: {
          voltage: 'Per OEM spec for the affected component',
          ohms: 'Per OEM spec for the affected component',
          pressure: 'Per OEM spec if pressure-related',
          signal: 'Signal should track input or command smoothly with no dropouts',
          voltage_drop: 'Minimal on good circuits'
        },
        how_to_test: 'Compare commanded vs actual values and compare component-side reading to module-side reading.',
        result_buttons: [
          { label: 'PASS', next_step_id: 'step_pass_final' },
          { label: 'FAIL', next_step_id: 'step_fail_final' },
          { label: 'NOT TESTED', next_step_id: 'step_fail_final' }
        ]
      },
      {
        id: 'step_fail_1',
        title: 'Fault did not verify normally',
        instruction: 'Treat as intermittent or event-based. Review freeze-frame, duplication conditions, and recent repairs.',
        where_to_test: 'Scan tool history, freeze-frame, duplication conditions, and operator description.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'Complaint should be reproducible before final part replacement',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Road test or reproduce the event, then restart the tree once the fault becomes active.',
        result_buttons: [
          { label: 'CONTINUE', next_step_id: 'step_2' }
        ]
      },
      {
        id: 'step_fail_2',
        title: 'Primary circuit failure found',
        instruction: 'Repair the feed, ground, reference, or return issue before replacing the component.',
        where_to_test: 'Affected circuit path between source, component, and module.',
        expected_specs: {
          voltage: 'Restore proper supply/reference',
          ohms: 'Restore proper continuity / low resistance ground path',
          pressure: 'N/A',
          signal: 'Signal should normalize after circuit repair',
          voltage_drop: 'Return to acceptable range'
        },
        how_to_test: 'Repair open, short, corrosion, high resistance, loose terminal, or pin drag issue.',
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
        how_to_test: 'Repair harness or connector, clear the code, duplicate the complaint, and repeat wiggle harness verification.',
        result_buttons: [
          { label: 'RETEST', next_step_id: 'step_1' }
        ]
      },
      {
        id: 'step_pass_final',
        title: 'Circuit and component both tested good',
        instruction: 'Suspect intermittent wiring, related subsystem fault, mechanical issue, or software/calibration problem.',
        where_to_test: 'System-level review, related systems, freeze-frame, and update history.',
        expected_specs: {
          voltage: 'Verify exact OEM spec/pinout for this platform',
          ohms: 'Verify exact OEM spec/pinout for this platform',
          pressure: 'Verify exact OEM spec/pinout for this platform',
          signal: 'No abnormal dropout under actual operating condition',
          voltage_drop: 'Verify exact OEM spec/pinout for this platform'
        },
        how_to_test: 'Review related sensors/modules, software updates, and conditions required to duplicate the fault.',
        result_buttons: []
      },
      {
        id: 'step_fail_final',
        title: 'Component or module fault path likely',
        instruction: 'If all supporting circuits are verified good, component or receiving module fault path is likely.',
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
      ? `Most likely rapid-start path for DTC ${code} is circuit, connector, harness, or signal-path issue first.`
      : 'Most likely path is circuit, connector, harness, or signal-path issue first.',
    final_recommendation: code
      ? `Walk the rapid-start tree for DTC ${code} and save the actual final repair once the unit is fixed.`
      : 'Walk the rapid-start tree and save the actual final repair once the unit is fixed.',
    source: 'fast-detailed-code-aware'
  };
}

// ROOT
app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
});

// VIN DECODE ROUTE
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
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// TEST DB
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

// SAVE / UPDATE REPAIR
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
            status: record.status || 'fixed',
            notes: record.notes || existing.notes
          })
          .eq('id', existing.id)
          .select();

        if (updateError) {
          return res.status(500).json({ success: false, error: updateError.message });
        }

        return res.json({ success: true, updated: true, data: updated });
      }
    }

    const { data, error } = await supabase
      .from('repair_cases')
      .insert([record])
      .select();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DIAGNOSE
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
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// RECORD STEP
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
