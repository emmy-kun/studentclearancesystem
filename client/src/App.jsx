import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth, homeFor } from './auth/AuthContext.jsx';
import { PageLoading } from './components/ui.jsx';
import StudentLogin from './pages/student/StudentLogin.jsx';
import StudentSignup from './pages/student/StudentSignup.jsx';
import Dashboard from './pages/student/Dashboard.jsx';
import StagePage from './pages/student/StagePage.jsx';
import StudentNotifications, { NotificationList } from './pages/student/Notifications.jsx';
import PaymentCallback from './pages/student/PaymentCallback.jsx';
import StaffLogin from './pages/staff/StaffLogin.jsx';
import ChangePassword from './pages/staff/ChangePassword.jsx';
import StaffShell from './pages/staff/StaffShell.jsx';
import Queue, { History } from './pages/staff/Queue.jsx';
import Review from './pages/staff/Review.jsx';
import RegistryCheck, { RegistryCollected } from './pages/staff/Registry.jsx';
import Verify from './pages/Verify.jsx';
import { ForgotPassword, ResetPassword } from './pages/PasswordReset.jsx';
import AdminRoutes from './pages/admin/AdminRoutes.jsx';

// The role only chooses which screens to show; the server enforces access on every request.
function RequireUser({ type, roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoading />;
  if (!user) return <Navigate to={type === 'staff' ? '/staff/login' : '/student/login'} replace state={{ from: location.pathname }} />;
  if (user.userType !== type) return <Navigate to={homeFor(user)} replace />;
  if (type === 'staff' && user.must_change_password && location.pathname !== '/staff/change-password') {
    return <Navigate to="/staff/change-password" replace />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return children;
}

function GuestOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoading />;
  return user ? <Navigate to={homeFor(user)} replace /> : children;
}

function StaffNotifications() {
  return (
    <>
      <h1>Notifications</h1>
      <div style={{ maxWidth: 720 }}>
        <NotificationList />
      </div>
    </>
  );
}

/** /staff: the review queue, or the certificate check for the Registry (which reviews no stages). */
function StaffHome() {
  const { user } = useAuth();
  return user.role === 'registry' ? <Navigate to="/staff/registry" replace /> : <Queue />;
}

export default function App() {
  return (
    <Routes>
      {/* public */}
      <Route path="/verify" element={<Verify />} />
      <Route path="/verify/:code" element={<Verify />} />
      <Route path="/student/login" element={<GuestOnly><StudentLogin /></GuestOnly>} />
      <Route path="/student/signup" element={<GuestOnly><StudentSignup /></GuestOnly>} />
      <Route path="/staff/login" element={<GuestOnly><StaffLogin /></GuestOnly>} />
      <Route path="/student/forgot-password" element={<GuestOnly><ForgotPassword portal="student" /></GuestOnly>} />
      <Route path="/staff/forgot-password" element={<GuestOnly><ForgotPassword portal="staff" /></GuestOnly>} />
      {/* reset links open even when signed in (e.g. a staff member resetting in another tab) */}
      <Route path="/student/reset-password" element={<ResetPassword portal="student" />} />
      <Route path="/staff/reset-password" element={<ResetPassword portal="staff" />} />

      {/* students (their own session, separate from staff) */}
      <Route path="/student" element={<RequireUser type="student"><Dashboard /></RequireUser>} />
      <Route path="/student/stage/:stageId" element={<RequireUser type="student"><StagePage /></RequireUser>} />
      <Route path="/student/notifications" element={<RequireUser type="student"><StudentNotifications /></RequireUser>} />
      <Route path="/payments/callback" element={<RequireUser type="student"><PaymentCallback /></RequireUser>} />

      {/* staff */}
      <Route path="/staff/change-password" element={<RequireUser type="staff"><ChangePassword /></RequireUser>} />
      <Route path="/staff/password" element={<RequireUser type="staff"><ChangePassword /></RequireUser>} />
      <Route element={<RequireUser type="staff"><StaffShell /></RequireUser>}>
        <Route path="/staff" element={<StaffHome />} />
        <Route path="/staff/registry" element={<RequireUser type="staff" roles={['registry', 'admin']}><RegistryCheck /></RequireUser>} />
        <Route path="/staff/registry/collected" element={<RequireUser type="staff" roles={['registry', 'admin']}><RegistryCollected /></RequireUser>} />
        <Route path="/staff/history" element={<History />} />
        <Route path="/staff/review/:stageId" element={<Review />} />
        <Route path="/staff/notifications" element={<StaffNotifications />} />
        <Route path="/admin/*" element={<RequireUser type="staff" roles={['admin']}><AdminRoutes /></RequireUser>} />
      </Route>

      {/* old addresses */}
      <Route path="/" element={<Navigate to="/student" replace />} />
      <Route path="/login" element={<Navigate to="/student/login" replace />} />
      <Route path="/signup" element={<Navigate to="/student/signup" replace />} />
      <Route path="*" element={<Navigate to="/student" replace />} />
    </Routes>
  );
}
