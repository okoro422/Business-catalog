// --- Supabase Client Helper ---
function getDb() {
  return (window.BCLive && window.BCLive.sb) || window.db || window.__bcSb;
}

// --- Sign Up Function ---
window.BCLive = window.BCLive || {};
window.BCLive.signUp = async function(formData) {
  const sb = getDb();
  if (!sb) throw new Error('Database connection unavailable.');

  const { data, error } = await sb.auth.signUp({
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
};

// --- Staff / User Login Function ---
async function loginStaff(email, password, redirectUrl = 'admin-dashboard.html') {
  const db = getDb();
  if (!db) {
    alert('Database client is still initializing. Please try again.');
    return;
  }

  const { data, error } = await db.auth.signInWithPassword({
    email: email.trim(),
    password: password.trim()
  });

  if (error) {
    alert('Login Failed: ' + error.message);
    return false;
  }

  console.log('Login successful:', data.user);
  localStorage.removeItem('bc_cart'); // Clear cart on new login session
  window.location.href = redirectUrl;
  return true;
}

// --- Logout Function ---
async function logoutUser(redirectUrl = 'staff-login.html') {
  const db = getDb();
  if (!db) return;
  localStorage.removeItem('bc_cart'); // Clear cart on logout
  await db.auth.signOut();
  window.location.href = redirectUrl;
}

// --- Auth Guard for Protected Admin Pages ---
async function checkAuthGuard() {
  setTimeout(async () => {
    const db = getDb();
    if (!db) return;
    const { data: { session }, error } = await db.auth.getSession();
    if (error || !session) {
      window.location.href = 'staff-login.html';
      return;
    }

    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .maybeSingle();
    if (profileError || !profile || !['staff', 'owner'].includes(profile.role)) {
      await db.auth.signOut();
      window.location.href = 'staff-login.html?denied=1';
    }
  }, 500);
}