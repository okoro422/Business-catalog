// --- Staff Login Function ---
async function loginStaff(email, password, redirectUrl = 'admin-dashboard.html') {
  if (!window.db) {
    alert('Database client is still initializing. Please try again.');
    return;
  }

  const { data, error } = await window.db.auth.signInWithPassword({
    email: email.trim(),
    password: password.trim()
  });

  if (error) {
    alert('Login Failed: ' + error.message);
    return false;
  }

  console.log('Login successful:', data.user);
  window.location.href = redirectUrl;
  return true;
}

// --- Logout Function ---
async function logoutUser(redirectUrl = 'staff-login.html') {
  if (!window.db) return;
  await window.db.auth.signOut();
  window.location.href = redirectUrl;
}

// --- Auth Guard for Protected Admin Pages ---
async function checkAuthGuard() {
  // Give supabase-client a brief moment to initialize window.db if needed
  setTimeout(async () => {
    if (!window.db) return;
    const { data: { session } } = await window.db.auth.getSession();
    
    // If no active session exists, kick user back to staff login page
    if (!session) {
      window.location.href = 'staff-login.html';
    }
  }, 500);
}