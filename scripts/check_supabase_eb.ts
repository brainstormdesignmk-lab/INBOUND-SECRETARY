import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
  const { data, error } = await sb.from('properties').select('eb, address, location, lat, lon, landmark, nearby_landmarks').in('eb', [76, 78, 79, 69]);
  if (error) { console.error(error); return; }
  console.log(JSON.stringify(data, null, 2));
}
main();
