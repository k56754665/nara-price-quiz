import { startLocalServer } from './scripts/local-server.mjs';
startLocalServer(process.argv.includes('--curate'));
