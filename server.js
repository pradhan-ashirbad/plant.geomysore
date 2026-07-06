require('dotenv').config();
const express = require('express');
const path = require('path');
const routes = require('./src/routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '5mb' }));
// no-cache on the app shell + JS/CSS: the browser keeps a copy but revalidates
// via ETag on every load (cheap 304 when unchanged), so a changed app.js/
// style.css is picked up immediately instead of being served stale from cache.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// API routes
app.use('/api', routes);

// SPA fallback
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  console.log(`Plant Monitoring System running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});

module.exports = app;
