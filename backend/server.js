const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ===== SUPABASE CONNECTION =====
const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ===== VIN DECODE =====
async function decodeVIN(vin) {
  try {
    const cleanVin = String(vin || '').trim();
    if (cleanVin.length < 11) return null;

    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${cleanVin}?format=json`);
    const data = await res.json();

    if (!data || !data.Results || !data.Results[0]) {
      return null;
    }

    return data.Results[0];
  } catch (e) {
    return null;
  }
}

// ===== AI DIAGNOSIS =====
app.post('/diagnose', async (req, res) => {
  const { vin, code, symptom, notes } = req.body;

  let vehicleInfo = null;

  if (vin && String(vin).trim().length >= 11) {
    vehicleInfo = await decodeVIN(vin);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are a master diagnostic technician. Respond in a structured troubleshooting tree with specs and clear next steps.'
          },
          {
            role: 'user',
            content: `
VIN: ${vin || 'not provided'}
Make: ${vehicleInfo?.Make || 'unknown'}
Model: ${vehicleInfo?.Model || 'unknown'}
Year: ${vehicleInfo?.ModelYear || 'unknown'}

Code: ${code || 'none'}
Symptom: ${symptom || 'none'}

Notes:
${notes || 'none'}
`
          }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'No response';

    res.json({
      diagnosis: reply,
      vehicle: vehicleInfo || {}
    });

  } catch (err) {
    res.json({
      diagnosis: 'AI error: ' + err.message,
      vehicle: vehicleInfo || {}
    });
  }
});

// ===== SAVE REPAIR CASE =====
app.post('/save-repair', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('repair_cases')
      .insert([req.body])
      .select();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== TEST DB =====
app.get('/test-db', async (req, res) => {
  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .limit(5);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// ===== ROOT =====
app.get('/', (req, res) => {
  res.send('Allie-kat backend live with DB');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
