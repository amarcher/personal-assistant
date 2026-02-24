import 'dotenv/config';
import { startServer } from './server.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set in .env');
  process.exit(1);
}

const port = parseInt(process.env.PORT || '3000', 10);
startServer(port);
