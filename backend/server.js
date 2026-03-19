const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/diagnose', (req, res) => {
    const { vin, code } = req.body;

    res.json({
        diagnosis: `Allie Analysis:
Vehicle: ${vin}
Code: ${code}

Likely Causes:
- Sensor failure
- Wiring issue
- Connector problem

Next Step:
Check power/ground and inspect harness.`
    });
});

app.get('/', (req, res) => {
    res.send("Allie-kat backend running");
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Server running on " + PORT);
});
