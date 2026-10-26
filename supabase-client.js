// Grab config from window.BC_CONFIG (injected by Netlify) or fallback
const SUPABASE_URL = (window.BC_CONFIG && window.BC_CONFIG.SUPABASE_URL) || 'https://teqoogvtshbhohxddvrd.supabase.co';
const SUPABASE_ANON_KEY = (window.BC_CONFIG && window.BC_CONFIG.SUPABASE_ANON_KEY) || 'sb_publishable_49rpTuNWymmQfzJP-R4U6w_fftl9qOF';

// Helper function to get or create the Supabase client safely
function getDbClient() {
  if (window.db) return window.db;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.db;
  }
  return null;
}

// Unified wrapper object expected by your pages
window.BCLive = {
  get sb() {
    return getDbClient();
  },
  
  async signIn(email, password) {
    let db = getDbClient();
    // Wait up to 2 seconds if the CDN is still downloading
    if (!db) {
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        db = getDbClient();
        if (db) break;
      }
    }
    if (!db) throw new Error('Database client failed to load. Please check your internet connection or CDN block.');
    
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signUp(formData) {
    let db = getDbClient();
    if (!db) {
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        db = getDbClient();
        if (db) break;
      }
    }
    if (!db) throw new Error('Database client failed to load. Please check your internet connection.');

    const { data, error } = await db.auth.signUp({
      email: formData.email,
      password: formData.password,
      options: {
        data: {
          full_name: formData.name,
          phone: formData.phone,
          account_type: formData.type,
          business_name: formData.bname || null,
          business_type: formsData.btype || null
        }
      }
    });

    if (error) throw error;
    return { user: data.user, needsConfirm: !data.session };
  },

  async signOut() {
    const db = getDbClient();
    if (db) await db.auth.signOut();
  }
};