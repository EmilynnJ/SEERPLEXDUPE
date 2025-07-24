import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

export const SocketProvider = ({ children }) => {
  const { user, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [onlineReaders, setOnlineReaders] = useState([]);
  const socketRef = useRef();

  useEffect(() => {
    if (isAuthenticated && user) {
      // Initialize socket connection
      const socketUrl = window.location.origin;
      const newSocket = io(socketUrl, {
        path: '/.netlify/functions/websocket',
        transports: ['websocket', 'polling'],
        auth: {
          userId: user.id,
          role: user.role
        }
      });

      socketRef.current = newSocket;
      setSocket(newSocket);

      // Connection events
      newSocket.on('connect', () => {
        console.log('Socket connected');
        setConnected(true);
        
        // Register user
        newSocket.emit('register-user', {
          userId: user.id,
          role: user.role
        });
      });

      newSocket.on('disconnect', () => {
        console.log('Socket disconnected');
        setConnected(false);
      });

      newSocket.on('registered', (data) => {
        console.log('User registered with socket:', data);
      });

      // Reader status updates
      newSocket.on('reader-status-update', (data) => {
        setOnlineReaders(prev => {
          if (data.isOnline) {
            return prev.includes(data.readerId) ? prev : [...prev, data.readerId];
          } else {
            return prev.filter(id => id !== data.readerId);
          }
        });
      });

      newSocket.on('error', (error) => {
        console.error('Socket error:', error);
      });

      return () => {
        newSocket.close();
        setSocket(null);
        setConnected(false);
      };
    }
  }, [isAuthenticated, user]);

  const value = {
    socket,
    connected,
    onlineReaders
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
