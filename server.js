// BON V2 — Node.js / Express Backend
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// TODO: Tilføj routes her

app.listen(PORT, () => {
  console.log(`Bon v2 kører på http://localhost:${PORT}`);
});
