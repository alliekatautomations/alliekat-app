const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/diagnose', (req, res) => {
    const {vin, code } = req.body;

    res.json){
        diagnosis: Allie Analysis:
Vehicle: ${vin}
code: ${code}

Likely Causes:
-Sensor Failure
-Wiring Failure
-Connector Problem

Next Step:
Check Power/ground and inspect harness.'
  });
});

app.get('/', (req, res) => {
  res.send("Allie-kat backend running");
});

const PORT = process.env.PORT | | 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
