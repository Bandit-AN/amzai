import { config, jsonResponse } from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  return jsonResponse(response, 200, {
    supabase: config.supabaseUrl && config.supabaseAnonKey
      ? { url: config.supabaseUrl, anonKey: config.supabaseAnonKey }
      : null,
  });
}
