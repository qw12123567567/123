import { access } from 'node:fs/promises';
for (const file of ['index.html','app.js','operations.js','styles.css']) await access(new URL(`../public/${file}`,import.meta.url));
console.log('Frontend assets and Vercel function are ready.');
