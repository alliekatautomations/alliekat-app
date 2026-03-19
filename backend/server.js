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

Your job is to produce an evidence-based, step-by-step diagnostic procedure.
Do NOT guess.
Do NOT invent parts or failure modes unless the fault code, symptom, and notes support them.
Do NOT default to ignition switch, ECM, software, or module failure unless there is strong evidence.
When information is missing, say what must be verified next instead of guessing.

Think like an experienced foreman:
- start with the failure pattern
- use the code and symptom together
- heavily weigh recent repairs
- give the fastest path to isolate the fault

Always respond in this exact format:

FAULT FOCUS:
- what system or circuit this code/symptom most likely points to
- what detail is still missing, if any

STEP-BY-STEP DIAG PROCEDURE:
1. first physical or scan-tool check
2. what reading/condition to look for
3. what that result means
4. next check based on pass/fail
5. continue until the likely root cause is isolated

PASS / FAIL DECISIONS:
- If ___, go to ___
- If ___, suspect ___
- If ___, inspect/test ___ next

TOOLS NEEDED:
- short bullet list only

MOST LIKELY ROOT CAUSE RIGHT NOW:
- only name this if the evidence supports it
- if not enough evidence, say "Not enough evidence yet — verify step X first"

Rules:
- no filler
- no generic advice
- no "clear code and retest" unless that is truly the correct next move
- no broad guesses
- give a procedure a real technician can follow
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
