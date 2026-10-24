import { Navigate, Route, Routes } from 'react-router';
import AdminDashboard from './AdminDashboard.jsx';
import { AdminAuditLog, AdminDocuments, AdminRequests, AdminStaff, AdminStructure, AdminStudents } from './AdminPages.jsx';

export default function AdminRoutes() {
  return (
    <Routes>
      <Route index element={<AdminDashboard />} />
      <Route path="requests" element={<AdminRequests />} />
      <Route path="students" element={<AdminStudents />} />
      <Route path="staff" element={<AdminStaff />} />
      <Route path="structure" element={<AdminStructure />} />
      <Route path="documents" element={<AdminDocuments />} />
      <Route path="audit-log" element={<AdminAuditLog />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
