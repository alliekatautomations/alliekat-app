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
- Give the NEXT correct branch in the tree based on the evidence already entered
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
