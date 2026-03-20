const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ===== SUPABASE =====
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

    return data?.Results?.[0] || null;
  } catch {
    return null;
  }
}

// ===== DIAGNOSE =====
app.post('/diagnose', async (req, res) => {
  const { vin, code, symptom, notes } = req.body;

  let vehicleInfo = null;
  if (vin && vin.length >= 11) {
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
            content: `
You are a master diesel and automotive diagnostic technician.

Your job is to respond like a Cummins-style troubleshooting tree, not like a general AI assistant.

CRITICAL BEHAVIOR:
- Build the diagnostic response as a decision tree
- Every step must branch with YES / NO or PASS / FAIL logic
- Every test step must include measurable specs when relevant:
  - voltage
  - resistance / ohms
  - continuity
  - pressure
  - signal behavior
  - voltage drop
- Use the user's notes as tests already completed
- Do NOT restart from the beginning if prior checks are already in the notes
- Give the NEXT correct branch in the tree based on the information already entered
- If exact OEM specs or pinouts are not confirmed, clearly say:
  "Verify exact OEM spec/pinout for this platform"
  then provide only typical values labeled TYPICAL
- Never invent exact pin numbers or specs if confidence is low

ALWAYS RESPOND IN THIS EXACT FORMAT:

TROUBLE TREE START:
- short issue summary

CURRENT POSITION IN TREE:
- what the existing notes/results already confirm
- what branch the tech is currently on

NEXT STEP:
1. what to test
2. where to test
3. expected specs
   - voltage:
   - ohms:
   - pressure:
   - signal:
   - voltage drop:
4. how to perform the test

BRANCH DECISION:
- IF PASS / YES: go to ___
- IF FAIL / NO: go to ___

NEXT BRANCH IF PASS:
- specific next test or conclusion

NEXT BRANCH IF FAIL:
- specific next test or likely fault path

PINOUT / CIRCUIT DETAILS:
- exact if confidently known
- otherwise say OEM diagram required and give typical circuit layout only

MOST LIKELY FAULT PATH RIGHT NOW:
- evidence-based only

IMPORTANT:
- Output should read like a service troubleshooting tree
- No fluff
- No generic summary language
- No broad guesses
`
          },
          {
            role: 'user',
            content: `
VIN: ${vin || 'N/A'}

DECODED VEHICLE:
Make: ${vehicleInfo?.Make || 'unknown'}
Model: ${vehicleInfo?.Model || 'unknown'}
Year: ${vehicleInfo?.ModelYear || 'unknown'}
Engine: ${vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL || 'unknown'}
Trim: ${vehicleInfo?.Trim || 'unknown'}
Drive Type: ${vehicleInfo?.DriveType || 'unknown'}
Fuel Type: ${vehicleInfo?.FuelTypePrimary || 'unknown'}

Fault Code: ${code || 'none'}
Symptom: ${symptom || 'none'}

Completed test results / notes:
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
      vehicle: {
        vin: vin || '',
        year: vehicleInfo?.ModelYear || '',
        make: vehicleInfo?.Make || '',
        model: vehicleInfo?.Model || '',
        engine: vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL || '',
        trim: vehicleInfo?.Trim || '',
        driveType: vehicleInfo?.DriveType || '',
        fuelType: vehicleInfo?.FuelTypePrimary || ''
      }
    });
  } catch (err) {
    res.json({
      diagnosis: 'AI error: ' + err.message,
      vehicle: {
        vin: vin || '',
        year: vehicleInfo?.ModelYear || '',
        make: vehicleInfo?.Make || '',
        model: vehicleInfo?.Model || '',
        engine: vehicleInfo?.EngineModel || vehicleInfo?.DisplacementL || '',
        trim: vehicleInfo?.Trim || '',
        driveType: vehicleInfo?.DriveType || '',
        fuelType: vehicleInfo?.FuelTypePrimary || ''
      }
    });
  }
});

// ===== SAVE =====
app.post('/save-repair', async (req, res) => {
  const { data, error } = await supabase
    .from('repair_cases')
    .insert([req.body])
    .select();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// ===== SEARCH BY CODE =====
app.get('/search-by-code/:code', async (req, res) => {
  const code = req.params.code;

  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .ilike('fault_code', `%${code}%`)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// ===== SEARCH BY VIN =====
app.get('/search-by-vin/:vin', async (req, res) => {
  const vin = req.params.vin;

  const { data, error } = await supabase
    .from('repair_cases')
    .select('*')
    .ilike('vin', `%${vin}%`)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
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
  res.send('Allie-kat backend live');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
