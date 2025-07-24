import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { 
  BellIcon, 
  XMarkIcon, 
  CheckIcon, 
  EllipsisVerticalIcon,
  Cog6ToothIcon,
  TrashIcon
} from '@heroicons/react/24/outline';
import { BellIcon as BellSolidIcon } from '@heroicons/react/24/solid';

const NotificationCenter = ({ userId, apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001' }) => {
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [preferences, setPreferences] = useState({
    sessionRequests: true,
    bookingConfirmations: true,
    paymentNotifications: true,
    systemMessages: true,
    emailNotifications: true,
    pushNotifications: true,
    soundEnabled: true
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const socketRef = useRef(null);
  const dropdownRef = useRef(null);
  const audioRef = useRef(null);

  // Initialize Socket.io connection
  useEffect(() => {
    if (!userId) return;

    socketRef.current = io(apiUrl, {
      auth: {
        userId: userId
      },
      transports: ['websocket', 'polling']
    });

    const socket = socketRef.current;

    // Listen for new notifications
    socket.on('notification', (notification) => {
      setNotifications(prev => [
        {
          ...notification,
          id: notification.id || Date.now(),
          timestamp: notification.timestamp || new Date().toISOString(),
          read: false
        },
        ...prev
      ]);
      
      setUnreadCount(prev => prev + 1);
      
      // Play notification sound if enabled
      if (preferences.soundEnabled && audioRef.current) {
        audioRef.current.play().catch(console.error);
      }
    });

    // Listen for notification updates
    socket.on('notificationUpdate', (updatedNotification) => {
      setNotifications(prev => 
        prev.map(notif => 
          notif.id === updatedNotification.id ? updatedNotification : notif
        )
      );
    });

    // Listen for bulk notification updates
    socket.on('notificationsMarkedRead', (notificationIds) => {
      setNotifications(prev => 
        prev.map(notif => 
          notificationIds.includes(notif.id) ? { ...notif, read: true } : notif
        )
      );
      setUnreadCount(prev => Math.max(0, prev - notificationIds.length));
    });

    // Handle connection errors
    socket.on('connect_error', (error) => {
      setError('Failed to connect to notification service');
      console.error('Socket connection error:', error);
    });

    socket.on('connect', () => {
      setError(null);
      // Request initial notifications
      socket.emit('getNotifications', { limit: 50 });
    });

    // Handle initial notifications load
    socket.on('initialNotifications', (data) => {
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    });

    return () => {
      socket.disconnect();
    };
  }, [userId, apiUrl, preferences.soundEnabled]);

  // Load user preferences
  useEffect(() => {
    if (!userId) return;

    const loadPreferences = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/users/${userId}/notification-preferences`, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        });
        
        if (response.ok) {
          const prefs = await response.json();
          setPreferences(prev => ({ ...prev, ...prefs }));
        }
      } catch (error) {
        console.error('Failed to load notification preferences:', error);
      }
    };

    loadPreferences();
  }, [userId, apiUrl]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        setIsSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const markAsRead = async (notificationId) => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        setNotifications(prev => 
          prev.map(notif => 
            notif.id === notificationId ? { ...notif, read: true } : notif
          )
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${apiUrl}/api/notifications/mark-all-read`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        setNotifications(prev => 
          prev.map(notif => ({ ...notif, read: true }))
        );
        setUnreadCount(0);
      }
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteNotification = async (notificationId) => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/${notificationId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        setNotifications(prev => prev.filter(notif => notif.id !== notificationId));
        const notification = notifications.find(n => n.id === notificationId);
        if (notification && !notification.read) {
          setUnreadCount(prev => Math.max(0, prev - 1));
        }
      }
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  const clearAllNotifications = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${apiUrl}/api/notifications/clear-all`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        setNotifications([]);
        setUnreadCount(0);
      }
    } catch (error) {
      console.error('Failed to clear all notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  const updatePreferences = async (newPreferences) => {
    try {
      const response = await fetch(`${apiUrl}/api/users/${userId}/notification-preferences`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newPreferences)
      });

      if (response.ok) {
        setPreferences(newPreferences);
      }
    } catch (error) {
      console.error('Failed to update notification preferences:', error);
    }
  };

  const handleNotificationAction = async (notificationId, action, data = {}) => {
    try {
      const response = await fetch(`${apiUrl}/api/notifications/${notificationId}/action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, ...data })
      });

      if (response.ok) {
        // Mark notification as read after action
        markAsRead(notificationId);
      }
    } catch (error) {
      console.error('Failed to handle notification action:', error);
    }
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'session_request':
        return '📞';
      case 'booking_confirmation':
        return '📅';
      case 'payment':
        return '💳';
      case 'system':
        return '⚙️';
      default:
        return '🔔';
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMinutes = Math.floor((now - date) / (1000 * 60));

    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const renderNotificationActions = (notification) => {
    if (!notification.actions || notification.actions.length === 0) return null;

    return (
      <div className="mt-2 flex gap-2">
        {notification.actions.map((action, index) => (
          <button
            key={index}
            onClick={() => handleNotificationAction(notification.id, action.type, action.data)}
            className={`px-3 py-1 text-xs rounded-md font-medium ${
              action.type === 'accept' 
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : action.type === 'decline'
                ? 'bg-red-100 text-red-700 hover:bg-red-200'
                : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-4 border-t border-gray-200">
      <h3 className="font-semibold text-gray-900 mb-3">Notification Preferences</h3>
      <div className="space-y-3">
        {Object.entries(preferences).map(([key, value]) => (
          <label key={key} className="flex items-center justify-between">
            <span className="text-sm text-gray-700 capitalize">
              {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
            </span>
            <input
              type="checkbox"
              checked={value}
              onChange={(e) => {
                const newPreferences = { ...preferences, [key]: e.target.checked };
                setPreferences(newPreferences);
                updatePreferences(newPreferences);
              }}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Notification sound */}
      <audio ref={audioRef} preload="auto">
        <source src="/notification-sound.mp3" type="audio/mpeg" />
      </audio>

      {/* Notification Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded-md"
        aria-label="Notifications"
      >
        {unreadCount > 0 ? (
          <BellSolidIcon className="h-6 w-6 text-blue-600" />
        ) : (
          <BellIcon className="h-6 w-6" />
        )}
        
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-medium">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Notification Dropdown */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-lg border border-gray-200 z-50 max-h-96 overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Notifications</h2>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  disabled={loading}
                  className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
              >
                <Cog6ToothIcon className="h-5 w-5" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 border-b border-red-200">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Settings Panel */}
          {isSettingsOpen && renderSettings()}

          {/* Notifications List */}
          <div className="max-h-64 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <BellIcon className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                <p>No notifications yet</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={`p-4 hover:bg-gray-50 transition-colors ${
                      !notification.read ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-lg flex-shrink-0 mt-0.5">
                        {getNotificationIcon(notification.type)}
                      </span>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-900">
                              {notification.title}
                            </p>
                            <p className="text-sm text-gray-600 mt-1">
                              {notification.message}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {formatTimestamp(notification.timestamp)}
                            </p>
                          </div>
                          
                          <div className="flex items-center gap-1 ml-2">
                            {!notification.read && (
                              <button
                                onClick={() => markAsRead(notification.id)}
                                className="p-1 text-blue-600 hover:text-blue-800 rounded"
                                title="Mark as read"
                              >
                                <CheckIcon className="h-4 w-4" />
                              </button>
                            )}
                            <button
                              onClick={() => deleteNotification(notification.id)}
                              className="p-1 text-gray-400 hover:text-red-600 rounded"
                              title="Delete notification"
                            >
                              <TrashIcon className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        
                        {renderNotificationActions(notification)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="p-3 border-t border-gray-200 bg-gray-50">
              <button
                onClick={clearAllNotifications}
                disabled={loading}
                className="w-full text-sm text-gray-600 hover:text-gray-800 disabled:opacity-50"
              >
                Clear all notifications
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;