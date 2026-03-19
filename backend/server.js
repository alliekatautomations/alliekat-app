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

Your job is to guide diagnostics step-by-step AND include real expected values.

CRITICAL RULES:
- Always include expected voltages, pressures, or signals when relevant
- Be specific (ex: 5V reference, 0.5–4.5V signal sweep, 12V supply, etc.)
- Do NOT give generic advice without measurable values
- Use the user's notes as completed tests
- Do NOT restart the diag if steps are already done
- Give the NEXT best step based on results
- If values are critical, explain what PASS and FAIL look like

Always respond in this format:

PROBLEM SUMMARY:
- short summary

WHAT YOUR TEST RESULTS SUGGEST:
- based on notes

NEXT TEST (WITH SPECS):
1. what to test
2. where to test
3. expected values (VERY IMPORTANT)
4. what pass means
5. what fail means

NEXT STEP AFTER THAT:
- based on pass
- based on fail

MOST LIKELY CURRENT FAULT PATH:
- based on real evidence
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
