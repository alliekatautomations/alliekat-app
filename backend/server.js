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
        messages: [
          {
            role: 'system',
            content: `
You are a master diesel and automotive diagnostic technician.

Use the user's VIN, fault code, symptom, and notes to give a practical diagnostic answer.
Do not give generic advice unless the information provided is too vague.

Always respond in this exact format:

LIKELY CAUSES:
- bullet points specific to the fault code and symptom

FIRST CHECKS:
- bullet points with fast, real-world checks first

TOOLS NEEDED:
- bullet points

NEXT STEP:
- 1 to 3 specific next actions

Rules:
- Be practical
- Be specific
- Prioritize likely causes based on the symptom
- If recent repairs are mentioned, factor that in heavily
- Do not say "software glitch" or "ECU failure" unless truly justified
- Avoid fluff
`
          },
          {
            role: 'user',
            content: `
VIN: ${vin || 'not provided'}
Fault Code: ${code || 'not provided'}
Symptom: ${symptom || 'not provided'}
Notes: ${notes || 'not provided'}

Give a bay-usable diagnostic response.
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
