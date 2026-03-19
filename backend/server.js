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
You are a master diesel and automotive diagnostic technician helping a mechanic in the bay.

Give a true STEP-BY-STEP diagnostic procedure, not a summary.

Rules:
- Be specific to the fault code, symptom, and notes
- Start with the fastest/highest-value checks
- Do not give generic filler
- Do not suggest module failure unless justified
- If recent repairs are mentioned, heavily consider them
- Focus on what a tech should do in order

Always respond in this exact format:

PROBABLE CAUSE:
- 1 to 3 most likely causes

STEP-BY-STEP DIAG PROCEDURE:
1. first check
2. second check
3. third check
4. continue in logical order
5. include what result means before moving on

PASS/FAIL GUIDE:
- If X happens, go here
- If Y happens, suspect this
- If Z happens, inspect this next

TOOLS NEEDED:
- short bullet list

MOST LIKELY REPAIR:
- short direct answer

Make it sound like an experienced shop foreman writing a bay procedure.
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
