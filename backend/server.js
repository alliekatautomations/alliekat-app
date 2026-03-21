const express = require('express')
const cors = require('cors')

const app = express()

app.use(cors())
app.use(express.json())

// TEST ROOT
app.get('/', (req, res) => {
  res.json({ message: 'Allie-kat backend running' })
})

// TEST ROUTE
app.get('/test', (req, res) => {
  res.json({ message: 'Test route working' })
})

const PORT = 3001

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
