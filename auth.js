const config = window.MN_SUPABASE_CONFIG || {};
const requiredRole = document.body.dataset.requiredRole;
const isAuthPage = document.body.dataset.authPage === 'true';
const ready = Boolean(config.url && config.publishableKey);
const $ = (s) => document.querySelector(s);

if (isAuthPage) initAuthPage();
else initProtectedPage();

async function makeClient() {
  if (!ready) return null;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
}

async function initProtectedPage() {
  const account = $('#accountLink');
  if (account && !ready) { account.textContent = 'Sign in setup'; account.href = 'auth.html'; }
  if (!ready) return; // Keep the public demo available until its Supabase project is connected.
  const client = await makeClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) { location.replace(`auth.html?next=${encodeURIComponent(requiredRole === 'staff' ? 'index.html' : 'citizen.html')}`); return; }
  const role = session.user.app_metadata?.role;
  if (role !== requiredRole) { await client.auth.signOut(); location.replace('auth.html?error=role'); return; }
  if (account) { account.textContent = `${session.user.email} · Sign out`; account.href = '#signout'; account.addEventListener('click', async (event) => { event.preventDefault(); await client.auth.signOut(); location.replace('auth.html'); }); }
}

async function initAuthPage() {
  const status = $('#authStatus');
  if (!ready) { status.textContent = 'Supabase is not connected yet. Add your Project URL and publishable key in supabase-config.js to enable secure accounts. The preview portals remain available for now.'; return; }
  const client = await makeClient();
  const params = new URLSearchParams(location.search);
  const next = params.get('next') === 'index.html' ? 'index.html' : 'citizen.html';
  if (params.get('error') === 'role') status.textContent = 'That account is not authorized for the requested workspace. Sign in with the correct account.';
  $('#signInForm').addEventListener('submit', async (event) => {
    event.preventDefault(); status.textContent = 'Signing in…';
    const { data, error } = await client.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    if (error) { status.textContent = error.message; return; }
    const role = data.user.app_metadata?.role;
    if (role !== (next === 'index.html' ? 'staff' : 'citizen')) { await client.auth.signOut(); status.textContent = 'This account does not have access to that portal.'; return; }
    location.replace(next);
  });
  $('#signUpForm').addEventListener('submit', async (event) => {
    event.preventDefault(); status.textContent = 'Creating citizen account…';
    const { data, error } = await client.auth.signUp({ email: $('#newEmail').value.trim(), password: $('#newPassword').value });
    if (error) { status.textContent = error.message; return; }
    status.textContent = data.session ? 'Account created. You can sign in to the citizen portal.' : 'Check your email to confirm the citizen account, then sign in.';
  });
}
