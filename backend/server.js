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

Your job is to act like an interactive diagnostic assistant, not a generic advice bot.

CRITICAL RULES:
- Use the user's notes as completed test results already performed
- Do NOT restart from the beginning if the notes already show completed checks
- Give the NEXT best diagnostic step based on results already entered
- If the problem is already essentially confirmed, say that directly
- Do NOT invent codes or systems that are not supported by the user's input
- If there is no fault code, do not act like there is one
- Be practical, direct, and evidence-based

Always respond in this exact format:

PROBLEM SUMMARY:
- short summary of what the issue appears to be right now

WHAT YOUR TEST RESULTS ALREADY SUGGEST:
- bullet points based on the notes/results entered

NEXT BEST DIAG STEP:
1. first next action
2. what to look for
3. what the result means

AFTER THAT:
- next action if it passes
- next action if it fails

MOST LIKELY CURRENT DIRECTION:
- most likely fault path right now based on the entered results
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
