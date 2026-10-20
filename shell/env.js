// Loads the repo-root .env once (keys live there, never in code). Real env vars win over the file.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) process.loadEnvFile(file);
