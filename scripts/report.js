import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { aggregateReport, DAY, reportingDay } from '../src/analytics.js';

let db;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--date')) throw new Error('Usage: npm run report -- --date YYYY-MM-DD');
  const day = args[1] || reportingDay(Date.now() - DAY).day;
  db = new DatabaseSync(resolve(process.env.DATABASE_PATH || './data/bot.sqlite'), { readOnly: true });
  console.log(JSON.stringify(aggregateReport(db, day), null, 2));
} catch {
  console.error('Report unavailable. Use a valid completed date and a database initialized by the updated bot.');
  process.exitCode = 1;
} finally { db?.close(); }
