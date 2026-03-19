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
                        content: 'You are a professional diesel and automotive diagnostic technician. Give clear, practical troubleshooting steps.'
                    },
                    {
                        role: 'user',
                        content: `VIN: ${vin}\nFault Code: ${code}\nGive likely causes, first checks, and next steps.`
                    }
                ]
            })
        });

        const data = await response.json();

        const reply = data.choices?.[0]?.message?.content || "No response";

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
