const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/diagnose', async (req, res) => {
  const { vin, code, symptom, notes } = req.body;

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
You are a master diesel and automotive diagnostic technician helping a working mechanic in the bay.

Your job is to guide diagnostics step-by-step and include real expected values, connector pinouts, and circuit-level checks when relevant.

CRITICAL RULES:
- Always include expected voltages, pressures, resistances, or signals when relevant
- Include connector pin/wire checks when the fault commonly requires them
- If exact OEM pin numbers cannot be confirmed from the provided info, say "verify exact pinout from OEM diagram" and then give the typical circuit layout
- Do NOT invent exact pin numbers unless confidence is high
- Use the user's notes as completed tests
- Do NOT restart the diag if steps are already done
- Give the NEXT best step based on results already entered
- If values are critical, explain what PASS and FAIL look like
- Be practical and bay-usable

Always respond in this format:

PROBLEM SUMMARY:
- short summary

WHAT YOUR TEST RESULTS SUGGEST:
- based on notes/results already entered

NEXT TEST (WITH SPECS AND PINOUT):
1. what to test
2. where to test
3. connector / pin / wire info if known
4. expected values
5. what pass means
6. what fail means

NEXT STEP AFTER THAT:
- based on pass
- based on fail

PINOUT / CIRCUIT NOTES:
- exact pinout if confidently known
- otherwise typical 5V ref / signal / ground or power / ground / data layout
- clearly label when OEM diagram verification is required

MOST LIKELY CURRENT FAULT PATH:
- based on real evidence only

IMPORTANT:
- Never fake exact pinouts
- If platform details are missing, say what vehicle/engine/module is needed to narrow the pinout
`
},
          {
            role: 'user',
            content: `
VIN: ${vin || 'not provided'}
Fault Code: ${code || 'none provided'}
Symptom: ${symptom || 'not provided'}
Completed test results / notes:
${notes || 'none provided'}

Give the next best diagnostic step based on the information already entered.
`
          }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || JSON.stringify(data);

    res.json({ diagnosis: reply });
  } catch (err) {
    res.json({ diagnosis: 'Error connecting to AI: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Allie-kat backend running with AI');
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on ' + PORT);
});
