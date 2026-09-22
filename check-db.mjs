import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL);
try {
  const r = await sql`SELECT COUNT(*) as count FROM documents`;
  console.log('Documents in DB:', r[0].count);
} catch(e) {
  console.log('DB ERROR:', e.message);
}
