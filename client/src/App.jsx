import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { AuthProvider } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import Header from './components/Header';
import Footer from './components/Footer';
import LoadingSpinner from './components/LoadingSpinner';

// Pages
import Home from './pages/Home';
import About from './pages/About';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ReadingRoom from './pages/ReadingRoom';
import ReadersPage from './pages/ReadersPage';
import Booking from './pages/Booking';
import LiveStream from './pages/LiveStream';
import Shop from './pages/Shop';
import Community from './pages/Community';
import Messages from './pages/Messages';
import Profile from './pages/Profile';
import HelpCenter from './pages/HelpCenter';
import Policies from './pages/Policies';
import Unauthorized from './pages/Unauthorized';

// Dashboard pages
import AdminDashboard from './pages/dashboard/admin';
import ReaderDashboard from './pages/dashboard/reader';
import ClientDashboard from './pages/dashboard/client';

// Component to handle role-based redirects after login
const RoleBasedRedirect = () => {
  const { user, isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return <LoadingSpinner />;
  }

  if (!isSignedIn || !user) {
    return <Navigate to="/login" replace />;
  }

  const role = user.publicMetadata?.role || 'CLIENT';

  switch (role) {
    case 'ADMIN':
      return <Navigate to="/dashboard/admin" replace />;
    case 'READER':
      return <Navigate to="/dashboard/reader" replace />;
    case 'CLIENT':
    default:
      return <Navigate to="/dashboard/client" replace />;
  }
};

function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <Router>
          <div className="min-h-screen flex flex-col bg-cosmic">
            <Header />
            <main className="flex-1">
              <Routes>
                {/* Public routes */}
                <Route path="/" element={<Home />} />
                <Route path="/about" element={<About />} />
                <Route path="/login" element={<Login />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/readers" element={<ReadersPage />} />
                <Route path="/livestream" element={<LiveStream />} />
                <Route path="/live/:streamId?" element={<LiveStream />} />
                <Route path="/shop" element={<Shop />} />
                <Route path="/community" element={<Community />} />
                <Route path="/help" element={<HelpCenter />} />
                <Route path="/policies" element={<Policies />} />
                <Route path="/unauthorized" element={<Unauthorized />} />

                {/* Role-based redirect after login */}
                <Route path="/dashboard" element={<RoleBasedRedirect />} />

                {/* Protected routes - authenticated users only */}
                <Route
                  path="/reading/:sessionId"
                  element={
                    <ProtectedRoute allowedRoles={['ADMIN', 'READER', 'CLIENT']}>
                      <ReadingRoom />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/booking/:readerId"
                  element={
                    <ProtectedRoute allowedRoles={['CLIENT']}>
                      <Booking />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/messages"
                  element={
                    <ProtectedRoute allowedRoles={['ADMIN', 'READER', 'CLIENT']}>
                      <Messages />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/profile"
                  element={
                    <ProtectedRoute allowedRoles={['ADMIN', 'READER', 'CLIENT']}>
                      <Profile />
                    </ProtectedRoute>
                  }
                />

                {/* Role-specific dashboard routes */}
                <Route
                  path="/dashboard/admin"
                  element={
                    <ProtectedRoute allowedRoles={['ADMIN']}>
                      <AdminDashboard />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/dashboard/reader"
                  element={
                    <ProtectedRoute allowedRoles={['READER']}>
                      <ReaderDashboard />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/dashboard/client"
                  element={
                    <ProtectedRoute allowedRoles={['CLIENT']}>
                      <ClientDashboard />
                    </ProtectedRoute>
                  }
                />

                {/* Catch all route */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
            <Footer />
          </div>
        </Router>
      </SocketProvider>
    </AuthProvider>
  );
}

export default App;