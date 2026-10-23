// Load Supabase JS CDN dynamically if not already present
if (!window.supabase) {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  document.head.appendChild(script);
}

// Initialize Supabase Client once for all pages
window.addEventListener('DOMContentLoaded', () => {
  const SUPABASE_URL = 'https://teqoogvtshbhohxddvrd.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_49rpTuNWymmQfzJP-R4U6w_fftl9qOF';
  
  if (window.supabase) {
    window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('Supabase connected successfully to Business Catalog!');
  }
});