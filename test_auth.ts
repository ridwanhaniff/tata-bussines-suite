import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  try {
    const connUrl = process.env.DATABASE_URL;
    if (!connUrl) throw new Error("No DATABASE_URL");
    const pool = new Pool({ connectionString: connUrl, ssl: { rejectUnauthorized: false } });
    
    console.log("Connecting to DB...");
    const { rows } = await pool.query('SELECT email, password_hash, role FROM admins');
    console.log("Admins:", rows);
    
    // Check if session table exists
    const sessionTable = await pool.query(`SELECT to_regclass('public.user_sessions') as table_name`);
    console.log("Session table exists:", sessionTable.rows[0].table_name);
    
    process.exit(0);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

test();
