import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { api, getToken, portalFor, setToken, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);
const PORTALS = ['student', 'staff'];

/** Where each kind of user lands after logging in. */
export function homeFor(user) {
  if (!user) return '/student/login';
  if (user.userType === 'student') return '/student';
  if (user.must_change_password) return '/staff/change-password';
  if (user.role === 'admin') return '/admin';
  return user.role === 'registry' ? '/staff/registry' : '/staff';
}

/**
 * Keeps one session per portal (student and staff) so both can be used side by
 * side in the same browser. useAuth() returns the session for the portal of the
 * page currently shown.
 */
export function AuthProvider({ children }) {
  const location = useLocation();
  const portal = portalFor(location.pathname);
  const [sessions, setSessions] = useState(() =>
    Object.fromEntries(PORTALS.map((p) => [p, { user: null, loading: Boolean(getToken(p)) }]))
  );

  const setSession = useCallback((p, patch) => setSessions((s) => ({ ...s, [p]: { ...s[p], ...patch } })), []);

  const logoutPortal = useCallback(
    (p) => {
      setToken(p, null);
      setSession(p, { user: null, loading: false });
    },
    [setSession]
  );

  useEffect(() => {
    setUnauthorizedHandler(logoutPortal);
    for (const p of PORTALS) {
      if (!getToken(p)) continue;
      api
        .get('/me', { portal: p })
        .then((d) => setSession(p, { user: d.user, loading: false }))
        .catch(() => logoutPortal(p));
    }
  }, [logoutPortal, setSession]);

  const signIn = useCallback(
    ({ token, user }) => {
      const p = user.userType === 'staff' ? 'staff' : 'student';
      setToken(p, token);
      setSession(p, { user, loading: false });
      return user;
    },
    [setSession]
  );

  const current = sessions[portal];
  const value = useMemo(
    () => ({
      user: current.user,
      loading: current.loading,
      portal,
      signIn,
      logout: () => logoutPortal(portal),
      setUser: (u) => setSession(portal, { user: u }),
    }),
    [current, portal, signIn, logoutPortal, setSession]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
