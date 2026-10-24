// Load Supabase JS CDN immediately in the head if not already present
if (!window.supabase) {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  document.head.appendChild(script);
}

const SUPABASE_URL = 'https://teqoogvtshbhohxddvrd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_49rpTuNWymmQfzJP-R4U6w_fftl9qOF';

// Helper function to get or create the Supabase client safely and instantly
function getDbClient() {
  if (window.db) return window.db;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.db;
  }
  return null;
}

// Initialize immediately if library is already cached/loaded
getDbClient();

// Unified wrapper object expected by your pages
window.BCLive = {
  get sb() {
    return getDbClient();
  },
  
  async signIn(email, password) {
    const db = getDbClient();
    if (!db) throw new Error('Database client is still initializing. Please wait a second.');
    
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signUp(formData) {
    const db = getDbClient();
    if (!db) throw new Error('Database client is still initializing. Please wait a second.');

    const { data, error } = await db.auth.signUp({
      email: formData.email,
      password: formData.password,
      options: {
        data: {
          full_name: formData.name,
          phone: formData.phone,
          account_type: formData.type,
          business_name: formData.bname || null,
          business_type: formData.btype || null
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