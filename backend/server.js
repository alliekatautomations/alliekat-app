const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function safeString(value) {
  return String(value || '').trim();
}

app.get('/', (req, res) => {
  res.send('Allie-kat backend live');
});

app.post('/decode-vin', async (req, res) => {
  try {
    const vin = safeString(req.body.vin);

    const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
    const data = await response.json();

    const vehicle = data?.Results?.[0] || {};

    res.json({
      success: true,
      vehicle: {
        vin,
        year: vehicle.ModelYear || '',
        make: vehicle.Make || '',
        model: vehicle.Model || '',
        engine: vehicle.EngineModel || vehicle.DisplacementL || ''
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/diagnose-detailed', async (req, res) => {
  res.json({
    success: true,
    tree: {
      issue_summary: "Test Tree",
      current_position: "Step 1",
      current_step_id: "step_1",
      steps: [
        {
          id: "step_1",
          title: "Check Power",
          instruction: "Verify power at component",
          where_to_test: "Connector",
          expected_specs: {
            voltage: "12V",
            ohms: "0",
            pressure: "",
            signal: "",
            voltage_drop: "<0.5V"
          },
          how_to_test: "Use DVOM",
          result_buttons: [
            { label: "PASS", next_step_id: "" },
            { label: "FAIL", next_step_id: "" }
          ]
        }
      ],
      likely_fault_path: "Power issue",
      final_recommendation: "Repair wiring"
    },
    vehicle: {}
  });
});

app.post('/diagnose-expert', async (req, res) => {
  res.json({
    success: true,
    tree: {
      issue_summary: "Expert Test Tree",
      current_position: "Step 1",
      current_step_id: "step_1",
      steps: [
        {
          id: "step_1",
          title: "Check Signal",
          instruction: "Verify signal integrity",
          where_to_test: "Sensor",
          expected_specs: {
            voltage: "5V",
            ohms: "",
            pressure: "",
            signal: "Square wave",
            voltage_drop: ""
          },
          how_to_test: "Scope test",
          result_buttons: [
            { label: "PASS", next_step_id: "" },
            { label: "FAIL", next_step_id: "" }
          ]
        }
      ],
      likely_fault_path: "Signal issue",
      final_recommendation: "Replace sensor"
    },
    vehicle: {}
  });
});

app.post('/chat', async (req, res) => {
  res.json({
    success: true,
    reply: "Chat is working"
  });
});

app.post('/save-repair', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('repair_cases')
      .insert([req.body])
      .select();

    if (error) return res.json({ success: false, error: error.message });

    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/record-step-result', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('repair_cases')
      .insert([req.body])
      .select();

    if (error) return res.json({ success: false, error: error.message });

    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/signup', async (req, res) => {
  try {
    const email = safeString(req.body.email).toLowerCase();
    const password = String(req.body.password || '');
    const name = safeString(req.body.name);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name }
      }
    });

    if (error) {
      return res.json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      user: data.user
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ✅ FIXED LOGIN */
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
        error: 'Login failed - no session returned',
        user: data?.user || null,
        session: data?.session || null
      });
    }

    res.json({
      success: true,
      user: data.user,
      session: data.session
    });

  } catch (err) {
    res.json({
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
