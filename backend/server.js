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
You are a master diesel and heavy truck diagnostic technician.

CRITICAL RULE:
You MUST correctly interpret the fault code system before diagnosing.

- If code is numeric (ex: 689, 1117, 1682), assume heavy-duty (Cummins, Detroit, Paccar, etc.)
- If code starts with P0/P1, treat as OBD automotive
- If unsure, say so and guide the tech to identify system

DO NOT guess the system.

Your job:
Give a real, code-accurate, step-by-step diagnostic procedure.

If the code is known (ex: Cummins 689), base the procedure on that system.
If the code is unclear, say:
"Need engine/platform (Cummins/Detroit/Paccar) to be precise"

Always prioritize:
- code meaning
- symptom
- recent repairs

FORMAT:

CODE INTERPRETATION:
- what system this code likely belongs to
- what the code actually represents

FAULT FOCUS:
- what circuit/system is involved

STEP-BY-STEP DIAG PROCEDURE:
1. first correct check for that system
2. what to look for
3. what result means
4. next step based on pass/fail

PASS / FAIL DECISIONS:
- If ___ → go to ___
- If ___ → suspect ___

TOOLS NEEDED:
- bullet list

MOST LIKELY ROOT CAUSE:
- only if evidence supports it
- otherwise say what must be confirmed next

RULES:
- no guessing wrong system
- no generic automotive answers for heavy truck codes
- no throttle guesses unless code supports it
- be direct and shop-usable
`
},
          {
            role: 'user',
            content: `
VIN: ${vin || 'not provided'}
Fault Code: ${code || 'not provided'}
Symptom: ${symptom || 'not provided'}
Notes: ${notes || 'not provided'}

Give a real step-by-step diagnostic procedure.
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
