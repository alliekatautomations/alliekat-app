const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/diagnose', async (req, res) => {
    const { vin, code } = req.body;

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

Always respond in this exact format:

LIKELY CAUSES:
- bullet points

FIRST CHECKS:
- bullet points (quick visual/easy checks first)

TOOLS NEEDED:
- bullet points

NEXT STEP:
- 1–2 clear next actions

Keep answers practical, no fluff, no explanations unless necessary.
`
},
                    {
                        role: 'user',
                        content: `VIN: ${vin}\nFault Code: ${code}\nGive likely causes, first checks, and next steps.`
                    }
                ]
            })
        });

        const data = await response.json();

        const reply = data.choices?.[0]?.message?.content || JSON.stringify(data);

        res.json({ diagnosis: reply });

    } catch (err) {
        res.json({ diagnosis: "Error connecting to AI" });
    }
});

app.get('/', (req, res) => {
    res.send("Allie-kat backend running with AI");
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
    console.log("Server running on " + PORT);
});
