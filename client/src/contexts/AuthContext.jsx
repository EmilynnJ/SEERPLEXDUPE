import React, { createContext, useContext, useEffect, useState } from 'react';
import { useUser, useAuth as useClerkAuth } from '@clerk/clerk-react';
import { authAPI } from '../utils/api';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  const { signOut } = useClerkAuth();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    if (isLoaded) {
      if (isSignedIn && clerkUser) {
        // Set user data from Clerk
        const userData = {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          name: clerkUser.firstName + ' ' + clerkUser.lastName,
          avatar: clerkUser.imageUrl,
          role: clerkUser.publicMetadata?.role || 'CLIENT',
          isVerified: clerkUser.publicMetadata?.isVerified || false,
          balance: clerkUser.publicMetadata?.balance || 0,
          isOnline: clerkUser.publicMetadata?.isOnline || false
        };
        setUser(userData);
        setBalance(userData.balance);
      } else {
        setUser(null);
        setBalance(0);
      }
      setLoading(false);
    }
  }, [isLoaded, isSignedIn, clerkUser]);

  const logout = async () => {
    try {
      await signOut();
      setUser(null);
      setBalance(0);
      localStorage.removeItem('token');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const updateBalance = (newBalance) => {
    setBalance(newBalance);
    if (user) {
      setUser(prev => ({ ...prev, balance: newBalance }));
    }
  };

  const updateUserData = (updates) => {
    if (user) {
      setUser(prev => ({ ...prev, ...updates }));
    }
  };

  const value = {
    user,
    loading,
    balance,
    isAuthenticated: !!user,
    logout,
    updateBalance,
    updateUserData
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
